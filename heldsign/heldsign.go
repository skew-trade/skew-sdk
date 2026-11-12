// Package heldsign builds and signs a held order: one Hyperliquid order that Skew holds for its
// signer and relays, byte for byte, when a match needs it (docs/MAKER-SPEC.md §3). A
// held order is two signed L1 actions of one signer for one account:
//
//   - place: an `order` action carrying exactly ONE order, with a cloid;
//   - clear: the `cancelByCloid` of the same asset and cloid, under another nonce.
//
// Both carry expiresAfter, and it is inside the hash each signature covers (the phantom agent's
// connectionId commits to the action, the nonce and expiresAfter). Skew relays the two request
// bodies (SignedAction.Body) and holds no key.
//
// This package is the ONE implementation: the server checks every order against this same code,
// testdata/held_vectors.json pins its bytes, and a maker's Go program imports it (makerclient.Sign
// is this package with the book's rules applied). heldsigntest.Check re-signs every vector through
// it, from whichever module calls it: README.md in this directory.
//
// It sends nothing and reads no key from anywhere: the caller hands it a Signer.
package heldsign

import (
	"crypto/ecdsa"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/skew-trade/skew-sdk/internal/hip4"
	"github.com/skew-trade/skew-sdk/internal/hl"
)

// ---------------------------------------------------------------- the types it speaks in

// Side is the side of a HIP-4 outcome an order is on: Yes or No.
type Side = hip4.Side

// The two sides.
const (
	Yes Side = hip4.Yes
	No  Side = hip4.No
)

// Px is a price in ticks of 0.00001 (Hyperliquid's outcome tick): 0.55 is 55000. Its String is the
// canonical decimal Hyperliquid hashes ("0.55"); Complement is 1 - px.
type Px = hip4.Px

// ParsePx reads a canonical decimal price ("0.55") into ticks.
func ParsePx(s string) (Px, error) { return hip4.ParsePx(s) }

// Cloid is a Hyperliquid client order id (16 bytes, written 0x + 32 hex).
type Cloid = hl.Cloid

// ParseCloid reads 0x + 32 hex.
func ParseCloid(s string) (Cloid, error) { return hl.ParseCloid(s) }

// Signer signs a 32-byte digest and returns r||s||v with v 27 or 28; Address is its address, 0x
// hex. KeySigner is one over a key in memory; an HSM or MPC signer is another.
type Signer = hl.Signer

// Signature is the {r, s, v} an /exchange request carries.
type Signature = hl.Signature

// Action is an L1 action in Hyperliquid's key order: its JSON is the action as signed.
type Action = hl.OMap

// The times in force. A maker's held order is post-only, Alo; a user's is Gtc.
const (
	TifAlo = hl.TifAlo
	TifGtc = hl.TifGtc
	TifIoc = hl.TifIoc
)

// Asset is the order asset of a side of an outcome (100,000,000 + 10 x outcome + side).
func Asset(book uint32, side Side) uint64 { return hip4.Asset(book, side) }

// KeySigner is a Signer over a private key held in memory. The key is the caller's: load it from a
// file the caller trusts, never from a command line.
func KeySigner(key *ecdsa.PrivateKey) (Signer, error) {
	if key == nil {
		return nil, errors.New("heldsign: no key")
	}
	return keySigner{key: key, addr: strings.ToLower(crypto.PubkeyToAddress(key.PublicKey).Hex())}, nil
}

type keySigner struct {
	key  *ecdsa.PrivateKey
	addr string
}

func (k keySigner) Address() string { return k.addr }

func (k keySigner) SignDigest(digest [32]byte) ([]byte, error) {
	sig, err := crypto.Sign(digest[:], k.key)
	if err != nil {
		return nil, err
	}
	sig[64] += 27
	return sig, nil
}

// ---------------------------------------------------------------- the draft

// Draft is a held order before it is signed.
type Draft struct {
	// Account is the Hyperliquid account that trades. Zero: the signer itself.
	Account common.Address
	// Book is the outcome id, Side the side of it the order is on.
	Book  uint32
	Side  Side
	IsBuy bool
	Px    Px
	Size  uint64
	// Tif defaults to Alo.
	Tif string
	// Cloid names the order; NewCloid draws a random one (Sign refuses a zero cloid).
	Cloid Cloid
	// Nonce is the place action's nonce (unix ms); the clear's is ClearNonce, or Nonce + 1.
	Nonce      uint64
	ClearNonce uint64
	// ExpiresAfter is the place action's expiresAfter (unix ms); the clear's is ClearExpiresAfter.
	ExpiresAfter      uint64
	ClearExpiresAfter uint64
}

// NewCloid draws a random cloid.
func NewCloid() (Cloid, error) {
	var c Cloid
	if _, err := rand.Read(c[:]); err != nil {
		return c, fmt.Errorf("heldsign: no randomness for a cloid: %w", err)
	}
	return c, nil
}

// Actions are a draft's two actions exactly as Hyperliquid hashes them: the order action carrying
// the one order, and the cancelByCloid of its cloid.
func (d Draft) Actions() (place, clear Action, err error) {
	if !d.Side.Valid() {
		return nil, nil, fmt.Errorf("heldsign: side %d is neither Yes nor No", d.Side)
	}
	if err := d.Px.Valid(); err != nil {
		return nil, nil, err
	}
	if d.Size == 0 {
		return nil, nil, errors.New("heldsign: an order needs at least one share")
	}
	if d.Cloid.IsZero() {
		return nil, nil, errors.New("heldsign: a held order needs a cloid")
	}
	tif := d.Tif
	if tif == "" {
		tif = hl.TifAlo
	}
	asset := hip4.Asset(d.Book, d.Side)
	place = hl.Order(hl.OrderSpec{Asset: asset, IsBuy: d.IsBuy, Px: d.Px.String(), Sz: hip4.FormatSz(d.Size), Tif: tif, Cloid: d.Cloid.String()})
	return place, hl.CancelByCloid(asset, d.Cloid.String()), nil
}

