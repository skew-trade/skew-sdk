// Package heldsigntest checks heldsign against the held vectors from whichever module imports it:
// this module's own tests, and a maker's (call Check from a test of the module that vendors
// heldsign, so that the signer it builds is the one these bytes pin). held_vectors.json here is a
// copy of testdata/held_vectors.json, embedded because a vendored package carries no testdata;
// this module's test fails when the two differ.
//
// The vectors' key is a PUBLIC anvil dev key: never fund it. Nothing in this package is for a
// production binary; import it from tests only.
package heldsigntest

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/skew-trade/skew-sdk/heldsign"
)

//go:embed held_vectors.json
var vectors []byte

// Vectors is the embedded copy of testdata/held_vectors.json.
func Vectors() []byte { return bytes.Clone(vectors) }

type signedVector struct {
	Action       json.RawMessage    `json:"action"`
	Nonce        uint64             `json:"nonce"`
	ExpiresAfter uint64             `json:"expiresAfter"`
	Signature    heldsign.Signature `json:"signature"`
	Body         string             `json:"body"`
}

type orderVector struct {
	Name    string       `json:"name"`
	Mainnet bool         `json:"mainnet"`
	Account string       `json:"account"`
	Signer  string       `json:"signer"`
	Book    uint32       `json:"book"`
	Side    uint8        `json:"side"`
	IsBuy   bool         `json:"isBuy"`
	Px      string       `json:"px"`
	Sz      string       `json:"sz"`
	Tif     string       `json:"tif"`
	Cloid   string       `json:"cloid"`
	Asset   uint64       `json:"asset"`
	Place   signedVector `json:"place"`
	Clear   signedVector `json:"clear"`
}

// Check re-signs every vector with heldsign and the vectors' key and compares, byte for byte: both
// actions as JSON, nonces, expiresAfter, signatures, the two /exchange bodies the pool relays, the
// account, the signer and the asset. nil when everything matches.
func Check() error {
	var v struct {
		SignerKey string        `json:"signerKey"`
		Orders    []orderVector `json:"orders"`
	}
	if err := json.Unmarshal(vectors, &v); err != nil {
		return fmt.Errorf("heldsigntest: the vectors do not parse: %w", err)
	}
	if len(v.Orders) == 0 {
		return fmt.Errorf("heldsigntest: no vectors")
	}
	key, err := crypto.HexToECDSA(strings.TrimPrefix(v.SignerKey, "0x"))
	if err != nil {
		return fmt.Errorf("heldsigntest: the vectors' key: %w", err)
	}
	signer, err := heldsign.KeySigner(key)
	if err != nil {
		return err
	}
	for _, o := range v.Orders {
		if err := checkOne(signer, o); err != nil {
			return fmt.Errorf("heldsigntest: %q: %w", o.Name, err)
		}
	}
	return nil
}

func checkOne(signer heldsign.Signer, o orderVector) error {
	px, err := heldsign.ParsePx(o.Px)
	if err != nil {
		return err
	}
	var size uint64
	if _, err := fmt.Sscan(o.Sz, &size); err != nil {
		return fmt.Errorf("sz %q: %w", o.Sz, err)
	}
	cloid, err := heldsign.ParseCloid(o.Cloid)
	if err != nil {
		return err
	}
	side := heldsign.Side(o.Side)
	d := heldsign.Draft{Account: common.HexToAddress(o.Account), Book: o.Book, Side: side, IsBuy: o.IsBuy, Px: px, Size: size, Tif: o.Tif,
		Cloid: cloid, Nonce: o.Place.Nonce, ClearNonce: o.Clear.Nonce, ExpiresAfter: o.Place.ExpiresAfter, ClearExpiresAfter: o.Clear.ExpiresAfter}
	got, err := heldsign.Sign(signer, d, o.Mainnet)
	if err != nil {
		return err
	}
	if a := heldsign.Asset(o.Book, side); a != o.Asset {
		return fmt.Errorf("asset %d, want %d", a, o.Asset)
	}
	if lower(got.Account) != o.Account || lower(got.Signer) != o.Signer {
		return fmt.Errorf("account %s signer %s, want %s %s", lower(got.Account), lower(got.Signer), o.Account, o.Signer)
	}
	for _, c := range []struct {
		name string
		got  heldsign.SignedAction
		want signedVector
	}{{"place", got.Place, o.Place}, {"clear", got.Clear, o.Clear}} {
		var compact bytes.Buffer
		if err := json.Compact(&compact, c.want.Action); err != nil {
			return fmt.Errorf("%s.action: %w", c.name, err)
		}
		if !bytes.Equal(c.got.Action, compact.Bytes()) {
			return fmt.Errorf("%s.action %s, want %s", c.name, c.got.Action, compact.Bytes())
		}
		if c.got.Nonce != c.want.Nonce || c.got.ExpiresAfter != c.want.ExpiresAfter || c.got.Signature != c.want.Signature {
			return fmt.Errorf("%s: nonce %d expiresAfter %d signature %+v, want %d %d %+v", c.name, c.got.Nonce, c.got.ExpiresAfter, c.got.Signature,
				c.want.Nonce, c.want.ExpiresAfter, c.want.Signature)
		}
		body, err := c.got.Body()
		if err != nil {
			return err
		}
		if string(body) != c.want.Body {
			return fmt.Errorf("%s body %s, want %s", c.name, body, c.want.Body)
		}
	}
	return nil
}

func lower(a common.Address) string { return strings.ToLower(a.Hex()) }
