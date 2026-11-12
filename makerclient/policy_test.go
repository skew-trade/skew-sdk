package makerclient

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
)

// script is a scripted HeldOrderService: each test says how it answers, and what it saw.
type script struct {
	rfqv1.UnimplementedHeldOrderServiceServer

	mu     sync.Mutex
	calls  map[string]int
	keys   []string
	answer func(method string, n int) error
}

func (s *script) seen(ctx context.Context, method string) error {
	s.mu.Lock()
	if s.calls == nil {
		s.calls = map[string]int{}
	}
	s.calls[method]++
	n := s.calls[method]
	md, _ := metadata.FromIncomingContext(ctx)
	s.keys = append(s.keys, md.Get(KeyHeader)...)
	s.mu.Unlock()
	return s.answer(method, n)
}

func (s *script) Calls(method string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[method]
}

func (s *script) GetBookRules(ctx context.Context, _ *rfqv1.GetHeldBookRulesRequest) (*rfqv1.GetHeldBookRulesResponse, error) {
	if err := s.seen(ctx, "GetBookRules"); err != nil {
		return nil, err
	}
	return &rfqv1.GetHeldBookRulesResponse{Book: 7}, nil
}

func (s *script) ReplaceBookOrders(ctx context.Context, req *rfqv1.ReplaceHeldBookOrdersRequest) (*rfqv1.ReplaceHeldBookOrdersResponse, error) {
	if err := s.seen(ctx, "ReplaceBookOrders"); err != nil {
		return nil, err
	}
	return &rfqv1.ReplaceHeldBookOrdersResponse{Applied: true, Book: req.GetBook(), Seq: req.GetSeq()}, nil
}

func (s *script) WithdrawBook(ctx context.Context, req *rfqv1.WithdrawHeldBookRequest) (*rfqv1.WithdrawHeldBookResponse, error) {
	if err := s.seen(ctx, "WithdrawBook"); err != nil {
		return nil, err
	}
	return &rfqv1.WithdrawHeldBookResponse{Applied: true, Seq: req.GetSeq()}, nil
}

func (s *script) GetOrder(ctx context.Context, _ *rfqv1.GetHeldOrderRequest) (*rfqv1.GetHeldOrderResponse, error) {
	if err := s.seen(ctx, "GetOrder"); err != nil {
		return nil, err
	}
	return &rfqv1.GetHeldOrderResponse{Order: &rfqv1.HeldOrderView{OrderId: "0x01"}}, nil
}

func serve(t *testing.T, s *script) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gs := grpc.NewServer()
	rfqv1.RegisterHeldOrderServiceServer(gs, s)
	go func() { _ = gs.Serve(lis) }()
	t.Cleanup(gs.Stop)
	return lis.Addr().String()
}

