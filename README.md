# Skew SDK

Clients for **Skew RFQ**, Skew's market for Hyperliquid's HIP-4 outcome markets, in Go and
TypeScript:

- **market makers** quote firm **held orders**: Hyperliquid post-only orders they sign and do not
  send. Skew holds them and relays them to Hyperliquid, byte for byte, when a user's order takes
  them;
- **apps** place a user's held order (one Hyperliquid limit order, signed by the app's agent
  wallet for the user), follow it, cancel it, and show the public markets feed.

Skew never holds a key and never changes what was signed: every trade happens on Hyperliquid's own
book, between the accounts that signed. There is one environment: production, on Hyperliquid
mainnet.

| | Go (`github.com/skew-trade/skew-sdk`) | TypeScript (`@skew-trade/sdk`) |
|---|---|---|
| a maker's held orders | `makerclient`, `heldsign` | `@skew-trade/sdk/maker` |
| a user's held orders | `userclient`, `heldsign` | `@skew-trade/sdk` |
| the markets feed | the frames in `gen/rfq/v1` | `@skew-trade/sdk` (`connectMarkets`) |
| wire types | `gen/rfq/v1` (gRPC) | the generated `*Json` types (REST and WebSocket JSON) |

The rest of the repository: `proto/rfq/v1`, the protos both are generated from (`RFQService`, a
user's held orders; `HeldOrderService`, the maker API; the markets feed's frames);
[`docs/MAKER-SPEC.md`](docs/MAKER-SPEC.md), the maker specification; `testdata/`, the signing
vectors both languages reproduce byte for byte.

## Install

```sh
go get github.com/skew-trade/skew-sdk@v0.1.0
npm install @skew-trade/sdk viem
```

The Go module needs Go 1.25.3 or later (its `go.mod` says so). The TypeScript package is ESM for
browsers, React Native and Node 20.19 or later; its one runtime dependency for signing is
`@noble/hashes`. It takes no key: you inject a signer (a viem account, as the examples here do, or
anything with `address` and `signTypedData`; `viem` is needed only for the former).

## Endpoints

| | |
|---|---|
| REST base URL | `https://rfq.skew.trade` |
| gRPC target | `rfq.skew.trade:443` (TLS) |
| markets WebSocket | `wss://markets.skew.trade/v1/ws` |

A maker sends its API key in the `X-Skew-Maker-Key` header (gRPC: the metadata of the same name);
the clients do it for you (`makerclient.Options.Key`, `makerKeyAuth`). An app sends the user's
session token as a bearer token (next section). The markets WebSocket is public: no key.

## Quick start: a maker quoting firm held orders

