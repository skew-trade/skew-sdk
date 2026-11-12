package transport

import (
	"errors"
	"testing"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
)

// The edge's errors carry their reason and wait in the detail (an interceptor's refusal) or in the
// message alone (a refusal at the door, before the request is read): both read the same.
func TestReasonAndWaitFromTheDetailOrTheMessage(t *testing.T) {
	st, _ := status.New(codes.ResourceExhausted, "[RATE_LIMITED] too many requests (held-write); retry in 9 ms").
		WithDetails(&rfqv1.ErrorDetail{Reason: "RATE_LIMITED", RetryAfterMs: 250})
	withDetail := st.Err()
	door := status.Error(codes.ResourceExhausted, "[RATE_LIMITED] too many requests (held-write); retry in 50 ms")
	tooLarge := status.Error(codes.ResourceExhausted, "grpc: received message larger than max (70000 vs. 65536)")

	for _, c := range []struct {
		name   string
		err    error
		reason string
		ok     bool
		wait   time.Duration
	}{
		{"the detail wins over the message", withDetail, "RATE_LIMITED", true, 250 * time.Millisecond},
		{"the door's message", door, "RATE_LIMITED", true, 50 * time.Millisecond},
		{"gRPC's own: no reason, no wait", tooLarge, "", false, 0},
		{"not a status", errors.New("[RATE_LIMITED] retry in 5 ms"), "", false, 0},
		{"a reason without a wait", status.Error(codes.Unavailable, "[UNAVAILABLE] the service is unavailable; retry shortly"), "UNAVAILABLE", true, 0},
	} {
		reason, ok := ReasonOf(c.err)
		if reason != c.reason || ok != c.ok || RetryAfter(c.err) != c.wait {
			t.Errorf("%s: %q %v %s", c.name, reason, ok, RetryAfter(c.err))
		}
	}
}

func TestBackoffDefaultsAndCap(t *testing.T) {
	b := Backoff{Initial: 100 * time.Millisecond, Max: 300 * time.Millisecond, Jitter: 0.0001}
	for n, want := range map[int]time.Duration{1: 100 * time.Millisecond, 2: 200 * time.Millisecond, 3: 300 * time.Millisecond, 9: 300 * time.Millisecond} {
		if got := b.Wait(n); got < want*9999/10000 || got > want*10001/10000 {
			t.Errorf("wait %d: %s, want %s", n, got, want)
		}
	}
	if z := (Backoff{}).Normalized(); z.Initial != 100*time.Millisecond || z.Max != 2*time.Second || z.Multiplier != 2 || z.Jitter != 0 {
		t.Errorf("%+v", z)
	}
	if j := (Backoff{Jitter: 1}).Normalized().Jitter; j != 0.2 {
		t.Errorf("an out-of-range jitter is %v, want 0.2", j)
	}
}