// dial connects with no real waits: the waits asked for are recorded instead.
func dial(t *testing.T, addr string, o Options) (*Client, *[]time.Duration) {
	t.Helper()
	var mu sync.Mutex
	var waits []time.Duration
	o.Target, o.Insecure = addr, true
	if o.Key == "" && o.KeySource == nil {
		o.Key = "skm_test"
	}
	o.Sleep = func(ctx context.Context, d time.Duration) error {
		mu.Lock()
		waits = append(waits, d)
		mu.Unlock()
		return ctx.Err()
	}
	c, err := Dial(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c, &waits
}

func TestTheKeyIsSentAndNeverRetriedWhenRefused(t *testing.T) {
	s := &script{answer: func(string, int) error {
		return status.Error(codes.Unauthenticated, "[UNAUTHENTICATED] authentication required")
	}}
	c, waits := dial(t, serve(t, s), Options{Key: "skm_one"})
	if _, err := c.Rules(context.Background(), 7); status.Code(err) != codes.Unauthenticated {
		t.Fatal(err)
	}
	if s.Calls("GetBookRules") != 1 || len(*waits) != 0 || len(s.keys) != 1 || s.keys[0] != "skm_one" {
		t.Fatalf("calls %d waits %v keys %v", s.Calls("GetBookRules"), *waits, s.keys)
	}

	// A key source that fails fails the call as UNAUTHENTICATED, which is not retried either: no
	// call reaches the edge.
	s2 := &script{answer: func(string, int) error { return nil }}
	c2, _ := dial(t, serve(t, s2), Options{KeySource: func(context.Context) (string, error) { return "", errors.New("the vault is sealed") }})
	if _, err := c2.Rules(context.Background(), 7); status.Code(err) != codes.Unauthenticated || s2.Calls("GetBookRules") != 0 {
		t.Fatalf("%v, %d calls", err, s2.Calls("GetBookRules"))
	}
	if _, err := Dial(context.Background(), Options{Target: "127.0.0.1:1", Insecure: true}); err == nil {
		t.Fatal("dialled with no key")
	}
}

func TestWhatIsRepeatedAndWhatIsNot(t *testing.T) {
	type tc struct {
		name    string
		err     error
		repeats bool
	}
	for _, c := range []tc{
		{"the edge's rate limit, its wait in the message (a refusal at the door)", status.Error(codes.ResourceExhausted, "[RATE_LIMITED] too many requests (held-write); retry in 40 ms"), true},
		{"a stream cap", status.Error(codes.ResourceExhausted, "[TOO_MANY_STREAMS] close one first"), true},
		{"gRPC's own RESOURCE_EXHAUSTED: a message too large", status.Error(codes.ResourceExhausted, "grpc: received message larger than max"), false},
		{"the edge asks for longer than MaxRetryWait", status.Error(codes.ResourceExhausted, "[RATE_LIMITED] retry in 60000 ms"), false},
		{"UNAVAILABLE", status.Error(codes.Unavailable, "[UNAVAILABLE] the held pool is unavailable; retry shortly"), true},
		{"a disabled maker", status.Error(codes.PermissionDenied, "[FORBIDDEN] not allowed"), false},
		{"a request constraint", status.Error(codes.InvalidArgument, "[INVALID_ARGUMENT] seq"), false},
		{"a bug", status.Error(codes.Internal, "[INTERNAL] internal error"), false},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := &script{answer: func(_ string, n int) error {
				if n == 1 {
					return c.err
				}
				return nil
			}}
			cl, waits := dial(t, serve(t, s), Options{})
			res, err := cl.ReplaceBook(context.Background(), &rfqv1.ReplaceHeldBookOrdersRequest{Book: 7, Seq: 3})
			if c.repeats {
				if err != nil || res.Attempts != 2 || s.Calls("ReplaceBookOrders") != 2 || len(*waits) != 1 {
					t.Fatalf("%v %v calls %d waits %v", res, err, s.Calls("ReplaceBookOrders"), *waits)
				}
				return
			}
			if status.Code(err) != status.Code(c.err) || s.Calls("ReplaceBookOrders") != 1 || len(*waits) != 0 {
				t.Fatalf("%v calls %d waits %v", err, s.Calls("ReplaceBookOrders"), *waits)
			}
		})
	}

	// The wait the edge asked for at the door is honoured, though it came in the message alone.
	s := &script{answer: func(_ string, n int) error {
		if n == 1 {
			return status.Error(codes.ResourceExhausted, "[RATE_LIMITED] too many requests (held-read); retry in 900 ms")
		}
		return nil
	}}
	c, waits := dial(t, serve(t, s), Options{})
	if _, err := c.Rules(context.Background(), 7); err != nil || len(*waits) != 1 || (*waits)[0] < 900*time.Millisecond {
		t.Fatalf("%v waits %v", err, *waits)
	}
}

