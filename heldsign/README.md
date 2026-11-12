# heldsign: signing a held order

`github.com/skew-trade/skew-sdk/heldsign` builds and signs a held order (MAKER-SPEC §3): the
`order` action carrying one order with a cloid, its `cancelByCloid`, each signed as a Hyperliquid
L1 action with `expiresAfter` inside the hash, and the two `/exchange` request bodies Skew relays.
It is the only implementation: the server checks orders against the same code, and
`testdata/held_vectors.json` pins its bytes. It sends nothing and reads no key: the caller hands it
a `Signer`.

| What | For |
|---|---|
| `Draft`, `Sign(signer, draft, mainnet) (Order, error)` | the held order: the place and the clear, signed |
| `Order.Bodies()`, `SignedAction.Body()` | the two `/exchange` request bodies, as Skew relays them |
| `SignCancel(signer, book, side, cloid, nonce, expiresAfter, mainnet)` | one `cancelByCloid` signed now: a user's cancel on request (byte for byte the clear `Sign` makes for the same inputs) |
| `KeySigner(*ecdsa.PrivateKey)` | a `Signer` over a key in memory (any type with `Address()` and `SignDigest` is one) |
| `NewCloid()`, `ParseCloid`, `ParsePx`, `Asset(book, side)` | the cloid, a price on the tick, a book's asset id |
| `TifAlo`, `TifGtc` | a maker's held order is post-only (`Alo`); a user's is `Gtc` |
| `heldsigntest.Check()` | re-signs every vector through heldsign; call it from a test of the module that vendors heldsign |

`makerclient` builds on it: `makerclient.Sign(signer, draft, rules)` signs a draft for
the chain a book's rules name (`hyperliquid_chain`) and returns the `HeldOrder` that
`ReplaceBookOrders` takes. `userclient` does the same for a user's order
(`userclient.Sign`, a Gtc order under a book's terms) and its cancel on request
(`userclient.SignCancel`).

## A held order

```go
key, _ := crypto.HexToECDSA(hexFromAFile)            // the account's API wallet; never a command line
signer, _ := heldsign.KeySigner(key)
cloid, _ := heldsign.NewCloid()
now := uint64(time.Now().UnixMilli())
o, err := heldsign.Sign(signer, heldsign.Draft{Account: account, Book: book, Side: heldsign.Yes, IsBuy: false,
	Px: 55_000, Size: 10, Tif: heldsign.TifAlo, Cloid: cloid, Nonce: now, ExpiresAfter: now + 60_000,
	ClearExpiresAfter: now + 180_000}, rules.GetHyperliquidChain() == "Mainnet")
place, clear, err := o.Bodies()                       // the two signed /exchange bodies
```

`Px` is in ticks of 0.00001 (55,000 is 0.55); `Size` is whole shares. `GetBookRules` gives the
bounds every time must fall in (`min_life_ms`, `max_life_ms`, `clear_grace_ms`, `clear_max_ms`) and
the nonce window, around its `server_time`.

## Vendoring it

heldsign imports three of this module's own packages, `internal/hl`, `internal/hip4` and
`internal/eip712`. `go mod vendor` in the importing module vendors and builds them: the internal
rule is about the IMPORTING package's path, which is heldsign's. The importing module's code cannot
import them directly, and needs not: heldsign's aliases (`Side`, `Px`, `Cloid`, `Signer`,
`Signature`, `Action`) name their types.

The gate in the importing module:

```go
func TestHeldsignVectors(t *testing.T) {
	if err := heldsigntest.Check(); err != nil {
		t.Fatal(err)
	}
}
```

The vectors' key is a PUBLIC anvil dev key; never fund it. heldsigntest is for tests only.
