package userclient

import (
	"errors"
	"fmt"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/structpb"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
	"github.com/skew-trade/skew-sdk/heldsign"
)

// THE ORDERS. A user's held order is signed by heldsign, the one implementation the edge's own
// check is pinned to (testdata/held_vectors.json); this file only puts heldsign's answer on the wire.
//
// What the terms require of a user's order (held.proto, GetUserHeldTermsResponse):
// `place` a Gtc limit order, place.expiresAfter between min_life_ms and max_life_ms past the
// server's clock; a deadline (PlaceUserHeldOrderRequest.deadline_ms) at most max_deadline_ms past
// it; `clear`, the cancelByCloid of the same asset and cloid, with a nonce at or past the deadline
// and clear.expiresAfter at least cancel_grace_ms past the deadline; every nonce inside the window
// around the server's clock.

// Network is the chain the edge checks signatures for, from a book's terms: true for Hyperliquid's
// "Mainnet". Sign with it: a signature made for another chain recovers a stranger (SIGNER_MISMATCH).
func Network(terms *rfqv1.GetUserHeldTermsResponse) (mainnet bool, err error) {
	switch terms.GetHyperliquidChain() {
	case "Mainnet":
		return true, nil
	case "Testnet":
		return false, nil
	}
	return false, fmt.Errorf("userclient: the terms name no chain this client knows (%q)", terms.GetHyperliquidChain())
}

// Sign signs a user's order with signer (the user's agent wallet, or the account's own key) for the
// chain the terms name (heldsign.Sign) and returns it as PlaceUserHeldOrderRequest.order. An empty
// d.Tif is Gtc, the only time in force a user's order takes. The draft's Cloid, Nonce, ClearNonce
// and both expiresAfter must be set by the rules above.
func Sign(signer heldsign.Signer, d heldsign.Draft, terms *rfqv1.GetUserHeldTermsResponse) (*rfqv1.HeldOrder, error) {
	mainnet, err := Network(terms)
	if err != nil {
		return nil, err
	}
	if terms.GetBook() != 0 && d.Book != terms.GetBook() {
		return nil, fmt.Errorf("userclient: the draft is for book %d and the terms for book %d", d.Book, terms.GetBook())
	}
	if d.Tif == "" {
		d.Tif = heldsign.TifGtc
	}
	if d.ClearNonce == 0 {
		return nil, errors.New("userclient: a user's order needs its clear's nonce, at or past the deadline")
	}
	o, err := heldsign.Sign(signer, d, mainnet)
	if err != nil {
		return nil, err
	}
	return Wire(o)
}

// SignCancel signs the cancel of one of the user's orders NOW (CancelUserHeldOrderRequest.cancel):
// a cancelByCloid of the order's asset and cloid, under an ordinary nonce (the current time, unix
// ms) and a short expiresAfter (min_life_ms to max_life_ms past the server's clock). Sign a new
// one for every ask: an expired cancel is refused. A signer other than the order's must be a key
// Hyperliquid lists for the account; name it in CancelUserHeldOrderRequest.signer.
func SignCancel(signer heldsign.Signer, order *rfqv1.UserHeldOrderView, nonce, expiresAfter uint64, terms *rfqv1.GetUserHeldTermsResponse) (*rfqv1.HeldSigned, error) {
	mainnet, err := Network(terms)
	if err != nil {
		return nil, err
	}
	if order == nil {
		return nil, errors.New("userclient: no order to cancel")
	}
	cloid, err := heldsign.ParseCloid(order.GetCloid())
	if err != nil {
		return nil, fmt.Errorf("userclient: the order's cloid: %w", err)
	}
	side := heldsign.Side(order.GetSide())
	if order.GetSide() > 1 || !side.Valid() {
		return nil, fmt.Errorf("userclient: the order's side %d is neither Yes nor No", order.GetSide())
	}
	s, err := heldsign.SignCancel(signer, order.GetBook(), side, cloid, nonce, expiresAfter, mainnet)
	if err != nil {
		return nil, err
	}
	if order.GetAsset() != 0 && order.GetAsset() != heldsign.Asset(order.GetBook(), side) {
		return nil, fmt.Errorf("userclient: the order's asset %d is not its book's and side's", order.GetAsset())
	}
	return WireSigned(s)
}

// Wire is a signed held order (heldsign.Order) as the edge takes it: the account that trades, the
// address that signed, and the two signed actions, each exactly the body its signer would POST to
// Hyperliquid's /exchange. The edge rebuilds each action in Hyperliquid's own key order and checks
// the signature over that, so the action travels as a JSON object.
func Wire(o heldsign.Order) (*rfqv1.HeldOrder, error) {
	place, err := WireSigned(o.Place)
	if err != nil {
		return nil, fmt.Errorf("userclient: the place action: %w", err)
	}
	clr, err := WireSigned(o.Clear)
	if err != nil {
		return nil, fmt.Errorf("userclient: the clear action: %w", err)
	}
	return &rfqv1.HeldOrder{Account: strings.ToLower(o.Account.Hex()), Signer: strings.ToLower(o.Signer.Hex()), Place: place, Clear: clr}, nil
}

// WireSigned is one signed action as the edge takes it.
func WireSigned(s heldsign.SignedAction) (*rfqv1.HeldSigned, error) {
	if len(s.Action) == 0 {
		return nil, errors.New("no action")
	}
	action := &structpb.Struct{}
	if err := protojson.Unmarshal(s.Action, action); err != nil {
		return nil, fmt.Errorf("the action is not a JSON object: %w", err)
	}
	return &rfqv1.HeldSigned{Action: action, Nonce: s.Nonce, ExpiresAfter: s.ExpiresAfter,
		Signature: &rfqv1.HeldSignature{R: s.Signature.R, S: s.Signature.S, V: uint32(s.Signature.V)}}, nil
}
