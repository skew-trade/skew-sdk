// Package makerclient is the Go client of the Skew RFQ's maker edge, rfq.v1.HeldOrderService
// (proto/rfq/v1/held.proto, docs/MAKER-SPEC.md): what a market maker runs to hand Skew
// firm, pre-signed Hyperliquid post-only orders, follow what happens to them, and pull them.
//
//	c, err := makerclient.Dial(ctx, makerclient.Options{Target: "rfq.skew.trade:443", Key: makerKey})
//	rules, err := c.Rules(ctx, book)                // the assets, tick, lives, your limits and seq, the server's clock
//	o, err := makerclient.Sign(signer, draft, rules) // heldsign: the post-only order and its cancelByCloid, as the edge takes it
//	res, err := c.ReplaceBook(ctx, &rfqv1.ReplaceHeldBookOrdersRequest{Book: book, Seq: seq, Orders: []*rfqv1.HeldOrder{o}})
//	err = c.Watch(ctx, makerclient.WatchOptions{From: saved}, func(ev *rfqv1.HeldOrderEvent, at makerclient.Position) error { ... })
//	_, err = c.Withdraw(ctx, book, 0)
//
// LAYERS. It stands on the generated wire types (gen/rfq/v1), the call plumbing every Go client
// of the edge shares (transport) and the signing (heldsign), and on nothing of the
// server's: no package under internal/ is imported directly, so another module vendors it with
// those three. It holds no Hyperliquid key and sends nothing to Hyperliquid: the caller's Signer
// signs.
//
// What the client does for you:
//
//   - AUTH. The maker's API key travels in x-skew-maker-key on every call, unary and stream,
//     from Key or a KeySource asked on each call. Over TLS unless Insecure. A refused key
//     (UNAUTHENTICATED) or a disabled maker (PERMISSION_DENIED) is never retried: a call whose key
//     is no maker's costs the caller's address a token of the edge's bad-key bucket.
//   - RETRIES, by method (retry.go says which, and why each is safe). Every call is repeated after
//     the edge's own RESOURCE_EXHAUSTED (RATE_LIMITED, TOO_MANY_STREAMS), after the wait it asked
//     for, because the edge refuses those before it reads the request. The calls safe to repeat
//     after UNAVAILABLE or an attempt's timeout, where the first attempt may have run, are
//     repeated with backoff; a book update and a withdraw are among them because their seq makes
//     a repeat of one that ran change nothing (ReplaceResult.AppliedEarlier says when that
//     happened). A withdraw gets more attempts than anything else: a maker must always be able
//     to pull its orders. Retries stop at the attempts, MaxRetryWait, or the context's deadline.
//   - THE FEED. Watch follows WatchOrders across broken streams, server restarts and silence,
//     resuming from the cursor AND the epoch it last saw, so fn sees each event once, in order,
//     and is told (a "reset" event) when the pool cannot go on from there.
//
// Other ways to quote join this package as files of their own, on the same connection, key and
// retry policy.
package makerclient

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
	"github.com/skew-trade/skew-sdk/transport"
)

// KeyHeader is the metadata key a maker's API key travels in (X-Skew-Maker-Key over REST).
const KeyHeader = "x-skew-maker-key"

// The defaults of Options.
const (
	DefaultMaxAttempts      = 4
	DefaultWithdrawAttempts = 8
	DefaultMaxRetryWait     = 10 * time.Second
	DefaultAttemptTimeout   = 10 * time.Second
)

