// Package transport is the call plumbing every Go client of the Skew RFQ edge shares, and nothing
// that belongs to one service: the retry schedule, the edge's error reasons and the waits it asks
// for, and the connection's security and keepalive. The per-role clients sit on it:
//
//	userclient   RFQService's held orders (a user's session JWT)
//	makerclient  HeldOrderService (a maker's API key)
//
// Each of them decides which of its calls may be repeated, and why; this package only says how
// long to wait and what an error means.
//
// It imports the generated wire types for one message, rfq.v1.ErrorDetail.
package transport

import (
	"context"
	"crypto/tls"
	"math/rand/v2"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
	"google.golang.org/grpc/status"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
)

// Backoff is a retry schedule. The zero value is 100 ms doubling to 2 s, without jitter.
type Backoff struct {
	Initial    time.Duration
	Max        time.Duration
	Multiplier float64
	// Jitter is the fraction each wait varies by, either way (0.2 = +-20%; 0, none). Out of range
	// (negative, or 1 and more) it is 0.2.
	Jitter float64
}

// Normalized is the schedule with its defaults filled.
func (b Backoff) Normalized() Backoff {
	if b.Initial <= 0 {
		b.Initial = 100 * time.Millisecond
	}
	if b.Max <= 0 {
		b.Max = 2 * time.Second
	}
	if b.Multiplier < 1 {
		b.Multiplier = 2
	}
	if b.Jitter < 0 || b.Jitter >= 1 {
		b.Jitter = 0.2
	}
	return b
}

// Wait is the delay before retry number n (1 is the first retry).
func (b Backoff) Wait(n int) time.Duration {
	b = b.Normalized()
	d := float64(b.Initial)
	for i := 1; i < n && d < float64(b.Max); i++ {
		d *= b.Multiplier
	}
	if d > float64(b.Max) {
		d = float64(b.Max)
	}
	if b.Jitter > 0 {
		d *= 1 - b.Jitter + 2*b.Jitter*rand.Float64()
	}
	return time.Duration(d)
}

// Sleep waits d, or returns ctx.Err() when ctx ends first.
func Sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// Security is the connection's transport credentials: plaintext when insecure (a listener inside
// the caller's own network, local development, tests), else TLS with cfg (nil: the system roots,
// TLS 1.2 or later).
func Security(insecureDial bool, cfg *tls.Config) grpc.DialOption {
	if insecureDial {
		return grpc.WithTransportCredentials(insecure.NewCredentials())
	}
	if cfg == nil {
		cfg = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	return grpc.WithTransportCredentials(credentials.NewTLS(cfg))
}

// Keepalive is the client keepalive the edge admits: pings no more often than every 10 s, with or
// without a stream.
func Keepalive() grpc.DialOption {
	return grpc.WithKeepaliveParams(keepalive.ClientParameters{Time: 30 * time.Second, Timeout: 10 * time.Second})
}

// Detail returns the ErrorDetail the edge attached to err, if any.
func Detail(err error) (*rfqv1.ErrorDetail, bool) {
	st, ok := status.FromError(err)
	if !ok {
		return nil, false
	}
	for _, d := range st.Details() {
		if ed, ok := d.(*rfqv1.ErrorDetail); ok {
			return ed, true
		}
	}
	return nil, false
}

// ReasonOf returns the stable reason of an edge error: from the ErrorDetail, else from the
// "[REASON] " prefix of the message, which every edge error carries too (a refusal at the held
// edge's door is written into the message for a client that receives no detail).
func ReasonOf(err error) (string, bool) {
	if d, ok := Detail(err); ok && d.GetReason() != "" {
		return d.GetReason(), true
	}
	st, ok := status.FromError(err)
	if !ok {
		return "", false
	}
	if msg := st.Message(); strings.HasPrefix(msg, "[") {
		if end := strings.Index(msg, "]"); end > 1 {
			return msg[1:end], true
		}
	}
	return "", false
}

// RetryAfter is the wait the edge asked for, or 0: the ErrorDetail's retry_after_ms, else the
// "retry in N ms" of the message, where a refusal at the held edge's door also carries it.
func RetryAfter(err error) time.Duration {
	if d, ok := Detail(err); ok {
		return time.Duration(d.GetRetryAfterMs()) * time.Millisecond
	}
	st, ok := status.FromError(err)
	if !ok {
		return 0
	}
	msg := st.Message()
	i := strings.LastIndex(msg, "retry in ")
	if i < 0 {
		return 0
	}
	rest := msg[i+len("retry in "):]
	j := strings.Index(rest, " ms")
	if j <= 0 {
		return 0
	}
	n, err := strconv.ParseUint(rest[:j], 10, 32)
	if err != nil {
		return 0
	}
	return time.Duration(n) * time.Millisecond
}
