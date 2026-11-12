package heldsign_test

import (
	"encoding/json"
	"math/big"
	"strings"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	"github.com/skew-trade/skew-sdk/heldsign"
)

// A PUBLIC anvil dev key (the second): never fund it.
const devKey = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"

func signer(t *testing.T) heldsign.Signer {
	t.Helper()
	k, err := crypto.HexToECDSA(devKey)
	if err != nil {
		t.Fatal(err)
	}
	s, err := heldsign.KeySigner(k)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func draft(t *testing.T) heldsign.Draft {
	t.Helper()
	c, err := heldsign.NewCloid()
	if err != nil {
		t.Fatal(err)
	}
	return heldsign.Draft{Book: 4242, Side: heldsign.No, IsBuy: true, Px: 43_000, Size: 7, Cloid: c, Nonce: 1_793_966_400_000,
		ExpiresAfter: 1_793_966_430_000, ClearExpiresAfter: 1_793_966_490_000}
}

// highS signs as the key does and hands back the high-s twin with v flipped: the same signature by
// the same signer, as an HSM may produce it.
type highS struct{ heldsign.Signer }

func (h highS) SignDigest(d [32]byte) ([]byte, error) {
	sig, err := h.Signer.SignDigest(d)
	if err != nil {
		return nil, err
	}
	n := crypto.S256().Params().N
	s := new(big.Int).Sub(n, new(big.Int).SetBytes(sig[32:64]))
	s.FillBytes(sig[32:64])
	sig[64] = 27 + 28 - sig[64]
	return sig, nil
}

func TestSignWritesTheCanonicalBodies(t *testing.T) {
	s := signer(t)
	d := draft(t)
	o, err := heldsign.Sign(s, d, false)
	if err != nil {
		t.Fatal(err)
	}
	if o.Account != o.Signer || o.Signer != common.HexToAddress(s.Address()) {
		t.Fatalf("account %s signer %s", o.Account.Hex(), o.Signer.Hex())
	}
	if o.Clear.Nonce != d.Nonce+1 || o.Place.ExpiresAfter != d.ExpiresAfter || o.Clear.ExpiresAfter != d.ClearExpiresAfter {
		t.Fatalf("nonces and lives: %+v %+v", o.Place, o.Clear)
	}
	place, clear, err := o.Bodies()
	if err != nil {
		t.Fatal(err)
	}
	want := `{"action":{"type":"order","orders":[{"a":100042421,"b":true,"p":"0.43","s":"7","r":false,"t":{"limit":{"tif":"Alo"}},"c":"` + d.Cloid.String() + `"}],"grouping":"na"},"nonce":1793966400000,"signature":`
	if !strings.HasPrefix(string(place), want) || !strings.HasSuffix(string(place), `,"expiresAfter":1793966430000}`) {
		t.Fatalf("place body %s", place)
	}
	if !strings.HasPrefix(string(clear), `{"action":{"type":"cancelByCloid","cancels":[{"asset":100042421,"cloid":"`+d.Cloid.String()+`"}]},"nonce":1793966400001,`) {
		t.Fatalf("clear body %s", clear)
	}
	// A signer that hands back the high-s twin yields the same bytes: one signed action, one spelling.
	twin, err := heldsign.Sign(highS{s}, d, false)
	if err != nil {
		t.Fatal(err)
	}
	tp, tc, err := twin.Bodies()
	if err != nil {
		t.Fatal(err)
	}
	if string(tp) != string(place) || string(tc) != string(clear) {
		t.Fatalf("the high-s twin changed the bodies:\n%s\n%s", tp, place)
	}
	// The other network signs other bytes.
	main, err := heldsign.Sign(s, d, true)
	if err != nil {
		t.Fatal(err)
	}
	if main.Place.Signature == o.Place.Signature {
		t.Fatal("mainnet and testnet signed the same")
	}
}

func TestSignRefusesAnIncompleteDraft(t *testing.T) {
	s := signer(t)
	for name, mod := range map[string]func(*heldsign.Draft){
		"no cloid":         func(d *heldsign.Draft) { d.Cloid = heldsign.Cloid{} },
		"no nonce":         func(d *heldsign.Draft) { d.Nonce = 0 },
		"no expiresAfter":  func(d *heldsign.Draft) { d.ExpiresAfter = 0 },
		"no clear's life":  func(d *heldsign.Draft) { d.ClearExpiresAfter = 0 },
		"no shares":        func(d *heldsign.Draft) { d.Size = 0 },
		"a side that isnt": func(d *heldsign.Draft) { d.Side = 2 },
		"a price of 0":     func(d *heldsign.Draft) { d.Px = 0 },
	} {
		d := draft(t)
		mod(&d)
		if _, err := heldsign.Sign(s, d, false); err == nil {
			t.Errorf("%s: signed", name)
		}
	}
	if _, err := heldsign.Sign(nil, draft(t), false); err == nil {
		t.Error("no signer: signed")
	}
}

func TestSignedActionBody(t *testing.T) {
	if _, err := (heldsign.SignedAction{}).Body(); err == nil {
		t.Fatal("a body without its action")
	}
	b, err := heldsign.SignedAction{Action: json.RawMessage(`{"type":"noop"}`), Nonce: 7, ExpiresAfter: 9}.Body()
	if err != nil || string(b) != `{"action":{"type":"noop"},"nonce":7,"signature":{"r":"","s":"","v":0},"expiresAfter":9}` {
		t.Fatalf("%s %v", b, err)
	}
}

// A cancel on request is the clear Sign makes, byte for byte, for the same asset, cloid, nonce and
// expiresAfter.
func TestSignCancelIsTheClearsBytes(t *testing.T) {
	d := draft(t)
	d.ClearNonce, d.ClearExpiresAfter = 1_793_966_412_345, 1_793_966_472_345
	for _, mainnet := range []bool{false, true} {
		o, err := heldsign.Sign(signer(t), d, mainnet)
		if err != nil {
			t.Fatal(err)
		}
		c, err := heldsign.SignCancel(signer(t), d.Book, d.Side, d.Cloid, d.ClearNonce, d.ClearExpiresAfter, mainnet)
		if err != nil {
			t.Fatal(err)
		}
		want, _ := o.Clear.Body()
		got, err := c.Body()
		if err != nil || string(got) != string(want) {
			t.Fatalf("mainnet %v: %s %v, want %s", mainnet, got, err, want)
		}
	}
	for name, call := range map[string]func() error{
		"no signer": func() error { _, err := heldsign.SignCancel(nil, d.Book, d.Side, d.Cloid, 1, 2, false); return err },
		"no side":   func() error { _, err := heldsign.SignCancel(signer(t), d.Book, 7, d.Cloid, 1, 2, false); return err },
		"no cloid": func() error {
			_, err := heldsign.SignCancel(signer(t), d.Book, d.Side, heldsign.Cloid{}, 1, 2, false)
			return err
		},
		"no nonce": func() error {
			_, err := heldsign.SignCancel(signer(t), d.Book, d.Side, d.Cloid, 0, 2, false)
			return err
		},
		"no expiry": func() error {
			_, err := heldsign.SignCancel(signer(t), d.Book, d.Side, d.Cloid, 1, 0, false)
			return err
		},
	} {
		if call() == nil {
			t.Errorf("%s: signed", name)
		}
	}
}