// Options configures a connection.
type Options struct {
	// Target is host:port of the maker edge's gRPC listener.
	Target string
	// Key is the maker's API key (skm_...). KeySource, when set, is asked on every call instead: a
	// key kept in a secret store, rotated without a restart. An error from it fails the call as
	// UNAUTHENTICATED, which is not retried.
	Key       string
	KeySource func(ctx context.Context) (string, error)
	// Insecure dials plaintext, for a listener inside the caller's own network or a test. The key
	// then travels in the clear. TLS overrides the TLS configuration (default: system roots, TLS
	// 1.2 or later).
	Insecure bool
	TLS      *tls.Config
	// MaxAttempts is the most attempts one call makes, the first included (DefaultMaxAttempts; 1
	// turns retries off). WithdrawAttempts is a withdraw's (default: the larger of
	// DefaultWithdrawAttempts and MaxAttempts, so that turning retries off leaves a withdraw its own).
	MaxAttempts      int
	WithdrawAttempts int
	// Backoff is the retry schedule (default 100 ms doubling to 2 s, +-20%).
	Backoff transport.Backoff
	// MaxRetryWait caps one wait, a wait the edge asked for included (DefaultMaxRetryWait). An edge
	// that asks for longer ends the retries with its refusal.
	MaxRetryWait time.Duration
	// AttemptTimeout bounds one attempt of a unary call (DefaultAttemptTimeout; negative: none, the
	// context's deadline alone). An attempt that times out counts as one that may have run.
	AttemptTimeout time.Duration
	// Metadata is sent with every call.
	Metadata map[string]string
	// DialOptions are added to the connection's options (after the client's own).
	DialOptions []grpc.DialOption
	// Sleep waits between attempts and reconnects; it returns ctx.Err() if ctx ends first. Nil uses a
	// timer. Tests replace it.
	Sleep func(ctx context.Context, d time.Duration) error
	// OnRetry, when set, is told of every retry of a unary call: the method, the attempt that failed,
	// its error, and the wait before the next.
	OnRetry func(method string, attempt int, err error, wait time.Duration)
}

// Client is a maker's connection to the edge. It is safe for concurrent use.
type Client struct {
	conn *grpc.ClientConn
	held rfqv1.HeldOrderServiceClient
	opts Options
}

// makerKey is the per-call credential: the key, and over TLS only unless the caller said otherwise.
type makerKey struct {
	key    func(ctx context.Context) (string, error)
	secure bool
}

func (k makerKey) GetRequestMetadata(ctx context.Context, _ ...string) (map[string]string, error) {
	key, err := k.key(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Unauthenticated, "makerclient: the maker key: %v", err)
	}
	if key == "" {
		return nil, status.Error(codes.Unauthenticated, "makerclient: no maker key")
	}
	return map[string]string{KeyHeader: key}, nil
}

func (k makerKey) RequireTransportSecurity() bool { return k.secure }

// Dial connects. It does not block: the first call establishes the connection.
func Dial(_ context.Context, o Options) (*Client, error) {
	if o.Target == "" {
		return nil, errors.New("makerclient: no target")
	}
	key := o.KeySource
	if key == nil {
		if strings.TrimSpace(o.Key) == "" {
			return nil, errors.New("makerclient: no maker key (Key or KeySource)")
		}
		k := o.Key
		key = func(context.Context) (string, error) { return k, nil }
	}
	if o.MaxAttempts < 1 {
		o.MaxAttempts = DefaultMaxAttempts
	}
	if o.WithdrawAttempts < 1 {
		o.WithdrawAttempts = max(DefaultWithdrawAttempts, o.MaxAttempts)
	}
	if o.MaxRetryWait <= 0 {
		o.MaxRetryWait = DefaultMaxRetryWait
	}
	if o.AttemptTimeout == 0 {
		o.AttemptTimeout = DefaultAttemptTimeout
	}
	if o.Sleep == nil {
		o.Sleep = transport.Sleep
	}
	if o.Backoff == (transport.Backoff{}) {
		o.Backoff = transport.Backoff{Jitter: 0.2}
	}
	o.Backoff = o.Backoff.Normalized()
	c := &Client{opts: o}
	dial := []grpc.DialOption{
		transport.Security(o.Insecure, o.TLS),
		grpc.WithPerRPCCredentials(makerKey{key: key, secure: !o.Insecure}),
		// The retries are the client's: it knows which calls are safe to repeat and what the edge's
		// errors mean. gRPC's own would multiply them.
		grpc.WithDisableRetry(),
		grpc.WithChainUnaryInterceptor(c.metadataUnary()),
		grpc.WithChainStreamInterceptor(c.metadataStream()),
		transport.Keepalive(),
	}
	conn, err := grpc.NewClient(o.Target, append(dial, o.DialOptions...)...)
	if err != nil {
		return nil, fmt.Errorf("makerclient: dial %s: %w", o.Target, err)
	}
	c.conn, c.held = conn, rfqv1.NewHeldOrderServiceClient(conn)
	return c, nil
}