A maker needs an API key (`skm_…`), the Hyperliquid accounts it quotes from on Skew's allowlist,
and a key that signs for them (the account's own key or one of its API wallets: read
[section 4 of the spec](docs/MAKER-SPEC.md#4-the-one-rule-about-keys) before choosing). Each book
update replaces all of the maker's orders on that book; each order is a signed `order` action
carrying one post-only order and the signed `cancelByCloid` of its cloid.

In Go, over gRPC:

```go
// Command maker quotes firm held orders on one book: it reads the book's rules, signs one
// post-only order on each side, replaces the book with them, then follows what happens to them
// until interrupted, and withdraws the book on the way out.
//
//	HELD_WALLET_KEY=<hex, from a file> MAKER_ACCOUNT=0x... SKEW_MAKER_KEY=skm_... SKEW_HELD_GRPC=host:443 go run ./examples/maker
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"

	rfqv1 "github.com/skew-trade/skew-sdk/gen/rfq/v1"
	"github.com/skew-trade/skew-sdk/heldsign"
	"github.com/skew-trade/skew-sdk/makerclient"
)

const book = 4242 // the outcome id

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	key, err := crypto.HexToECDSA(strings.TrimPrefix(os.Getenv("HELD_WALLET_KEY"), "0x")) // an API wallet used for held orders only
	check(err)
	signer, err := heldsign.KeySigner(key)
	check(err)
	account := common.HexToAddress(os.Getenv("MAKER_ACCOUNT")) // the allowlisted Hyperliquid account that trades

	c, err := makerclient.Dial(ctx, makerclient.Options{Target: os.Getenv("SKEW_HELD_GRPC"), Key: os.Getenv("SKEW_MAKER_KEY")})
	check(err)
	defer c.Close()

	rules, err := c.Rules(ctx, book)
	check(err)
	now := uint64(rules.GetServerTime().AsTime().UnixMilli()) // every time is checked against the server's clock
	quotes := []struct {
		side  heldsign.Side
		isBuy bool
		px    string
		size  uint64
	}{
		{heldsign.Yes, true, "0.54", 20}, // buy 20 Yes at 0.54
		{heldsign.No, true, "0.44", 20},  // buy 20 No at 0.44
	}
	var orders []*rfqv1.HeldOrder
	for i, q := range quotes {
		px, err := heldsign.ParsePx(q.px)
		check(err)
		cloid, err := heldsign.NewCloid()
		check(err)
		o, err := makerclient.Sign(signer, heldsign.Draft{
			Account: account, Book: book, Side: q.side, IsBuy: q.isBuy, Px: px, Size: q.size,
			Tif: heldsign.TifAlo, Cloid: cloid,
			Nonce:             now + uint64(2*i), // the clear takes Nonce + 1: every nonce is new
			ExpiresAfter:      now + 60_000,      // Skew may relay the order for a minute
			ClearExpiresAfter: now + 120_000,     // its cancel outlives it
		}, rules) // signed for the network the rules name
		check(err)
		orders = append(orders, o)
	}

	// Replaces ALL of this maker's orders on the book; Seq must grow per book.
	res, err := c.ReplaceBook(ctx, &rfqv1.ReplaceHeldBookOrdersRequest{Book: book, Seq: uint64(time.Now().UnixMilli()), Orders: orders})
	check(err)
	if !res.GetApplied() {
		log.Printf("not applied: %s %s", res.GetCode(), res.GetReason())
	}
	for _, v := range res.GetVerdicts() {
		fmt.Println(v.GetCloid(), v.GetCode(), v.GetReason())
	}

	// Watch reopens a broken stream from the last position it reached; save `at` to resume after
	// a restart (WatchOptions.From).
	err = c.Watch(ctx, makerclient.WatchOptions{Book: book}, func(ev *rfqv1.HeldOrderEvent, at makerclient.Position) error {
		if ev.GetType() == "reset" {
			log.Printf("reset %s: send the book again", ev.GetResetReason())
		}
		for _, o := range ev.GetOrders() {
			fmt.Println(ev.GetType(), o.GetCloid(), o.GetState(), o.GetFilledSz())
		}
		return nil
	})
	check(err)

	// Pull the quotes before leaving (a fresh context: ctx has ended).
	wctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err = c.Withdraw(wctx, book, 0)
	check(err)
}

func check(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
```

In TypeScript, over REST:

```ts
// A maker quoting firm held orders on one book: read the book's rules, sign one post-only order
// on each side, replace the book with them, then follow what happens to them.
import { privateKeyToAccount } from "viem/accounts"
import { HELD_RESET_POOL_EMPTY, createMakerClient, randomCloid, signHeldOrder } from "@skew-trade/sdk/maker"

const book = 4242 // the outcome id
const wallet = privateKeyToAccount(process.env.HELD_WALLET_KEY as `0x${string}`) // an API wallet used for held orders only
const account = process.env.MAKER_ACCOUNT as `0x${string}` // the allowlisted Hyperliquid account that trades
const client = createMakerClient({ baseUrl: process.env.SKEW_API!, makerKey: process.env.SKEW_MAKER_KEY! })

const rules = await client.getBookRules(book)
const mainnet = rules.hyperliquidChain === "Mainnet" // the network the signatures are checked for
const now = Date.parse(rules.serverTime!) // every time is checked against the server's clock
const quotes = [
  { side: 0, isBuy: true, px: "0.54", sz: "20" }, // buy 20 Yes at 0.54
  { side: 1, isBuy: true, px: "0.44", sz: "20" }, // buy 20 No at 0.44
] as const
const orders = await Promise.all(
  quotes.map((q, i) =>
    signHeldOrder(
      {
        account,
        signer: wallet.address,
        book,
        ...q,
        cloid: randomCloid(),
        nonce: now + 2 * i, // the clear takes nonce + 1: every nonce is new
        expiresAfter: now + 60_000, // Skew may relay the order for a minute
        clearExpiresAfter: now + 120_000, // its cancel outlives it
        mainnet,
      },
      (typedData) => wallet.signTypedData(typedData),
    ),
  ),
)

// Replaces ALL of this maker's orders on the book; seq must grow per book.
const res = await client.replaceBookOrders(book, { seq: Date.now(), orders })
if (!res.applied) console.log("not applied:", res.code, res.reason)
for (const v of res.verdicts ?? []) console.log(v.cloid, v.code, v.reason ?? "")

// The feed reopens itself from the last cursor and epoch it saw.
for await (const ev of client.watchOrders()) {
  if (ev.type === "reset" && ev.resetReason === HELD_RESET_POOL_EMPTY) console.log("the pool restarted: send every book again")
  for (const o of ev.orders ?? []) console.log(ev.type, o.cloid, o.state, o.filledSz ?? "0")
}
```

Both clients retry what is safe to repeat (a book update and a withdraw included: their `seq` makes
a repeat change nothing), never retry a refused key, and reopen the event feed from the last cursor
and epoch they saw. The rules of every field, the refusal codes and the limits are in
[`docs/MAKER-SPEC.md`](docs/MAKER-SPEC.md).

## Quick start: an app placing and following a user's held order

The app holds an agent wallet for the user's Hyperliquid account and the user's session token.
It reads the book's terms, plans the order on the server's clock, signs it with the agent, and hands
it to Skew with a deadline: Skew matches it with makers' held orders and relays it to Hyperliquid;
what does not fill rests on Hyperliquid's book in the user's own account until the deadline, when
Skew sends the user's pre-signed cancel.

```ts
// An app placing a user's held order and following it: the book's terms, the order planned on
// the server's clock and signed by the user's agent wallet, placed with its deadline, then its
// changes as they happen.
import { privateKeyToAccount } from "viem/accounts"
import {
  USER_HELD_ENDED,
  createRfqClient,
  isUserHeldRefusal,
  planUserHeldOrder,
  signUserHeldOrder,
  userHeldClock,
  userHeldOrder,
} from "@skew-trade/sdk"

const book = 4242 // the outcome id
const agent = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`) // the app's agent wallet for the user's account
const account = process.env.USER_ACCOUNT as `0x${string}` // the user's Hyperliquid account: the session's subject
const client = createRfqClient({ baseUrl: process.env.SKEW_API!, getToken: () => process.env.SKEW_SESSION_JWT! })

const terms = await client.getUserHeldTerms(book)
const serverNow = userHeldClock(terms) // every bound is checked against the server's clock
const draft = planUserHeldOrder(
  terms,
  {
    account,
    signer: agent.address,
    side: 0, // Yes
    isBuy: true,
    px: "0.55",
    sz: "10",
    deadlineMs: serverNow() + 10 * 60_000, // Skew cancels what still rests after ten minutes
  },
  serverNow(),
)
const placed = await client.placeUserHeldOrder(await signUserHeldOrder(draft, agent))
if (isUserHeldRefusal(placed)) throw new Error(`refused: ${placed.refusal.code} ${placed.refusal.reason ?? ""}`)
const orderId = placed.order!.orderId!
console.log("placed", orderId, placed.order!.state)

// The updates stream starts from now and reopens itself from the last cursor it saw; an app that
// must not miss a change keeps u.cursor and passes it back as { cursor } after a restart.
for await (const u of client.watchUserHeldOrders()) {
  if (u.type !== "order" || u.order?.orderId !== orderId) continue
  const o = userHeldOrder(u.order)
  console.log(o.state, `filled ${o.filledSz} at ${o.avgPx}`, `resting ${o.restingSz}`)
  if (USER_HELD_ENDED.has(o.state)) break
}
```

### For apps: sessions

Two things must be in place before an app can place a user's held order:

- **a session token.** It is issued by Skew's accounts API when the user signs in, and names the
  user's Hyperliquid account. The app passes it to the client (`getToken` in TypeScript,
  `userclient.Options.TokenSource` in Go), which sends it as a bearer token on every call and asks
  for a fresh one when it is refused. The SDK does not sign users in;
- **an approved agent wallet.** The key that signs the user's orders is an agent (API) wallet of
  the user's Hyperliquid account, and the user must have approved it on Hyperliquid (Hyperliquid's
  `approveAgent` action, signed by the account itself). Hyperliquid accepts no order from an agent
  that is not approved.

Signing in and sessions are described on the **Sessions** page of Skew's documentation.

To cancel sooner, the app signs a cancel at that moment (`planUserHeldCancel`, `signUserHeldCancel`)
and hands it to `cancelUserHeldOrder`. A backend or a bot does the same in Go with `userclient`
(`Terms`, `Sign`, `Place`, `Watch`, `SignCancel`, `Cancel`).

## The markets feed

`connectMarkets` (TypeScript) follows the public markets WebSocket: each market's book on
Hyperliquid, in the held orders and in Skew RFQ, with the `book_seq` chain and its resync, the
state, top of book and the market index. `proto/rfq/v1/book.proto` lists every frame and field the
feed serves.

## Development

```sh
go vet ./... && go test ./...
cd ts && npm ci && npm run typecheck && npm run typecheck:test && npm test && npm run build
```

`gen/` and `ts/src/gen/` are generated from `proto/` with buf (protoc-gen-go v1.36.10,
protoc-gen-go-grpc v1.4.0, and protoc-gen-es from `ts/node_modules`); do not edit them:

```sh
cd proto && buf generate && buf generate --template buf.gen.ts.yaml --include-imports
```

This repository is generated from Skew's source by an export, so a change made here directly
is replaced by the next export: propose it in an issue. CI runs the Go and TypeScript tests and
`scripts/privacy-scan.sh`.

## Versions

[`CHANGELOG.md`](CHANGELOG.md). Until 1.0.0 a minor version may change the API.

## License

To be decided. Until a license is published in this repository, none is granted.