// A withdraw gets more attempts than anything else; a method the policy does not name is never
// repeated after UNAVAILABLE.
func TestAWithdrawOutlastsAnOutage(t *testing.T) {
	down := func(string, int) error { return status.Error(codes.Unavailable, "connection refused") }
	s := &script{answer: down}
	c, _ := dial(t, serve(t, s), Options{})
	if _, err := c.ReplaceBook(context.Background(), &rfqv1.ReplaceHeldBookOrdersRequest{Book: 7, Seq: 1}); status.Code(err) != codes.Unavailable {
		t.Fatal(err)
	}
	if _, err := c.Withdraw(context.Background(), 7, 0); status.Code(err) != codes.Unavailable {
		t.Fatal(err)
	}
	if s.Calls("ReplaceBookOrders") != DefaultMaxAttempts || s.Calls("WithdrawBook") != DefaultWithdrawAttempts {
		t.Fatalf("replace %d, withdraw %d attempts", s.Calls("ReplaceBookOrders"), s.Calls("WithdrawBook"))
	}

	n := 0
	_, err := c.unary(context.Background(), "/rfq.v1.HeldOrderService/SomethingNew", 4, func(context.Context) error {
		n++
		return status.Error(codes.Unavailable, "down")
	})
	if status.Code(err) != codes.Unavailable || n != 1 {
		t.Fatalf("an unclassified method was attempted %d times", n)
	}
	for _, m := range []string{rfqv1.HeldOrderService_GetBookRules_FullMethodName, rfqv1.HeldOrderService_ReplaceBookOrders_FullMethodName,
		rfqv1.HeldOrderService_WithdrawBook_FullMethodName, rfqv1.HeldOrderService_ListOrders_FullMethodName, rfqv1.HeldOrderService_GetOrder_FullMethodName} {
		if why, ok := RepeatableAfterUnavailable(m); !ok || why == "" {
			t.Errorf("%s is not classified", m)
		}
	}
	if _, ok := RepeatableAfterUnavailable(rfqv1.HeldOrderService_WatchOrders_FullMethodName); ok {
		t.Error("the stream is resumed by its position, not repeated")
	}
}

// A retry never sleeps past the caller's deadline, and a timed-out attempt counts as one that may
// have run.
func TestDeadlinesAndAttemptTimeouts(t *testing.T) {
	s := &script{answer: func(string, int) error {
		return status.Error(codes.ResourceExhausted, "[RATE_LIMITED] retry in 5000 ms")
	}}
	c, waits := dial(t, serve(t, s), Options{})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := c.Rules(ctx, 7); status.Code(err) != codes.ResourceExhausted || len(*waits) != 0 || s.Calls("GetBookRules") != 1 {
		t.Fatalf("%v waits %v", err, *waits)
	}

	slow := &script{answer: func(_ string, n int) error {
		if n == 1 {
			time.Sleep(300 * time.Millisecond)
		}
		return nil
	}}
	c2, waits2 := dial(t, serve(t, slow), Options{AttemptTimeout: 50 * time.Millisecond})
	if o, err := c2.GetOrder(context.Background(), "0x01"); err != nil || o.GetOrderId() != "0x01" || len(*waits2) != 1 {
		t.Fatalf("%v %v waits %v", o, err, *waits2)
	}
}

func TestAppliedEarlier(t *testing.T) {
	for _, c := range []struct {
		attempts       int
		applied        bool
		code           string
		sent, last     uint64
		appliedEarlier bool
	}{
		{2, false, "STALE_SEQ", 9, 9, true},
		{1, false, "STALE_SEQ", 9, 9, false},  // the first answer: the caller sent a seq already used
		{2, false, "STALE_SEQ", 9, 12, false}, // a later update came first: this one was not applied
		{2, true, "", 9, 9, false},
		{2, false, "STALE_SEQ", 0, 0, false},
	} {
		if got := appliedEarlier(c.attempts, c.applied, c.code, c.sent, c.last); got != c.appliedEarlier {
			t.Errorf("%+v: %v", c, got)
		}
	}
}
