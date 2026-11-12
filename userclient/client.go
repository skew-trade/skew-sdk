// Package userclient is the Go client of a user's held orders on the Skew RFQ's public edge,
// rfq.v1.RFQService (proto/rfq/v1/rfq.proto and held.proto): what
// an app's backend, a bot or a tool runs for a user who trades with a limit order Skew matches and
// relays to Hyperliquid.
//
//	c, err := userclient.Dial(ctx, userclient.Options{Target: "rfq.skew.trade:443", TokenSource: session})
//	terms, err := c.Terms(ctx, book)                       // the assets, tick, lives, the deadline's bounds, the server's clock
//	o, err := userclient.Sign(agent, draft, terms)          // heldsign: the Gtc order and its cancelByCloid, as the edge takes it
//	res, err := c.Place(ctx, &rfqv1.PlaceUserHeldOrderRequest{Order: o, DeadlineMs: deadline})
//	err = c.Watch(ctx, userclient.WatchOptions{From: saved}, func(u *rfqv1.UserHeldOrderUpdate, cursor uint64) error { ... })
//	cancel, err := userclient.SignCancel(agent, res.GetOrder(), nonce, expiresAfter, terms)
//	_, err = c.Cancel(ctx, &rfqv1.CancelUserHeldOrderRequest{OrderId: res.GetOrder().GetOrderId(), Cancel: cancel})
//
// LAYERS. It stands on the generated wire types (gen/rfq/v1), the call plumbing every Go client
// of the edge shares (transport) and the signing (heldsign), and on nothing of the
// server's. It holds no Hyperliquid key and sends nothing to Hyperliquid: the caller's Signer (the
// user's agent wallet) signs.
//
// What the client does for you:
//
//   - AUTH. The user's session JWT travels as `authorization: Bearer <jwt>` on every call, unary and
//     stream, from Token or a TokenSource asked on each call; over TLS unless Insecure. A call the
//     edge answers UNAUTHENTICATED tells the TokenSource (Invalidate) and is sent once more with
//     a fresh token; a second refusal is final. With a plain Token nothing is retried.
//   - RETRIES, by method (retry.go says which, and why each is safe). Every call is repeated after
//     the edge's own RESOURCE_EXHAUSTED (RATE_LIMITED, TOO_MANY_STREAMS), after the wait it asked
//     for: the edge refuses those before it reads the request. After UNAVAILABLE or an attempt's
//     timeout, where the first attempt may have run, only the calls a repeat cannot change are
//     repeated: the reads, and Place, which the edge keys by the order id (the same signed bytes
//     placed again answer the order as it stands). Cancel is NEVER repeated then: read the order
//     (Get) and ask again with a freshly signed cancel. Retries stop at the attempts,
//     MaxRetryWait, or the context's deadline.
//   - THE FEED. Watch follows WatchUserHeldOrders across broken streams, server restarts and
//     silence, resuming from the last cursor it saw, so fn sees each change once, in order.
package userclient

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"sync"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
	"github.com/skew-trade/skew-sdk/transport"
)

// The defaults of Options.
const (
	DefaultMaxAttempts    = 4
	DefaultMaxRetryWait   = 10 * time.Second
	DefaultAttemptTimeout = 10 * time.Second
)

// TokenSource supplies the user's session JWT and is told when the edge refuses it.
type TokenSource interface {
	// Token returns the token to send now.
	Token(ctx context.Context) (string, error)
	// Invalidate says the edge refused the token Token last returned: the next Token must fetch or
	// mint a fresh one.
	Invalidate()
}

// RefreshingToken is a TokenSource that calls fetch for a token and its expiry, reuses it until
// `early` before it expires, and fetches again after Invalidate.
func RefreshingToken(fetch func(ctx context.Context) (token string, expires time.Time, err error), early time.Duration) TokenSource {
	return &refreshing{fetch: fetch, early: early}
}

type refreshing struct {
	fetch func(ctx context.Context) (string, time.Time, error)
	early time.Duration

	mu      sync.Mutex
	token   string
	expires time.Time
}

func (r *refreshing) Token(ctx context.Context) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.token != "" && time.Now().Add(r.early).Before(r.expires) {
		return r.token, nil
	}
	t, exp, err := r.fetch(ctx)
	if err != nil {
		return "", err
	}
	r.token, r.expires = t, exp
	return t, nil
}

func (r *refreshing) Invalidate() {
	r.mu.Lock()
	r.token = ""
	r.mu.Unlock()
}

