package userclient

import (
	"context"
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

// script is a scripted RFQService: each test says how it answers, and what it saw.
type script struct {
	rfqv1.UnimplementedRFQServiceServer

	mu     sync.Mutex
	calls  map[string]int
	auth   []string
	answer func(method string, n int) error
	delay  func(method string, n int) time.Duration
}

func (s *script) seen(ctx context.Context, method string) error {
	s.mu.Lock()
	if s.calls == nil {
		s.calls = map[string]int{}
	}
	s.calls[method]++
	n := s.calls[method]
	md, _ := metadata.FromIncomingContext(ctx)
	s.auth = append(s.auth, md.Get("authorization")...)
	s.mu.Unlock()
	if s.delay != nil {
		if d := s.delay(method, n); d > 0 {
			select {
			case <-time.After(d):
			case <-ctx.Done():
			}
		}
	}
	if s.answer == nil {
		return nil
	}
	return s.answer(method, n)
}

func (s *script) Calls(method string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls[method]
}

func (s *script) GetUserHeldTerms(ctx context.Context, req *rfqv1.GetUserHeldTermsRequest) (*rfqv1.GetUserHeldTermsResponse, error) {
	if err := s.seen(ctx, "GetUserHeldTerms"); err != nil {
		return nil, err
	}
	return &rfqv1.GetUserHeldTermsResponse{Book: req.GetBook()}, nil
}

func (s *script) PlaceUserHeldOrder(ctx context.Context, _ *rfqv1.PlaceUserHeldOrderRequest) (*rfqv1.PlaceUserHeldOrderResponse, error) {
	if err := s.seen(ctx, "PlaceUserHeldOrder"); err != nil {
		return nil, err
	}
	return &rfqv1.PlaceUserHeldOrderResponse{Order: &rfqv1.UserHeldOrderView{OrderId: "0x01"}}, nil
}

func (s *script) CancelUserHeldOrder(ctx context.Context, req *rfqv1.CancelUserHeldOrderRequest) (*rfqv1.CancelUserHeldOrderResponse, error) {
	if err := s.seen(ctx, "CancelUserHeldOrder"); err != nil {
		return nil, err
	}
	return &rfqv1.CancelUserHeldOrderResponse{Order: &rfqv1.UserHeldOrderView{OrderId: req.GetOrderId()}}, nil
}

func (s *script) GetUserHeldOrder(ctx context.Context, req *rfqv1.GetUserHeldOrderRequest) (*rfqv1.GetUserHeldOrderResponse, error) {
	if err := s.seen(ctx, "GetUserHeldOrder"); err != nil {
		return nil, err
	}
	return &rfqv1.GetUserHeldOrderResponse{Order: &rfqv1.UserHeldOrderView{OrderId: req.GetOrderId()}}, nil
}

func (s *script) ListUserHeldOrders(ctx context.Context, _ *rfqv1.ListUserHeldOrdersRequest) (*rfqv1.ListUserHeldOrdersResponse, error) {
	if err := s.seen(ctx, "ListUserHeldOrders"); err != nil {
		return nil, err
	}
	return &rfqv1.ListUserHeldOrdersResponse{}, nil
}

func serve(t *testing.T, s *script) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	gs := grpc.NewServer()
	rfqv1.RegisterRFQServiceServer(gs, s)
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
	if o.Token == nil && o.TokenSource == nil {
		o.Token = func(context.Context) (string, error) { return "jwt-one", nil }
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

func unavailable(string, int) error { return status.Error(codes.Unavailable, "[UNAVAILABLE] retry") }

// edgeErr is an edge error as the edge writes it: the reason in the message's prefix.
func edgeErr(code codes.Code, reason, rest string) error {
	return status.Error(code, "["+reason+"] "+rest)
}

func TestTheSessionTokenRidesOnEveryCall(t *testing.T) {
	s := &script{}
	c, _ := dial(t, serve(t, s), Options{})
	ctx := context.Background()
	if _, err := c.Terms(ctx, 7); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Get(ctx, "0x01"); err != nil {
		t.Fatal(err)
	}
	if len(s.auth) != 2 || s.auth[0] != "Bearer jwt-one" || s.auth[1] != "Bearer jwt-one" {
		t.Fatalf("authorization seen: %v", s.auth)
	}
	if _, err := Dial(ctx, Options{Target: "127.0.0.1:1"}); err == nil {
		t.Fatal("a client without a session token")
	}
}

// The reads and Place are repeated after UNAVAILABLE, with backoff, up to MaxAttempts.
func TestReadsAndPlaceAreRepeatedAfterUnavailable(t *testing.T) {
	s := &script{answer: unavailable}
	c, waits := dial(t, serve(t, s), Options{MaxAttempts: 3})
	ctx := context.Background()
	order := &rfqv1.HeldOrder{Place: &rfqv1.HeldSigned{}, Clear: &rfqv1.HeldSigned{}}
	calls := map[string]func() error{
		"GetUserHeldTerms":   func() error { _, err := c.Terms(ctx, 7); return err },
		"GetUserHeldOrder":   func() error { _, err := c.Get(ctx, "0x01"); return err },
		"ListUserHeldOrders": func() error { _, err := c.List(ctx, &rfqv1.ListUserHeldOrdersRequest{}); return err },
		"PlaceUserHeldOrder": func() error { _, err := c.Place(ctx, &rfqv1.PlaceUserHeldOrderRequest{Order: order}); return err },
	}
	for name, call := range calls {
		if err := call(); status.Code(err) != codes.Unavailable || s.Calls(name) != 3 {
			t.Errorf("%s: %v after %d calls, want UNAVAILABLE after 3", name, err, s.Calls(name))
		}
		if why, ok := RepeatableAfterUnavailable("/rfq.v1.RFQService/" + name); !ok || why == "" {
			t.Errorf("%s is not in the table", name)
		}
	}
	if len(*waits) != 2*len(calls) {
		t.Fatalf("waits %v", *waits)
	}
}

// Cancel is never repeated after UNAVAILABLE, nor after an attempt's own timeout: it may have run.
func TestCancelIsNeverRepeatedWhenItMayHaveRun(t *testing.T) {
	s := &script{answer: unavailable}
	c, waits := dial(t, serve(t, s), Options{})
	if _, err := c.Cancel(context.Background(), &rfqv1.CancelUserHeldOrderRequest{OrderId: "0x01"}); status.Code(err) != codes.Unavailable ||
		s.Calls("CancelUserHeldOrder") != 1 || len(*waits) != 0 {
		t.Fatalf("cancel: %v after %d calls, waits %v", err, s.Calls("CancelUserHeldOrder"), *waits)
	}
	if _, ok := RepeatableAfterUnavailable(rfqv1.RFQService_CancelUserHeldOrder_FullMethodName); ok {
		t.Fatal("cancel is in the table")
	}

	slow := &script{delay: func(string, int) time.Duration { return 300 * time.Millisecond }}
	c, _ = dial(t, serve(t, slow), Options{AttemptTimeout: 30 * time.Millisecond, MaxAttempts: 2})
	if _, err := c.Cancel(context.Background(), &rfqv1.CancelUserHeldOrderRequest{OrderId: "0x01"}); status.Code(err) != codes.DeadlineExceeded ||
		slow.Calls("CancelUserHeldOrder") != 1 {
		t.Fatalf("a timed-out cancel: %v after %d calls", err, slow.Calls("CancelUserHeldOrder"))
	}
	order := &rfqv1.HeldOrder{Place: &rfqv1.HeldSigned{}, Clear: &rfqv1.HeldSigned{}}
	if _, err := c.Place(context.Background(), &rfqv1.PlaceUserHeldOrderRequest{Order: order}); status.Code(err) != codes.DeadlineExceeded ||
		slow.Calls("PlaceUserHeldOrder") != 2 {
		t.Fatalf("a timed-out place: %v after %d calls", err, slow.Calls("PlaceUserHeldOrder"))
	}
}

// The edge's own RATE_LIMITED refused the call before it ran: any call, Cancel included, is
// repeated after the wait the edge asked for. gRPC's own RESOURCE_EXHAUSTED, and a reason no wait
// cures, are not; nor is a hint beyond MaxRetryWait.
func TestOnlyTheEdgesWaitableRefusalsAreWaitedOut(t *testing.T) {
	s := &script{answer: func(_ string, n int) error {
		if n == 1 {
			return edgeErr(codes.ResourceExhausted, "RATE_LIMITED", "too many requests; retry in 700 ms")
		}
		return nil
	}}
	c, waits := dial(t, serve(t, s), Options{})
	if _, err := c.Cancel(context.Background(), &rfqv1.CancelUserHeldOrderRequest{OrderId: "0x01"}); err != nil || s.Calls("CancelUserHeldOrder") != 2 {
		t.Fatalf("a rate-limited cancel: %v after %d calls", err, s.Calls("CancelUserHeldOrder"))
	}
	if len(*waits) != 1 || (*waits)[0] < 700*time.Millisecond {
		t.Fatalf("waits %v, want the edge's 700 ms", *waits)
	}

	for name, answer := range map[string]error{
		"gRPC's own":          status.Error(codes.ResourceExhausted, "grpc: received message larger than max"),
		"OPEN_ORDERS_CAP":     edgeErr(codes.ResourceExhausted, "OPEN_ORDERS_CAP", "too many open orders"),
		"a hint past the cap": edgeErr(codes.ResourceExhausted, "RATE_LIMITED", "retry in 60000 ms"),
		"PERMISSION_DENIED":   edgeErr(codes.PermissionDenied, "TAKER_MISMATCH", "not yours"),
		"INVALID_ARGUMENT":    edgeErr(codes.InvalidArgument, "INVALID_ARGUMENT", "bad"),
	} {
		answer := answer
		s := &script{answer: func(string, int) error { return answer }}
		c, waits := dial(t, serve(t, s), Options{})
		if _, err := c.Terms(context.Background(), 7); status.Code(err) != status.Code(answer) || s.Calls("GetUserHeldTerms") != 1 || len(*waits) != 0 {
			t.Errorf("%s: %v after %d calls, waits %v", name, err, s.Calls("GetUserHeldTerms"), *waits)
		}
	}
}

type flaky struct {
	mu          sync.Mutex
	invalidated int
}

func (f *flaky) Token(context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.invalidated == 0 {
		return "stale", nil
	}
	return "fresh", nil
}

func (f *flaky) Invalidate() { f.mu.Lock(); f.invalidated++; f.mu.Unlock() }

// UNAUTHENTICATED with a TokenSource: the source is told and the call goes once more with the
// fresh token, outside MaxAttempts; with a plain Token nothing is repeated.
func TestARefusedTokenIsReplacedOnceAndOnlyFromASource(t *testing.T) {
	var s *script
	s = &script{answer: func(string, int) error {
		s.mu.Lock()
		last := s.auth[len(s.auth)-1]
		s.mu.Unlock()
		if last != "Bearer fresh" {
			return edgeErr(codes.Unauthenticated, "UNAUTHENTICATED", "authentication required")
		}
		return nil
	}}
	src := &flaky{}
	c, _ := dial(t, serve(t, s), Options{TokenSource: src, MaxAttempts: 1})
	if _, err := c.Cancel(context.Background(), &rfqv1.CancelUserHeldOrderRequest{OrderId: "0x01"}); err != nil || src.invalidated != 1 ||
		s.Calls("CancelUserHeldOrder") != 2 {
		t.Fatalf("a stale token: %v, invalidated %d, %d calls", err, src.invalidated, s.Calls("CancelUserHeldOrder"))
	}
	plain := &script{answer: func(string, int) error {
		return edgeErr(codes.Unauthenticated, "UNAUTHENTICATED", "authentication required")
	}}
	c, _ = dial(t, serve(t, plain), Options{})
	if _, err := c.Terms(context.Background(), 7); status.Code(err) != codes.Unauthenticated || plain.Calls("GetUserHeldTerms") != 1 {
		t.Fatalf("a plain token: %v after %d calls", err, plain.Calls("GetUserHeldTerms"))
	}
}
