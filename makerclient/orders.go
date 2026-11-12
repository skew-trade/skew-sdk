package makerclient

import (
	"errors"
	"fmt"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/types/known/structpb"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
	"github.com/skew-trade/skew-sdk/heldsign"
)

// THE ORDERS. A held order is signed by heldsign, the one implementation the pool's own check is
// pinned to (testdata/held_vectors.json); this file only puts heldsign's answer on the wire.

// Network is the network the edge checks signatures for, from a book's rules: true for Mainnet,
// false for Testnet. Sign with it: a signature made for the other network recovers a stranger
// (SIGNER_MISMATCH).
func Network(rules *rfqv1.GetHeldBookRulesResponse) (mainnet bool, err error) {
	switch rules.GetHyperliquidChain() {
	case "Mainnet":
		return true, nil
	case "Testnet":
		return false, nil
	}
	return false, fmt.Errorf("makerclient: the rules name no network this client knows (%q)", rules.GetHyperliquidChain())
}

// Sign signs a draft with signer for the network the rules name (heldsign.Sign) and returns the
// held order as the edge takes it. The draft's Cloid, Nonce and both expiresAfter must be set, and
// its lives must sit inside the rules' bounds around their server_time.
func Sign(signer heldsign.Signer, d heldsign.Draft, rules *rfqv1.GetHeldBookRulesResponse) (*rfqv1.HeldOrder, error) {
	mainnet, err := Network(rules)
	if err != nil {
		return nil, err
	}
	if rules.GetBook() != 0 && d.Book != rules.GetBook() {
		return nil, fmt.Errorf("makerclient: the draft is for book %d and the rules for book %d", d.Book, rules.GetBook())
	}
	o, err := heldsign.Sign(signer, d, mainnet)
	if err != nil {
		return nil, err
	}
	return Wire(o)
}

// Wire is a signed held order (heldsign.Order) as the edge takes it: the account that trades, the
// address that signed, and the two signed actions, each exactly the body its signer would POST to
// Hyperliquid's /exchange. The edge rebuilds each action in Hyperliquid's own key order and checks
// the signature over that, so the action travels as a JSON object.
func Wire(o heldsign.Order) (*rfqv1.HeldOrder, error) {
	place, err := signedWire(o.Place)
	if err != nil {
		return nil, fmt.Errorf("makerclient: the place action: %w", err)
	}
	clr, err := signedWire(o.Clear)
	if err != nil {
		return nil, fmt.Errorf("makerclient: the clear action: %w", err)
	}
	return &rfqv1.HeldOrder{Account: strings.ToLower(o.Account.Hex()), Signer: strings.ToLower(o.Signer.Hex()), Place: place, Clear: clr}, nil
}

func signedWire(s heldsign.SignedAction) (*rfqv1.HeldSigned, error) {
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
