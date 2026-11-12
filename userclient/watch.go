package userclient

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
	"github.com/skew-trade/skew-sdk/transport"
)

// The feed's update types (UserHeldOrderUpdate.type). Ignore a type you do not know.
const (
	TypeOrder     = "order"
	TypeHeartbeat = "heartbeat"
)

// DefaultStallTimeout is WatchOptions.StallTimeout's default: three of the edge's 15 s heartbeats.
const DefaultStallTimeout = 45 * time.Second

// WatchOptions tune Watch.
type WatchOptions struct {
	// From resumes after this cursor (a saved one: the cursor of the last update processed). 0: the
	// changes from now on, nothing replayed.
	From uint64
	// Heartbeats also hands the heartbeats to fn. By default they only move the cursor, which is
	// what keeps a long-idle feed resumable.
	Heartbeats bool
	// StallTimeout reopens a stream silent this long, not even a heartbeat (DefaultStallTimeout;
	// negative: never).
	StallTimeout time.Duration
	// Backoff is the reconnect schedule (default 200 ms doubling to 10 s, +-20%).
	Backoff transport.Backoff
	// OnOpen is told each time a stream is opened, with the cursor it resumes from.
	OnOpen func(from uint64)
	// OnRetry is told why the stream is being reopened.
	OnRetry func(err error, attempt int, wait time.Duration)
}

// Watch streams the changes of the user's held orders to fn until ctx ends or fn returns an
// error, and reopens a broken stream from the last cursor it reached, so that fn sees every change
// once, in order. cursor is the position after the update: save it to resume from
// (WatchOptions.From) after a restart. Cursors count the user's changes from 1 without gaps, and a
// stream opens with a heartbeat that says where it starts: the client takes the edge's word for
// it. It returns nil when ctx ends.
//
// UNAUTHENTICATED ends it (after one fresh token, with a TokenSource), and so do
// PERMISSION_DENIED, INVALID_ARGUMENT, NOT_FOUND, FAILED_PRECONDITION, OUT_OF_RANGE and
// UNIMPLEMENTED. Anything else reopens the stream after a backoff (after the wait the edge asked
// for, when it asked), and a stream that delivered something starts the schedule over.
func (c *Client) Watch(ctx context.Context, o WatchOptions, fn func(u *rfqv1.UserHeldOrderUpdate, cursor uint64) error) error {
	if o.Backoff == (transport.Backoff{}) {
		o.Backoff = transport.Backoff{Initial: 200 * time.Millisecond, Max: 10 * time.Second, Jitter: 0.2}
	}
	o.Backoff = o.Backoff.Normalized()
	if o.StallTimeout == 0 {
		o.StallTimeout = DefaultStallTimeout
	}
	cursor := o.From
	attempt, refreshed := 0, false
	for {
		progressed, err := c.watchOnce(ctx, &cursor, o, fn)
		if ctx.Err() != nil {
			return nil
		}
		var fe fnError
		if errors.As(err, &fe) {
			return fe.err
		}
		if progressed {
			attempt, refreshed = 0, false
		}
		code := status.Code(err)
		switch code {
		case codes.Unauthenticated:
			if c.refresh == nil || refreshed {
				return err
			}
			refreshed = true
			c.refresh.Invalidate()
			continue
		case codes.PermissionDenied, codes.InvalidArgument, codes.NotFound, codes.FailedPrecondition, codes.OutOfRange, codes.Unimplemented:
			return err
		}
		attempt++
		wait := o.Backoff.Wait(attempt)
		if code == codes.ResourceExhausted {
			wait = max(wait, transport.RetryAfter(err))
		}
		wait = min(wait, max(c.opts.MaxRetryWait, o.Backoff.Max))
		if o.OnRetry != nil {
			o.OnRetry(err, attempt, wait)
		}
		if c.opts.Sleep(ctx, wait) != nil {
			return nil
		}
	}
}

type fnError struct{ err error }

func (e fnError) Error() string { return e.err.Error() }

var errStalled = status.Error(codes.Unavailable, "userclient: the feed went silent")

// watchOnce runs one stream until it fails, moving *cursor to every cursor the edge sends, and
// reports whether it received anything.
func (c *Client) watchOnce(ctx context.Context, cursor *uint64, o WatchOptions, fn func(*rfqv1.UserHeldOrderUpdate, uint64) error) (progressed bool, err error) {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var stalled atomic.Bool
	var dog *time.Timer
	if o.StallTimeout > 0 {
		dog = time.AfterFunc(o.StallTimeout, func() { stalled.Store(true); cancel() })
		defer dog.Stop()
	}
	if o.OnOpen != nil {
		o.OnOpen(*cursor)
	}
	stream, err := c.rfq.WatchUserHeldOrders(sctx, &rfqv1.WatchUserHeldOrdersRequest{Cursor: *cursor})
	if err != nil {
		return false, err
	}
	for {
		u, rerr := stream.Recv()
		if rerr != nil {
			if stalled.Load() && ctx.Err() == nil {
				rerr = errStalled
			}
			return progressed, rerr
		}
		progressed = true
		if dog != nil {
			dog.Reset(o.StallTimeout)
		}
		// The edge resumes strictly after the cursor it was given, and a heartbeat carries the
		// cursor the stream stands at (lower than the one asked for only when the edge knows no
		// change that far: then its count is the one to follow).
		*cursor = u.GetCursor()
		if u.GetType() == TypeHeartbeat && !o.Heartbeats {
			continue
		}
		if ferr := fn(u, *cursor); ferr != nil {
			return progressed, fnError{ferr}
		}
	}
}
