package makerclient

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
	"github.com/skew-trade/skew-sdk/transport"
)

// THE RETRY POLICY, per method. Two kinds of failure, two questions:
//
//   - The edge's own RESOURCE_EXHAUSTED (RATE_LIMITED, TOO_MANY_STREAMS): the edge admits a call, or
//     refuses it, from its headers before it reads the request, so nothing ran.
//     Every method is repeated, after the wait the edge asked for. gRPC's own RESOURCE_EXHAUSTED (a
//     message larger than the edge takes) has no reason, and a repeat would fail the same way: it
//     is not repeated.
//   - UNAVAILABLE, or an attempt's own timeout: the first attempt may have run. A method is repeated
//     only if a repeat of one that ran changes nothing, which the table below says, method by
//     method. A method not in it is never repeated: a new method is classified before it is used.
//
// Never repeated: UNAUTHENTICATED (a key the edge does not know; each costs the caller's address a
// token of the bad-key bucket), PERMISSION_DENIED (a disabled maker), INVALID_ARGUMENT, NOT_FOUND,
// and everything else.
var mayRepeat = map[string]string{
	rfqv1.HeldOrderService_GetBookRules_FullMethodName: "a read",
	rfqv1.HeldOrderService_ListOrders_FullMethodName:   "a read",
	rfqv1.HeldOrderService_GetOrder_FullMethodName:     "a read",
	rfqv1.HeldOrderService_ReplaceBookOrders_FullMethodName: "its seq must grow per book: a repeat of an update that was applied is refused " +
		"STALE_SEQ and changes nothing (ReplaceResult.AppliedEarlier), and a refused strict update consumed no seq",
	rfqv1.HeldOrderService_WithdrawBook_FullMethodName: "with a seq, as a book update; with seq 0, a repeat withdraws what is left, " +
		"which is what was asked",
}

// RepeatableAfterUnavailable reports whether a method of HeldOrderService is repeated after
// UNAVAILABLE, and why it is safe to.
func RepeatableAfterUnavailable(method string) (why string, ok bool) {
	why, ok = mayRepeat[method]
	return why, ok
}

// unary runs one call with its retries and answers how many attempts it made.
func (c *Client) unary(ctx context.Context, method string, attempts int, call func(ctx context.Context) error) (int, error) {
	for attempt := 1; ; attempt++ {
		actx, cancel := ctx, context.CancelFunc(func() {})
		if c.opts.AttemptTimeout > 0 {
			actx, cancel = context.WithTimeout(ctx, c.opts.AttemptTimeout)
		}
		err := call(actx)
		cancel()
		if err == nil {
			return attempt, nil
		}
		if ctx.Err() != nil {
			return attempt, err
		}
		wait, again := c.retryable(method, err, attempt)
		if !again || attempt >= attempts {
			return attempt, err
		}
		// Never sleep past the caller's deadline: the answer would come too late to use.
		if dl, ok := ctx.Deadline(); ok && time.Until(dl) <= wait {
			return attempt, err
		}
		if c.opts.OnRetry != nil {
			c.opts.OnRetry(method, attempt, err, wait)
		}
		if c.opts.Sleep(ctx, wait) != nil {
			return attempt, err
		}
	}
}

// retryable decides whether err is worth another attempt of method, and after what wait. attempt
// is the number of the attempt that failed (1 for the first).
func (c *Client) retryable(method string, err error, attempt int) (time.Duration, bool) {
	switch status.Code(err) {
	case codes.ResourceExhausted:
		if _, edge := transport.ReasonOf(err); !edge {
			return 0, false
		}
		wait := max(c.opts.Backoff.Wait(attempt), transport.RetryAfter(err))
		if wait > c.opts.MaxRetryWait {
			return 0, false
		}
		return wait, true
	case codes.Unavailable, codes.DeadlineExceeded:
		// DeadlineExceeded with the caller's context alive is the attempt's own timeout.
		if _, ok := mayRepeat[method]; !ok {
			return 0, false
		}
		return min(c.opts.Backoff.Wait(attempt), c.opts.MaxRetryWait), true
	}
	return 0, false
}