// Close closes the connection.
func (c *Client) Close() error { return c.conn.Close() }

func (c *Client) outgoing(ctx context.Context) context.Context {
	if len(c.opts.Metadata) == 0 {
		return ctx
	}
	kv := make([]string, 0, 2*len(c.opts.Metadata))
	for k, v := range c.opts.Metadata {
		kv = append(kv, k, v)
	}
	return metadata.AppendToOutgoingContext(ctx, kv...)
}

func (c *Client) metadataUnary() grpc.UnaryClientInterceptor {
	return func(ctx context.Context, method string, req, reply any, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		return invoker(c.outgoing(ctx), method, req, reply, cc, opts...)
	}
}

func (c *Client) metadataStream() grpc.StreamClientInterceptor {
	return func(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn, method string, streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error) {
		return streamer(c.outgoing(ctx), desc, cc, method, opts...)
	}
}

// ---------------------------------------------------------------- the calls

// Rules is GetBookRules: everything needed to build held orders for one book (the two assets, the
// tick, the minimum order value, the network the signatures are checked for, the life limits, your
// limits and accounts, your last applied seq on the book, the server's clock and the pool's epoch).
func (c *Client) Rules(ctx context.Context, book uint32) (*rfqv1.GetHeldBookRulesResponse, error) {
	var out *rfqv1.GetHeldBookRulesResponse
	_, err := c.unary(ctx, rfqv1.HeldOrderService_GetBookRules_FullMethodName, c.opts.MaxAttempts, func(ctx context.Context) (err error) {
		out, err = c.held.GetBookRules(ctx, &rfqv1.GetHeldBookRulesRequest{Book: book})
		return err
	})
	return out, err
}

// ReplaceResult is a book update's answer.
type ReplaceResult struct {
	*rfqv1.ReplaceHeldBookOrdersResponse
	// Attempts is how many times the update was sent.
	Attempts int
	// AppliedEarlier: an earlier attempt's answer was lost and this one found the book's last
	// applied seq to be the update's own (STALE_SEQ, seq equal): the update WAS applied, by that
	// attempt. This answer carries none of its verdicts; LiveOrders shows what stands.
	AppliedEarlier bool
}

