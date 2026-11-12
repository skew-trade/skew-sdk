package makerclient

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

// The feed's event types the client itself reads (held.proto, HeldOrderEvent.type). Every other
// type goes to the caller as it comes; ignore one you do not know.
const (
	TypeHeartbeat = "heartbeat"
	TypeReset     = "reset"
)

// Why the feed was reset (HeldOrderEvent.reset_reason). The two mean different things and must not
// be confused.
const (
	// ResetPoolEmpty: the pool restarted after your position (another epoch). It holds NONE of the
	// orders you sent before: send every book again. Every book's seq starts from 0.
	ResetPoolEmpty = "POOL_EMPTY"
	// ResetEventsMissed: events between your position and the reset cannot be sent (you fell
	// behind, or were away longer than the feed reaches). Your orders MAY STILL BE LIVE: read them
	// (LiveOrders), or send every book again, which is always safe.
	ResetEventsMissed = "EVENTS_MISSED"
)

// Position is where a maker's feed stands: the last cursor processed and the epoch it counts in. A
// cursor means nothing outside its epoch. The zero Position is no position: the events from now on,
// nothing replayed.
type Position struct {
	Cursor uint64
	Epoch  string
}

// IsZero reports whether p is no position.
func (p Position) IsZero() bool { return p == Position{} }

// next is the position after ev, and whether ev is new (not a replay of what was delivered).
// Heartbeats and resets carry the epoch; other events only a cursor, in the epoch of the last
// heartbeat or reset. A position moves forward only, within an epoch; a reset puts it where the
// stream goes on from.
func (p Position) next(ev *rfqv1.HeldOrderEvent) (Position, bool) {
	switch ev.GetType() {
	case TypeReset:
		return Position{Cursor: ev.GetCursor(), Epoch: ev.GetEpoch()}, true
	case TypeHeartbeat:
		if ev.GetEpoch() != "" && ev.GetEpoch() != p.Epoch {
			return Position{Cursor: ev.GetCursor(), Epoch: ev.GetEpoch()}, true
		}
		return Position{Cursor: max(p.Cursor, ev.GetCursor()), Epoch: p.Epoch}, true
	}
	if p.Epoch != "" && ev.GetCursor() <= p.Cursor {
		return p, false
	}
	return Position{Cursor: ev.GetCursor(), Epoch: p.Epoch}, true
}

// WatchOptions tune Watch.
type WatchOptions struct {
	// From resumes after this position (a saved one: the at of the last event processed). Zero:
	// the events from now on, nothing replayed.
	From Position
	// Book, when set, follows one book.
	Book uint32
	// Heartbeats also hands the heartbeats to fn. By default they only move the position, which is
	// what keeps a long-idle feed resumable.
	Heartbeats bool
	// StallTimeout reopens a stream silent this long, not even a heartbeat (default 45 s: three of
	// the edge's 15 s heartbeats; negative: never).
	StallTimeout time.Duration
	// Backoff is the reconnect schedule (default 200 ms doubling to 10 s, +-20%).
	Backoff transport.Backoff
	// OnOpen is told each time a stream is opened, with the position it resumes from.
	OnOpen func(from Position)
	// OnRetry is told why the stream is being reopened.
	OnRetry func(err error, attempt int, wait time.Duration)
}

// DefaultStallTimeout is WatchOptions.StallTimeout's default.
const DefaultStallTimeout = 45 * time.Second

// Watch streams what happens to your held orders to fn until ctx ends or fn returns an error, and
// reopens a broken stream from the last position it reached, so that fn sees every event once, in
// order. at is the position after the event: save it to resume from (WatchOptions.From) after a
// restart. It returns nil when ctx ends.
//
// A "reset" event always reaches fn: the pool cannot go on from the position, and ResetReason says
// what to do (ResetPoolEmpty: send every book again; ResetEventsMissed: read your live orders, or
// send every book again). The feed goes on from the reset's own position.
//
// UNAUTHENTICATED (the key was replaced), PERMISSION_DENIED (the maker was disabled), INVALID_ARGUMENT,
// NOT_FOUND, FAILED_PRECONDITION and UNIMPLEMENTED end it. Anything else reopens the stream after a
// backoff (after the wait the edge asked for, when it asked), and a stream that delivered something
// starts the schedule over.
func (c *Client) Watch(ctx context.Context, o WatchOptions, fn func(ev *rfqv1.HeldOrderEvent, at Position) error) error {
	if o.Backoff == (transport.Backoff{}) {
		o.Backoff = transport.Backoff{Initial: 200 * time.Millisecond, Max: 10 * time.Second, Jitter: 0.2}
	}
	o.Backoff = o.Backoff.Normalized()
	if o.StallTimeout == 0 {
		o.StallTimeout = DefaultStallTimeout
	}
	at := o.From
	attempt := 0
	for {
		progressed, err := c.watchOnce(ctx, &at, o, fn)
		if ctx.Err() != nil {
			return nil
		}
		var fe fnError
		if errors.As(err, &fe) {
			return fe.err
		}
		if progressed {
			attempt = 0
		}
		code := status.Code(err)
		switch code {
		case codes.Unauthenticated, codes.PermissionDenied, codes.InvalidArgument, codes.NotFound, codes.FailedPrecondition, codes.Unimplemented:
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

var errStalled = status.Error(codes.Unavailable, "makerclient: the feed went silent")

// watchOnce runs one stream until it fails, moving *at past what it delivers and past heartbeats,
// and reports whether it received anything.
func (c *Client) watchOnce(ctx context.Context, at *Position, o WatchOptions, fn func(*rfqv1.HeldOrderEvent, Position) error) (progressed bool, err error) {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var stalled atomic.Bool
	var dog *time.Timer
	if o.StallTimeout > 0 {
		dog = time.AfterFunc(o.StallTimeout, func() { stalled.Store(true); cancel() })
		defer dog.Stop()
	}
	if o.OnOpen != nil {
		o.OnOpen(*at)
	}
	stream, err := c.held.WatchOrders(sctx, &rfqv1.WatchHeldOrdersRequest{Cursor: at.Cursor, Epoch: at.Epoch, Book: o.Book})
	if err != nil {
		return false, err
	}
	for {
		ev, rerr := stream.Recv()
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
		next, fresh := at.next(ev)
		*at = next
		if !fresh || (ev.GetType() == TypeHeartbeat && !o.Heartbeats) {
			continue
		}
		if ferr := fn(ev, next); ferr != nil {
			return progressed, fnError{ferr}
		}
	}
}
