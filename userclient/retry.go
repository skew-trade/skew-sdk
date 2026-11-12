package userclient

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
	"github.com/skew-trade/skew-sdk/transport"
)

// THE RETRY POLICY, per method. Three kinds of failure:
//
//   - The edge's own RESOURCE_EXHAUSTED (RATE_LIMITED, TOO_MANY_STREAMS): the edge's limits refuse
//     a call before its handler runs, so nothing ran. Every method is repeated, after the wait the
//     edge asked for. Any other RESOURCE_EXHAUSTED (gRPC's own, a message too large; or a reason
//     that waiting does not cure) is not.
//   - UNAVAILABLE, or an attempt's own timeout: the first attempt may have run. A method is repeated
//     only if a repeat of one that ran changes nothing, which the table below says, method by
//     method. A method not in it is never repeated: a new method is classified before it is used.
//     CancelUserHeldOrder is not in it, on purpose: the cancel it carries was signed for one ask.
//   - UNAUTHENTICATED: the token was refused (expired, rotated). With a TokenSource the source is
//     told and the call is sent once more with a fresh token; a second refusal is final.
//
// Never repeated: PERMISSION_DENIED (BETA_REQUIRED, TAKER_MISMATCH), INVALID_ARGUMENT, NOT_FOUND,
// FAILED_PRECONDITION and everything else.
var mayRepeat = map[string]string{
	rfqv1.RFQService_GetUserHeldTerms_FullMethodName:   "a read",
	rfqv1.RFQService_GetUserHeldOrder_FullMethodName:   "a read",
	rfqv1.RFQService_ListUserHeldOrders_FullMethodName: "a read",
	rfqv1.RFQService_PlaceUserHeldOrder_FullMethodName: "keyed by the order id: the same signed bytes placed again answer the order " +
		"as it stands, and never make a second order",
}

// RepeatableAfterUnavailable reports whether a method of RFQService is repeated after UNAVAILABLE,
// and why it is safe to.
func RepeatableAfterUnavailable(method string) (why string, ok bool) {
	why, ok = mayRepeat[method]
	return why, ok
}

// The edge's reasons a wait cures (rfq.proto, ERRORS).
var waitable = map[string]bool{"RATE_LIMITED": true, "TOO_MANY_STREAMS": true}

// unary runs one call with its retries and answers how many times it was sent.
func (c *Client) unary(ctx context.Context, method string, call func(ctx context.Context) error) (int, error) {
	refreshed, sent := false, 0
	for attempt := 1; ; {
		actx, cancel := ctx, context.CancelFunc(func() {})
		if c.opts.AttemptTimeout > 0 {
			actx, cancel = context.WithTimeout(ctx, c.opts.AttemptTimeout)
		}
		err := call(actx)
		cancel()
		sent++
		if err == nil {
			return sent, nil
		}
		if ctx.Err() != nil {
			return sent, err
		}
		if status.Code(err) == codes.Unauthenticated {
			if c.refresh == nil || refreshed {
				return sent, err
			}
			// Once more with a fresh token, on top of MaxAttempts: the edge refused the call at its
			// door, so nothing ran.
			refreshed = true
			c.refresh.Invalidate()
			continue
		}
		wait, again := c.retryable(method, err, attempt)
		if !again || attempt >= c.opts.MaxAttempts {
			return sent, err
		}
		// Never sleep past the caller's deadline: the answer would come too late to use.
		if dl, ok := ctx.Deadline(); ok && time.Until(dl) <= wait {
			return sent, err
		}
		if c.opts.OnRetry != nil {
			c.opts.OnRetry(method, attempt, err, wait)
		}
		if c.opts.Sleep(ctx, wait) != nil {
			return sent, err
		}
		attempt++
	}
}

// retryable decides whether err is worth another attempt of method, and after what wait. attempt
// is the number of the attempt that failed (1 for the first).
func (c *Client) retryable(method string, err error, attempt int) (time.Duration, bool) {
	switch status.Code(err) {
	case codes.ResourceExhausted:
		if reason, edge := transport.ReasonOf(err); !edge || !waitable[reason] {
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