// Options configures a connection.
type Options struct {
	// Target is host:port of the edge's gRPC listener.
	Target string
	// Token returns the session JWT for each call. TokenSource, when set, is used instead and is
	// told when the edge refuses a token, so that a refused call is sent once more with a fresh one.
	// An error from either fails the call as UNAUTHENTICATED.
	Token       func(ctx context.Context) (string, error)
	TokenSource TokenSource
	// Insecure dials plaintext, for a listener inside the caller's own network or a test. The token
	// then travels in the clear. TLS overrides the TLS configuration (default: system roots, TLS 1.2
	// or later).
	Insecure bool
	TLS      *tls.Config
	// MaxAttempts is the most attempts one call makes, the first included (DefaultMaxAttempts; 1
	// turns retries off). A refused token's one fresh attempt comes on top.
	MaxAttempts int
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

// Client is a user's connection to the edge. It is safe for concurrent use.
type Client struct {
	conn  *grpc.ClientConn
	rfq   rfqv1.RFQServiceClient
	opts  Options
	token func(ctx context.Context) (string, error)
	// refresh is the TokenSource, when the caller gave one: only a source that can fetch a new token
	// makes a retry after UNAUTHENTICATED worth sending.
	refresh TokenSource
}

// bearer is the per-call credential: the session JWT, over TLS only unless the caller said otherwise.
type bearer struct {
	token  func(ctx context.Context) (string, error)
	secure bool
}

func (b bearer) GetRequestMetadata(ctx context.Context, _ ...string) (map[string]string, error) {
	t, err := b.token(ctx)
	if err != nil {
		return nil, status.Errorf(codes.Unauthenticated, "userclient: the session token: %v", err)
	}
	if t == "" {
		return nil, status.Error(codes.Unauthenticated, "userclient: no session token")
	}
	return map[string]string{"authorization": "Bearer " + t}, nil
}

func (b bearer) RequireTransportSecurity() bool { return b.secure }

// Dial connects. It does not block: the first call establishes the connection.
func Dial(_ context.Context, o Options) (*Client, error) {
	if o.Target == "" {
		return nil, errors.New("userclient: no target")
	}
	c := &Client{refresh: o.TokenSource}
	switch {
	case o.TokenSource != nil:
		c.token = o.TokenSource.Token
	case o.Token != nil:
		c.token = o.Token
	default:
		return nil, errors.New("userclient: no session token (Token or TokenSource)")
	}
	if o.MaxAttempts < 1 {
		o.MaxAttempts = DefaultMaxAttempts
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
	c.opts = o
	dial := []grpc.DialOption{
		transport.Security(o.Insecure, o.TLS),
		grpc.WithPerRPCCredentials(bearer{token: c.token, secure: !o.Insecure}),
		// The retries are the client's: it knows which calls are safe to repeat and what the edge's
		// errors mean. gRPC's own would multiply them.
		grpc.WithDisableRetry(),
		grpc.WithChainUnaryInterceptor(c.metadataUnary()),
		grpc.WithChainStreamInterceptor(c.metadataStream()),
		transport.Keepalive(),
	}
	conn, err := grpc.NewClient(o.Target, append(dial, o.DialOptions...)...)
	if err != nil {
		return nil, fmt.Errorf("userclient: dial %s: %w", o.Target, err)
	}
	c.conn, c.rfq = conn, rfqv1.NewRFQServiceClient(conn)
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

// Terms is GetUserHeldTerms: what the app signs to for one book (the two assets, the tick, the
// minimum value, the chain the signatures are checked for, the time in force, the bounds of
// place.expiresAfter, of the deadline and of the cancel, the caps and the server's clock).
func (c *Client) Terms(ctx context.Context, book uint32) (*rfqv1.GetUserHeldTermsResponse, error) {
	var out *rfqv1.GetUserHeldTermsResponse
	_, err := c.unary(ctx, rfqv1.RFQService_GetUserHeldTerms_FullMethodName, func(ctx context.Context) (err error) {
		out, err = c.rfq.GetUserHeldTerms(ctx, &rfqv1.GetUserHeldTermsRequest{Book: book})
		return err
	})
	return out, err
}

// PlaceResult is a place's answer: the order as recorded, or the edge's refusal of it.
type PlaceResult struct {
	*rfqv1.PlaceUserHeldOrderResponse
	// Attempts is how many times the order was sent. Above 1, an earlier attempt's answer was lost
	// or refused before any work; the order id is the same either way.
	Attempts int
}

// Place is PlaceUserHeldOrder: the user's held order (`place` a Gtc limit order, `clear` its
// cancelByCloid) and its deadline. A well-formed order the edge declines is not an error: read
// Refusal (a stable code and a sentence). The same signed bytes placed again answer the order as
// it stands, which is what makes Place safe to repeat after UNAVAILABLE.
func (c *Client) Place(ctx context.Context, req *rfqv1.PlaceUserHeldOrderRequest) (*PlaceResult, error) {
	if req.GetOrder() == nil || req.GetOrder().GetPlace() == nil || req.GetOrder().GetClear() == nil {
		return nil, status.Error(codes.InvalidArgument, "userclient: a held order needs its signed place and clear")
	}
	var out *rfqv1.PlaceUserHeldOrderResponse
	n, err := c.unary(ctx, rfqv1.RFQService_PlaceUserHeldOrder_FullMethodName, func(ctx context.Context) (err error) {
		out, err = c.rfq.PlaceUserHeldOrder(ctx, req)
		return err
	})
	if err != nil {
		return nil, err
	}
	return &PlaceResult{PlaceUserHeldOrderResponse: out, Attempts: n}, nil
}

// Cancel is CancelUserHeldOrder: the user's cancel now instead of at the deadline. req.Cancel is a
// cancelByCloid of the order's asset and cloid signed NOW (SignCancel); without it only an order
// nothing was sent for is cancelled (CANCEL_NOT_SIGNED otherwise). A declined cancel is not an
// error: read Refusal, sign again and ask again.
//
// A Cancel that fails UNAVAILABLE, or times out, is NOT repeated: it may have reached the edge.
// Read the order (Get) to see where it stands; a cancel asked twice answers the order as it stands.
func (c *Client) Cancel(ctx context.Context, req *rfqv1.CancelUserHeldOrderRequest) (*rfqv1.CancelUserHeldOrderResponse, error) {
	if req.GetOrderId() == "" {
		return nil, status.Error(codes.InvalidArgument, "userclient: name the order to cancel")
	}
	var out *rfqv1.CancelUserHeldOrderResponse
	_, err := c.unary(ctx, rfqv1.RFQService_CancelUserHeldOrder_FullMethodName, func(ctx context.Context) (err error) {
		out, err = c.rfq.CancelUserHeldOrder(ctx, req)
		return err
	})
	return out, err
}

// Get is GetUserHeldOrder: one of the user's held orders by its id (0x + 32 hex). Another user's
// is NOT_FOUND.
func (c *Client) Get(ctx context.Context, orderID string) (*rfqv1.UserHeldOrderView, error) {
	var out *rfqv1.GetUserHeldOrderResponse
	_, err := c.unary(ctx, rfqv1.RFQService_GetUserHeldOrder_FullMethodName, func(ctx context.Context) (err error) {
		out, err = c.rfq.GetUserHeldOrder(ctx, &rfqv1.GetUserHeldOrderRequest{OrderId: orderID})
		return err
	})
	return out.GetOrder(), err
}

// List is one page of ListUserHeldOrders: the user's held orders, newest first, by book and state.
// The listing has ended when the page carries no next_page_token.
func (c *Client) List(ctx context.Context, req *rfqv1.ListUserHeldOrdersRequest) (*rfqv1.ListUserHeldOrdersResponse, error) {
	var out *rfqv1.ListUserHeldOrdersResponse
	_, err := c.unary(ctx, rfqv1.RFQService_ListUserHeldOrders_FullMethodName, func(ctx context.Context) (err error) {
		out, err = c.rfq.ListUserHeldOrders(ctx, req)
		return err
	})
	return out, err
}

// maxPages bounds one ListAll walk.
const maxPages = 1000

// ListAll is every page of ListUserHeldOrders for req (its page_token is the walk's start).
func (c *Client) ListAll(ctx context.Context, req *rfqv1.ListUserHeldOrdersRequest) ([]*rfqv1.UserHeldOrderView, error) {
	q := &rfqv1.ListUserHeldOrdersRequest{Book: req.GetBook(), States: req.GetStates(), Limit: req.GetLimit(), PageToken: req.GetPageToken()}
	var out []*rfqv1.UserHeldOrderView
	for range maxPages {
		page, err := c.List(ctx, q)
		if err != nil {
			return nil, err
		}
		out = append(out, page.GetOrders()...)
		if page.GetNextPageToken() == "" {
			return out, nil
		}
		q.PageToken = page.GetNextPageToken()
	}
	return nil, fmt.Errorf("userclient: the listing did not end within %d pages", maxPages)
}