// ReplaceBook is ReplaceBookOrders: it replaces ALL of your held orders on req.Book with
// req.Orders, under req.Seq, which must be greater than the book's last applied seq. A well-formed
// update the pool declines is not an error: read Applied, Code and each order's verdict.
func (c *Client) ReplaceBook(ctx context.Context, req *rfqv1.ReplaceHeldBookOrdersRequest) (*ReplaceResult, error) {
	if req == nil || req.GetBook() == 0 || req.GetSeq() == 0 {
		return nil, status.Error(codes.InvalidArgument, "makerclient: a book update needs its book and a seq above 0")
	}
	var out *rfqv1.ReplaceHeldBookOrdersResponse
	n, err := c.unary(ctx, rfqv1.HeldOrderService_ReplaceBookOrders_FullMethodName, c.opts.MaxAttempts, func(ctx context.Context) (err error) {
		out, err = c.held.ReplaceBookOrders(ctx, req)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &ReplaceResult{ReplaceHeldBookOrdersResponse: out, Attempts: n, AppliedEarlier: appliedEarlier(n, out.GetApplied(), out.GetCode(), req.GetSeq(), out.GetSeq())}, nil
}

// WithdrawResult is a withdraw's answer.
type WithdrawResult struct {
	*rfqv1.WithdrawHeldBookResponse
	Attempts int
	// AppliedEarlier: as ReplaceResult's, for a withdraw under a seq of its own.
	AppliedEarlier bool
}

// Withdraw is WithdrawBook of one book: every live held order of yours on it is withdrawn. seq 0
// takes the book's next seq; a set seq must be greater than the last applied one. Pass one when
// something else may update the book meanwhile: a repeat after a lost answer is then refused
// STALE_SEQ instead of withdrawing what came after. Orders already claimed for sending run to their
// end within seconds.
func (c *Client) Withdraw(ctx context.Context, book uint32, seq uint64) (*WithdrawResult, error) {
	if book == 0 {
		return nil, status.Error(codes.InvalidArgument, "makerclient: name the book to withdraw (WithdrawAll withdraws every book)")
	}
	return c.withdraw(ctx, &rfqv1.WithdrawHeldBookRequest{Book: book, Seq: seq})
}

// WithdrawAll withdraws every live held order of yours, on every book.
func (c *Client) WithdrawAll(ctx context.Context) (*WithdrawResult, error) {
	return c.withdraw(ctx, &rfqv1.WithdrawHeldBookRequest{AllBooks: true})
}

func (c *Client) withdraw(ctx context.Context, req *rfqv1.WithdrawHeldBookRequest) (*WithdrawResult, error) {
	var out *rfqv1.WithdrawHeldBookResponse
	n, err := c.unary(ctx, rfqv1.HeldOrderService_WithdrawBook_FullMethodName, c.opts.WithdrawAttempts, func(ctx context.Context) (err error) {
		out, err = c.held.WithdrawBook(ctx, req)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &WithdrawResult{WithdrawHeldBookResponse: out, Attempts: n,
		AppliedEarlier: appliedEarlier(n, out.GetApplied(), out.GetCode(), req.GetSeq(), out.GetSeq())}, nil
}

// codeStaleSeq is the pool's answer to a seq that is not greater than the book's last applied one.
const codeStaleSeq = "STALE_SEQ"

func appliedEarlier(attempts int, applied bool, code string, sent, last uint64) bool {
	return attempts > 1 && !applied && code == codeStaleSeq && sent != 0 && last == sent
}

// ListOrders is one page of your held orders, newest first, by book and state. A page may hold
// fewer than the limit, even none, and still carry a next_page_token: the listing has ended when
// there is none.
func (c *Client) ListOrders(ctx context.Context, req *rfqv1.ListHeldOrdersRequest) (*rfqv1.ListHeldOrdersResponse, error) {
	var out *rfqv1.ListHeldOrdersResponse
	_, err := c.unary(ctx, rfqv1.HeldOrderService_ListOrders_FullMethodName, c.opts.MaxAttempts, func(ctx context.Context) (err error) {
		out, err = c.held.ListOrders(ctx, req)
		return err
	})
	return out, err
}

// maxPages bounds one LiveOrders walk.
const maxPages = 1000

// LiveOrders is every LIVE held order of yours on book (0: every book), every page of it: what a
// feed reset of EVENTS_MISSED asks you to read.
func (c *Client) LiveOrders(ctx context.Context, book uint32) ([]*rfqv1.HeldOrderView, error) {
	req := &rfqv1.ListHeldOrdersRequest{Book: book, States: []rfqv1.HeldOrderState{rfqv1.HeldOrderState_HELD_ORDER_STATE_LIVE}, Limit: 500}
	var out []*rfqv1.HeldOrderView
	for range maxPages {
		page, err := c.ListOrders(ctx, req)
		if err != nil {
			return nil, err
		}
		out = append(out, page.GetOrders()...)
		if page.GetNextPageToken() == "" {
			return out, nil
		}
		req.PageToken = page.GetNextPageToken()
	}
	return nil, fmt.Errorf("makerclient: the listing did not end within %d pages", maxPages)
}

// GetOrder is one of your held orders by its id (0x + 32 hex). Another maker's is NOT_FOUND.
func (c *Client) GetOrder(ctx context.Context, orderID string) (*rfqv1.HeldOrderView, error) {
	var out *rfqv1.GetHeldOrderResponse
	_, err := c.unary(ctx, rfqv1.HeldOrderService_GetOrder_FullMethodName, c.opts.MaxAttempts, func(ctx context.Context) (err error) {
		out, err = c.held.GetOrder(ctx, &rfqv1.GetHeldOrderRequest{OrderId: orderID})
		return err
	})
	return out.GetOrder(), err
}