// ---------------------------------------------------------------- signing

// SignedAction is one signed L1 action in its canonical form: the action as JSON in Hyperliquid's
// key order, the nonce, the signature (v 27 or 28, low s, minimal hex) and expiresAfter. Its Body
// is the /exchange request.
type SignedAction struct {
	Action       json.RawMessage // the action, JSON
	Nonce        uint64          // unix ms, unique per signer (Hyperliquid keeps each signer's 100 highest)
	Signature    Signature
	ExpiresAfter uint64 // unix ms
}

// Body is the /exchange request Skew relays: {action, nonce, signature, expiresAfter}.
func (s SignedAction) Body() ([]byte, error) {
	if len(s.Action) == 0 {
		return nil, errors.New("heldsign: a signed action without its action")
	}
	ea := s.ExpiresAfter
	return json.Marshal(hl.Request{Action: s.Action, Nonce: s.Nonce, Signature: s.Signature, ExpiresAfter: &ea})
}

// Order is a signed held order: the account that trades, the address that signed, and the two
// signed actions in their canonical forms. Place.Body() and Clear.Body() are the bytes the pool
// relays, exactly the PlaceBody and ClearBody its check of the order yields.
type Order struct {
	Account common.Address
	Signer  common.Address
	Place   SignedAction
	Clear   SignedAction
}

// Bodies are the two /exchange request bodies: the place's and the clear's.
func (o Order) Bodies() (place, clear []byte, err error) {
	if place, err = o.Place.Body(); err != nil {
		return nil, nil, err
	}
	if clear, err = o.Clear.Body(); err != nil {
		return nil, nil, err
	}
	return place, clear, nil
}

// Sign signs a draft's two actions with signer for a Hyperliquid chain (mainnet true: the phantom
// agent's source "a"; false: "b") and returns the held order. The chain a deployment checks
// signatures for is GetBookRules' hyperliquid_chain. The draft's Cloid, Nonce and both expiresAfter
// must be set.
func Sign(signer Signer, d Draft, mainnet bool) (Order, error) {
	if signer == nil {
		return Order{}, errors.New("heldsign: no signer")
	}
	if d.Nonce == 0 || d.ExpiresAfter == 0 || d.ClearExpiresAfter == 0 {
		return Order{}, errors.New("heldsign: a draft needs its nonce and both expiresAfter")
	}
	place, clear, err := d.Actions()
	if err != nil {
		return Order{}, err
	}
	clearNonce := d.ClearNonce
	if clearNonce == 0 {
		clearNonce = d.Nonce + 1
	}
	p, err := signAction(signer, place, d.Nonce, d.ExpiresAfter, mainnet)
	if err != nil {
		return Order{}, err
	}
	c, err := signAction(signer, clear, clearNonce, d.ClearExpiresAfter, mainnet)
	if err != nil {
		return Order{}, err
	}
	if !common.IsHexAddress(signer.Address()) {
		return Order{}, fmt.Errorf("heldsign: the signer's address %q is not one", signer.Address())
	}
	who := common.HexToAddress(signer.Address())
	account := d.Account
	if account == (common.Address{}) {
		account = who
	}
	return Order{Account: account, Signer: who, Place: p, Clear: c}, nil
}

// signAction signs one L1 action with expiresAfter inside the hash and returns it in its canonical
// form (low s, v 27 or 28, minimal hex).
func signAction(signer Signer, action Action, nonce, expiresAfter uint64, mainnet bool) (SignedAction, error) {
	ea := expiresAfter
	sig, err := hl.SignL1(signer, action, nonce, hl.L1Options{ExpiresAfter: &ea}, mainnet)
	if err != nil {
		return SignedAction{}, err
	}
	if sig, err = sig.Canonical(); err != nil {
		return SignedAction{}, fmt.Errorf("heldsign: the signer's signature: %w", err)
	}
	raw, err := json.Marshal(action)
	if err != nil {
		return SignedAction{}, err
	}
	return SignedAction{Action: raw, Nonce: nonce, Signature: sig, ExpiresAfter: expiresAfter}, nil
}

// SignCancel signs ONE cancelByCloid of a book side's asset and a cloid, with signer for a
// Hyperliquid chain (mainnet as Sign's): a user's cancel on request, signed when the user asks with
// an ordinary nonce (the current time) and a short expiresAfter, which Skew relays as it is
// (RFQService.CancelUserHeldOrder's `cancel`). Its bytes are those of the clear Sign makes for the
// same asset, cloid, nonce and expiresAfter.
func SignCancel(signer Signer, book uint32, side Side, cloid Cloid, nonce, expiresAfter uint64, mainnet bool) (SignedAction, error) {
	if signer == nil {
		return SignedAction{}, errors.New("heldsign: no signer")
	}
	if !side.Valid() {
		return SignedAction{}, fmt.Errorf("heldsign: side %d is neither Yes nor No", side)
	}
	if cloid.IsZero() {
		return SignedAction{}, errors.New("heldsign: a cancel needs the order's cloid")
	}
	if nonce == 0 || expiresAfter == 0 {
		return SignedAction{}, errors.New("heldsign: a cancel needs its nonce and expiresAfter")
	}
	return signAction(signer, hl.CancelByCloid(hip4.Asset(book, side), cloid.String()), nonce, expiresAfter, mainnet)
}
