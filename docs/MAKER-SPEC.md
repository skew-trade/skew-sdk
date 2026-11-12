# Held orders: the maker specification

For an engineer at a market-making firm who will quote Skew's HIP-4 outcome markets through Skew's
held-order pool. Version 1.6, 2026-11-08. Machine-readable twin: `GET /api/v1/held/openapi.json`.

Status of the service: **match**. The pool accepts, checks, holds and expires held orders, and the
matcher sends them to Hyperliquid when a user's order takes them (sections 9 to 12). The rules'
`mode` (section 6.1) says which a deployment runs: `match`, or `ingest`, where orders are held and
expire and nothing is sent.

Rules marked **[measured]** are what Hyperliquid did when Skew measured them on 2026-11-06 (765
relayed requests). The quoted words are Hyperliquid's. Timings can differ from one day to the next.

## 1. What a held order is

A held order is one Hyperliquid order that you have signed and have **not sent**. You give Skew two
signed L1 actions:

| | Action | Purpose |
|---|---|---|
| `place` | an `order` action carrying **exactly one** post-only (`Alo`) limit order with a client order id (cloid) | the quote |
| `clear` | a `cancelByCloid` action naming the same asset and cloid, under another nonce | removes whatever the quote leaves on the book |

Each is exactly the JSON body you would POST to Hyperliquid's `/exchange` yourself:
`{"action": …, "nonce": …, "signature": {"r","s","v"}, "expiresAfter": …}`.

Skew holds the two bodies. When a taker's order matches your quote, Skew relays your `place` body to
Hyperliquid byte for byte, then the taker's order, then your `clear` body for any leftover. The
trade happens on Hyperliquid's own book between your account and the taker's: a buy of Yes against
a buy of No on the merged outcome book mints the pair. Money never leaves your Hyperliquid account,
Skew never holds your key, and Skew cannot change an order: one altered field makes Hyperliquid
recover a different signer (**[measured]** `"User or API Wallet 0x… does not exist."`, and the
untouched original stays valid).

Nothing fee-related goes into the order: no `builder` field. Skew earns from the markets' own fees.

## 2. Before you start

1. **An API key.** Skew creates a maker record for you and gives you one API key (`skm_` + 64 hex),
   once, over a private channel. Skew stores only its hash; if you lose it, ask for a rotation.
2. **An allowlist.** Tell Skew which Hyperliquid account addresses you will quote from. Only those
   accounts are accepted, and an account belongs to one maker.
3. **A signing key.** Sign with whatever already signs your Hyperliquid orders: the account's own
   key, or one of its API wallets. Read section 4 before you choose.
4. **The environment.** There is one: production, on Hyperliquid mainnet. Skew has no testnet or
   staging environment for makers. You start on production with small limits (section 13).

| | Production |
|---|---|
| Skew API base URL | given with your key |
| Hyperliquid network | Mainnet (`source` "a") |
| Hyperliquid API | `https://api.hyperliquid.xyz` |

`GET /api/v1/held/books/{book}/rules` names the network the deployment checks signatures for
(`hyperliquidChain`, `Mainnet`). A signature made for another network is refused (`SIGNER_MISMATCH`).

Every request carries your key in the header **`X-Skew-Maker-Key`**. There is no session, no JWT, no
IP allowlist and no geofence on these routes. An unknown key is HTTP 401, a disabled maker 403,
both without detail.

How fast a change to your key reaches the API: **within about a second**. Skew's operator changes
the makers' registry; the engine that holds the pool reads it about once a second.

| Change | What you see, within about a second |
|---|---|
| a new key (first issue, or a rotation) | it works |
| the old key after a rotation | 401; its open streams end (`UNAUTHENTICATED`). Your live orders stay listed until they end, but **none handed in before the rotation is ever matched or sent**: it came in under a key that is no longer trusted. Withdraw them or let them expire, and send your books again under the new key |
| Skew disables you | 403; your live orders are withdrawn; your open streams end (`FORBIDDEN`) |
| Skew removes an account from your allowlist | its live orders are withdrawn; new ones are refused (`ACCOUNT_NOT_ALLOWED`) |

Whatever that second holds, **nothing is sent** for a maker Skew has disabled or an account it has
removed from the moment the operator's command is done: before any order is sent Skew reads the
registry again, in the same database transaction that commits to sending it.

**The pool is in memory.** Skew holds your orders in the memory of one process. They are not
written to a database: a quote that lives seconds is not worth a row. Three things follow, and
sections 5 and 6.5 say how you see them:

- A **restart** of that process (a deployment, a crash) forgets every order that was not yet
  claimed for sending. **None of those is ever sent.** Orders already claimed or posted finish:
  from the moment Skew commits to sending an order it is written down.
- Each run has an **epoch** (16 hex digits), in the rules answer and on the stream. When the epoch
  changes, the pool holds nothing you sent before: **send every book again**. `seq` starts over.
- The pool is never restored from a copy, so an order you withdrew or replaced can never come back
  after a restart.

## 3. What to sign

### 3.1 The book and its two assets

A **book** is one outcome (one market), named by Hyperliquid's outcome id. It has two assets:

```
asset = 100000000 + 10 * outcome + side        side 0 = Yes, 1 = No
```

Book 4242: Yes is asset `100042420` (book coin `#42420`), No is `100042421` (`#42421`). Yes and No
trade on one merged book: a buy of Yes at `p` and a sale of No at `1 - p` are bids at `p`; a sale
of Yes at `p` and a buy of No at `1 - p` are offers at `p`.

### 3.2 The `place` action

```json
{"type":"order","orders":[{"a":100042420,"b":true,"p":"0.55","s":"20","r":false,"t":{"limit":{"tif":"Alo"}},"c":"0x736b65772d68656c642d766563746f01"}],"grouping":"na"}
```

| Field | Rule | Refusal |
|---|---|---|
| key order | `type`, `orders`, `grouping`; inside the order `a`, `b`, `p`, `s`, `r`, `t`, `c`. The JSON you send may be in any order; the **hash** is over this order (it is what Hyperliquid's own SDKs produce) | `SIGNER_MISMATCH` |
| `orders` | exactly one | `ORDER_COUNT` |
| `a` | one of the book's two assets, a JSON number | `WRONG_BOOK` |
| `b` | `true` buy, `false` sell | |
| `p` | price as a **canonical** decimal string on the 0.00001 tick, strictly between 0 and 1: `"0.55"`, never `"0.550"`, `".55"` or `0.55` | `NOT_CANONICAL`, `BAD_PRICE` |
| `s` | size as a canonical string of whole shares: `"20"`, never `"20.0"` | `NOT_CANONICAL`, `BAD_SIZE` |
| value | size x price at least 1 USDC. Exactly 1.00 passes (**[measured]** 2 shares at 0.5) | `MIN_VALUE` |
| `r` | `false` | `REDUCE_ONLY` |
| `t` | `{"limit":{"tif":"Alo"}}`: post-only | `TIF_NOT_ALLOWED` |
| `c` | your cloid, `0x` + 32 hex, lowercase in the hash. Use each cloid **once, ever**: Hyperliquid would take it again, but a read or a `cancelByCloid` by it then reaches only the latest order, so your order's `clear` would not clear it and would cancel the other **[measured]**. **"Once" is your promise, not something Skew enforces**: `CLOID_REUSED` covers only what the pool still remembers (the orders it holds, not those it has dropped or held before a restart), and the pool never sees what you send to Hyperliquid yourself. A leg whose cloid was used again ends `FAILED` / `CLOID_IN_USE` with what its own oid says filled, and what still rests is yours to cancel by that oid | `NO_CLOID`, `CLOID_REUSED` |
| `grouping` | `"na"` | `BAD_GROUPING` |
| `builder` | absent | `BUILDER_NOT_ALLOWED` |
| `vaultAddress` | absent or `null` (no vaults or sub-accounts in v1) | `VAULT_NOT_ALLOWED` |

Canonical means: no exponent, no sign, one `0` before a decimal point, no trailing zeros, no
trailing point. Hyperliquid hashes the strings as written, so `"0.55"` and `"0.550"` are two
different actions.

### 3.3 The `clear` action

```json
{"type":"cancelByCloid","cancels":[{"asset":100042420,"cloid":"0x736b65772d68656c642d766563746f01"}]}
```

Key order `type`, `cancels`; inside the cancel `asset`, `cloid`. Exactly one cancel, naming the
order's own asset and cloid (`BAD_CLEAR`, `CLEAR_MISMATCH`).

### 3.4 Nonces and `expiresAfter`

Each action is signed with its own **nonce** and its own **`expiresAfter`**, both unix milliseconds,
both inside the signed hash.

| | Rule | Refusal |
|---|---|---|
| `place.expiresAfter` | between `serverTime + 5 s` and `serverTime + 120 s`. Skew may relay the order until then | `EXPIRES_TOO_SOON`, `EXPIRES_TOO_LATE` |
| `clear.expiresAfter` | between `place.expiresAfter + 60 s`, so the cancel outlives the order, and `place.expiresAfter + 1 h` | `CLEAR_EXPIRES_TOO_SOON`, `CLEAR_EXPIRES_TOO_LATE` |
| both | present | `NO_EXPIRY` |
| nonces | different for `place` and `clear` | `SAME_NONCE` |
| nonces | between `serverTime - 47 h` and `serverTime + 23 h` | `NONCE_OUT_OF_WINDOW` |
| nonces | never used before by that signer in Skew's pool | `NONCE_USED` |

The limits are in the rules response (`minLifeMs`, `maxLifeMs`, `clearGraceMs`, `clearMaxMs`,
`nonceMaxAgeMs`, `nonceMaxAheadMs`) together with `serverTime`. Check your clock against
`serverTime`. Every bound is compared in whole milliseconds as you sent them: a time far in the
future, however large the number, is refused (`EXPIRES_TOO_LATE`, `CLEAR_EXPIRES_TOO_LATE`), never
folded back into range.

**[measured]** `expiresAfter` bounds when Hyperliquid *accepts* an action, not how long an order
rests: a post-only order whose `expiresAfter` passed while it rested was still open 20 s later. An
order's life on the book is ended by its cancel. An action that arrives after its `expiresAfter` is
answered `"Action already expired"`, its nonce is **spent**, and its signer's account is charged 5
requests. Skew therefore never sends an order with less than `sendMarginMs` (2 s) left before
`place.expiresAfter`.

### 3.5 The hash and the signature

This is Hyperliquid's ordinary L1 action signature with `expiresAfter` and no vault address:

```
connectionId = keccak256( msgpack(action) || uint64be(nonce) || 0x00 || 0x00 || uint64be(expiresAfter) )
digest       = EIP-712 hash of Agent{ source, connectionId }
               domain { name "Exchange", version "1", chainId 1337, verifyingContract 0x0 }
               source = "a" (Hyperliquid mainnet)
signature    = secp256k1 over digest: { r, s, v }, v 27 or 28
```

The first `0x00` says "no vault address"; the second precedes `expiresAfter`. Hyperliquid's Python
SDK does exactly this in `sign_l1_action(wallet, action, None, nonce, expires_after, is_mainnet)`.
Skew accepts `v` as 0/1 or 27/28 and normalises a high `s`; `r` and `s` may be minimal or padded hex.

A worked vector (the signer is the public anvil development key #2, never fund it; the full set is
`testdata/held_vectors.json`, which the Go and TypeScript clients both reproduce):

| | |
|---|---|
| network | Hyperliquid mainnet (`source` "a") |
| account and signer (the account's own key) | `0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc` |
| the order | book 16434, buy 1000 Yes at 0.09, post-only (`Alo`), cloid `0x736b65772d68656c642d766563746f04` |
| place nonce, expiresAfter | `1793966400006`, `1793966520000` |
| place signature | r `0xb0b08653d4a43698a76c77e1f77b626ea6c83d78023333bd30244a5d7d6bb679`, s `0x11aa90d94cb395a01c5f24830e14f55581c06b5c6785b913d99c02fb4fe4abe0`, v 27 |
| clear nonce, expiresAfter | `1793966400009`, `1793966580000` |
| clear signature | r `0xf248b8e0244cccf7cc7e7ec4e6e708bf070e8bdcd5596207dcd8ae5a69408d57`, s `0x1ea46a47c06a3d975eff3d300912bc23d03cd0f724f8062a9a90fad38ccc3e8e`, v 27 |
| Skew's order id | `0x3856ffcd3bbbcbe47c63b916837d98a7` |

### 3.6 The held order as the API takes it

```json
{
  "account": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "signer": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "place": {
    "action": {"type":"order","orders":[{"a":100164340,"b":true,"p":"0.09","s":"1000","r":false,"t":{"limit":{"tif":"Alo"}},"c":"0x736b65772d68656c642d766563746f04"}],"grouping":"na"},
    "nonce": 1793966400006,
    "signature": {"r":"0xb0b08653d4a43698a76c77e1f77b626ea6c83d78023333bd30244a5d7d6bb679","s":"0x11aa90d94cb395a01c5f24830e14f55581c06b5c6785b913d99c02fb4fe4abe0","v":27},
    "expiresAfter": 1793966520000
  },
  "clear": {
    "action": {"type":"cancelByCloid","cancels":[{"asset":100164340,"cloid":"0x736b65772d68656c642d766563746f04"}]},
    "nonce": 1793966400009,
    "signature": {"r":"0xf248b8e0244cccf7cc7e7ec4e6e708bf070e8bdcd5596207dcd8ae5a69408d57","s":"0x1ea46a47c06a3d975eff3d300912bc23d03cd0f724f8062a9a90fad38ccc3e8e","v":27},
    "expiresAfter": 1793966580000
  }
}
```

`account` is the Hyperliquid account that trades. `signer` is the address whose key signed both
actions: the account itself (you may then leave `signer` out) or an API wallet Hyperliquid lists
for it. Everything else is read from `place`. A `"vaultAddress": null` beside `nonce`, as
Hyperliquid's SDK writes it, is accepted.

What Skew stores and will relay for `place` is exactly:

```
{"action":{"type":"order","orders":[{"a":100164340,"b":true,"p":"0.09","s":"1000","r":false,"t":{"limit":{"tif":"Alo"}},"c":"0x736b65772d68656c642d766563746f04"}],"grouping":"na"},"nonce":1793966400006,"signature":{"r":"0xb0b08653d4a43698a76c77e1f77b626ea6c83d78023333bd30244a5d7d6bb679","s":"0x11aa90d94cb395a01c5f24830e14f55581c06b5c6785b913d99c02fb4fe4abe0","v":27},"expiresAfter":1793966520000}
```

## 4. The one rule about keys

Hyperliquid keeps, for each **signer**, its 100 highest nonces, and refuses any nonce lower than the
lowest of them. So a held action dies once its signer has landed 100 newer nonces.

**[measured]** A held action was accepted after 98 newer nonces of its signer and refused after
100: `"Invalid nonce: nonce too low 1793971939616 < 1793971939617"`. A nonce may be dated up to
about 23 h 58 min ahead of Hyperliquid's clock (`"Invalid nonce: nonce too high …"` past that). A
**future-dated** nonce survives the signer's other traffic: a cancel dated 20 h ahead still worked
after 101 newer ordinary nonces from the same signer, and ordinary nonces kept working afterwards.

A signer that sends ten actions a second buries an ordinary-dated held order in 10 seconds. You have
two ways to keep your held orders alive. Pick one.

**(a) A dedicated API wallet (simplest).** Approve one API wallet on your account and use it for
held orders and nothing else. Its nonces then move only when Skew relays something. An account has
1 unnamed and 3 named API wallet slots.

**(b) Your ordinary trading key, with nonces dated ahead.** Date the nonces of each held order
ahead of your clock by the order's whole life plus a small margin, that is, past
`clear.expiresAfter`:

```
place.nonce = clear.expiresAfter + 1000
clear.nonce = place.nonce + 1
```

Your ordinary traffic uses nonces near "now", which stay below these, so it cannot bury them.

A warning that follows from the rule and was **not** measured: every future-dated nonce that
*lands* sits in the signer's top-100 set. If 100 of them land while the clock is still behind them,
your ordinary nonces are refused as too low until the clock catches up. So date a nonce only as far
ahead as the order's own validity (about three minutes at the default lives), never hours.

If you do neither (ordinary nonces, on a key that also trades), a held order survives only 99 of
that key's other actions: **refresh every book before 50 of your own actions have gone out on the
signer**, and treat `NONCE_TOO_LOW` failures as your own. In every case refresh a book at least
every 30 seconds while you quote it: a refreshed book carries fresh nonces and current prices.

To make a held order impossible to send, without relying on Skew: sign a `noop` with the held
action's nonce and send it to Hyperliquid yourself. **[measured]** The held action then answers
`"Invalid nonce: duplicate nonce N"`. Withdrawing through the API (section 6.3) is the normal way;
the noop is the trustless one. A replay of an action that already landed is refused and costs
nothing.

If you replace an API wallet under the same name while orders signed by the old one are held,
Hyperliquid answers those orders **[measured]**
`"Must deposit before performing actions. User: <your account>"`. The words are misleading; Skew
reports it as `SIGNER_REVOKED`. Withdraw your books before you rotate a wallet.

## 5. The book update and `seq`

You update **one book at a time**. One call replaces **all** of your held orders on that book; your
other books are not touched.

- `seq` is yours: any number that grows per book. Unix milliseconds is the usual choice. A call
  whose `seq` is not greater than the book's last applied `seq` changes nothing (`STALE_SEQ`), so a
  delayed or re-ordered request can never overwrite a newer book.
- Each order gets its own **verdict**. One bad order does not fail the others.
- **Not strict** (the default): the accepted orders become the book's live set. Your previous live
  orders on the book are replaced **whether or not any new order was accepted**. If you meant to
  move your quotes and the new ones were refused, the old ones are gone: the safe direction.
- **Strict** (`"strict": true`): if any order is refused the whole update is refused
  (`STRICT_REFUSED`), nothing changes, your previous orders stay live and `seq` is not consumed.
- An order of the previous set sent again **unchanged** (the same signed bytes) is **kept** as it is
  (`"kept": true`). You only need to re-sign what changed. It is kept only while it still has the
  minimum life left: every order of an update passes the same checks, so an unchanged order with
  under 5 s to its `place.expiresAfter` is answered `EXPIRES_TOO_SOON` like a new one, and leaves the
  book with the update (it could no longer be sent anyway). Re-sign a level before its last 5 s.
- An order that was replaced or withdrawn cannot come back within the same epoch: for as long as it
  could still be sent (until its `place.expiresAfter`, however soon the pool forgets the rest of it)
  the same signed order is refused `NONCE_USED`.
- **After a restart (a new epoch) send every book again.** The pool is empty and every `seq` starts
  from 0, so any `seq` is accepted. You may send the very orders you had live, if they still have
  the minimum life left, or fresh ones. An order that Skew had already claimed for sending before
  the restart is not yours to send again: if you do, it is accepted into the pool and then ends
  `failed` with `NONCE_SPENT` when it would be sent; it is never sent twice.
- An update with no orders empties the book. On a book that is not open **and** that you never wrote
  to, it is refused like any other update (`BOOK_NOT_OPEN`): there is nothing of yours to empty.
- `seq` rises within an epoch. A book you have not written to for a day forgets its `seq` (it
  starts again from 0), and so does every book at a restart. Any growing number still works.
- If the pool as a whole is full (every maker's orders together, in memory), an update that carries
  orders is refused `POOL_FULL` and nothing changes; send it again in a minute. Withdraws and
  updates with no orders still apply.
- A claim given back unsent (`released`) makes the order live again only if nothing happened to it
  meanwhile. If you wrote the book it ends `replaced`: your last update is the book. If you withdrew
  every book, or Skew's operator switched you or the account off, it ends `withdrawn`. If its life
  ran out it ends `expired`.
- Orders the matcher has already claimed for sending are never touched by an update or a withdraw.
  They run to their end within seconds.
- Within one update, one account cannot stand on both sides at prices that would match each other (`SELF_CROSS`).
  **[measured]** Hyperliquid does not trade an account against itself: the resting order ends
  `selfTradeCanceled` and the other gets `"Order could not immediately match…"`.

A held order expires on its own at `place.expiresAfter`. A sweeper marks it `EXPIRED` within about a
second, but it is dead at that instant regardless: an expired order is never claimed.

Read the rules' `epoch` when you start, compare it on every heartbeat of the stream (section 6.5),
and treat a change, or a `reset` event with reason `POOL_EMPTY`, as "the pool is empty: send every
book again". A `reset` with reason `EVENTS_MISSED` does not mean that: section 6.5.

Lifecycle:

```
LIVE -> CLAIMED -> POSTED -> FILLED | PART_FILLED | CLEARED | FAILED(reason)
LIVE -> REPLACED | WITHDRAWN | EXPIRED
```

## 6. Endpoints

Base path `/api/v1/held/`. JSON in, JSON out. 64-bit integers come back as decimal strings
(`"seq": "1793966400000"`); you may send them as numbers or strings. Zero values and `false` are
omitted from responses. The same service is served over **gRPC on the same public host**
(`rfq.v1.HeldOrderService`, HTTP/2 over TLS, metadata key `x-skew-maker-key`), behind the same key
and the same limits as the REST paths. A book update may be up to 128 KB of JSON (64 orders are about 55 KB), and any other request 4 KB.

| Method | Path | |
|---|---|---|
| GET | `/api/v1/held/books/{book}/rules` | the rules, your limits, your `seq`, the server's clock |
| POST | `/api/v1/held/books/{book}/orders` | replace all your orders on the book |
| POST | `/api/v1/held/books/{book}/withdraw` | withdraw the book |
| POST | `/api/v1/held/withdraw` | withdraw a book (`{"book": N}`) or every book (`{"allBooks": true}`): the route with its own rate, never refused for your other traffic |
| GET | `/api/v1/held/orders` | list your orders |
| GET | `/api/v1/held/orders/{orderId}` | one order |
| GET | `/api/v1/held/events` | your event stream |
| GET | `/api/v1/held/openapi.json` | the OpenAPI document (no key needed) |

### 6.1 Rules

`GET /api/v1/held/books/4242/rules`

```json
{
  "book": 4242,
  "yesAsset": "100042420", "noAsset": "100042421", "yesCoin": "#42420", "noCoin": "#42421",
  "tick": "0.00001", "pxDecimals": 5,
  "minOrderValueMicro": "1000000",
  "hyperliquidChain": "Mainnet",
  "hyperliquidApi": "https://api.hyperliquid.xyz",
  "tifs": ["Alo"],
  "minLifeMs": "5000", "maxLifeMs": "120000", "clearGraceMs": "60000", "clearMaxMs": "3600000", "sendMarginMs": "2000",
  "nonceMaxAgeMs": "169200000", "nonceMaxAheadMs": "82800000",
  "limits": {"ordersPerBook": 16, "books": 200},
  "epoch": "9f2c1a7b3d5e8f01",
  "open": true,
  "serverTime": "2026-11-06T12:00:00Z",
  "makerId": "mk_292e7f34affd", "makerName": "maker-one",
  "accounts": ["0x70997970c51812dc3a010c7d01b50e0d17dc79c8"],
  "mode": "match"
}
```

`mode` is `match` where Skew matches and sends held orders, `ingest` where it only holds them.
`epoch` names this run of the pool (section 2): when it changes, send every book again. `seq`
appears once the book has been updated in this epoch. `open` false means the outcome is not one of Skew's
listed, unexpired markets, and an update with orders is refused (`BOOK_NOT_OPEN`); so is an update
with no orders, or a withdraw, on such a book if you never wrote to it. `expiry` is the market's
expiry when known. `capacityRule` true means the capacity rule is on (section 7); `limits` then also
carries your margin, `capacityMarginBps`, and, when a maximum applies to this book, `maxDepthMicro`
(micro-USDC, a decimal string). Skew reads its
market list from Hyperliquid every 15 s or so: a market listed a moment ago opens here within about
that time.

### 6.2 Replace a book

`POST /api/v1/held/books/4242/orders`

```json
{
  "seq": "1793966400000",
  "strict": false,
  "orders": [ { …the held order of section 3.6… }, { …a second held order… } ]
}
```

Response (HTTP 200):

```json
{
  "applied": true,
  "book": 4242,
  "seq": "1793966400000",
  "verdicts": [
    {"cloid": "0x736b65772d68656c642d766563746f01", "code": "ACCEPTED", "orderId": "0x874c1039678708dfbffdc548dc9ad276"},
    {"index": 1, "cloid": "0x736b65772d68656c642d766563746f02", "code": "ACCEPTED", "orderId": "0x6d084229d924202eafd2edf6b41890e8"}
  ],
  "live": [
    {
      "orderId": "0x874c1039678708dfbffdc548dc9ad276",
      "account": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      "signer": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
      "book": 4242, "asset": "100042420", "isBuy": true, "px": "0.55", "sz": "20", "tif": "Alo",
      "cloid": "0x736b65772d68656c642d766563746f01",
      "seq": "1793966400000", "state": "HELD_ORDER_STATE_LIVE",
      "validUntil": "2026-11-06T12:01:00Z", "clearUntil": "2026-11-06T12:02:00Z",
      "placeNonce": "1793966400000", "clearNonce": "1793966400001",
      "createdAt": "2026-11-06T12:00:00Z", "updatedAt": "2026-11-06T12:00:00Z"
    },
    { "orderId": "0x6d084229d924202eafd2edf6b41890e8", "side": 1, "asset": "100042421", "px": "0.43", "sz": "30", "…": "…" }
  ],
  "serverTime": "2026-11-06T12:00:00Z"
}
```

`verdicts` has one entry per order you sent, in order (`index` 0 is omitted). `orderId` is Skew's id
of an accepted order: the same signed bytes always have the same id. `live` is your whole live set
on the book after the call. No signature is ever returned.

The next update keeps the first order and sends one that is off the tick:

```json
{
  "applied": true,
  "book": 4242,
  "seq": "1793966400001",
  "verdicts": [
    {"cloid": "0x736b65772d68656c642d766563746f01", "code": "ACCEPTED", "kept": true, "orderId": "0x874c1039678708dfbffdc548dc9ad276"},
    {"index": 1, "cloid": "0x736b65772d68656c642d766563746f03", "code": "BAD_PRICE", "reason": "price \"0.612345\" is not on the 0.00001 tick"}
  ],
  "live": [ { "orderId": "0x874c1039678708dfbffdc548dc9ad276", "…": "…" } ],
  "replaced": ["0x6d084229d924202eafd2edf6b41890e8"]
}
```

An update refused as a whole is still HTTP 200, with `applied` absent and a `code`:

```json
{
  "book": 4242,
  "code": "STALE_SEQ",
  "reason": "seq 1793966400000 is not greater than the book's last applied seq 1793966400001: nothing changed",
  "seq": "1793966400001",
  "live": [ { "orderId": "0x874c1039678708dfbffdc548dc9ad276", "…": "…" } ]
}
```

A request carries at most 64 orders; your own limit is `limits.ordersPerBook`.

### 6.3 Withdraw

`POST /api/v1/held/withdraw` with `{"book": 4242}` (or `{"book": 4242, "seq": "…"}`), or the same body
without `book` on `POST /api/v1/held/books/4242/withdraw`:

```json
{"applied": true, "seq": "1793966400002", "withdrawn": ["0x874c1039678708dfbffdc548dc9ad276"]}
```

Without `seq` the book moves to its next `seq`; with one, it must be greater than the last applied
(`STALE_SEQ` otherwise). After a withdraw, an update still in flight under an older `seq` is stale.
`POST /api/v1/held/withdraw` with `{"allBooks": true}` withdraws every book. Prefer that path for a
book too: it has its own rate and is never refused for your other traffic (section 7), where the
per-book path shares the books' limits. A withdraw of a book
that is not open and that you never wrote to answers `"code": "BOOK_NOT_OPEN"`: there is nothing to
withdraw. A withdraw never needs Skew's market list or its Hyperliquid reads to be up: it works
when nothing else does.

### 6.4 List and get

`GET /api/v1/held/orders?book=4242&states=HELD_ORDER_STATE_LIVE&limit=100&pageToken=…&cloid=0x…`
returns `{"orders": […], "nextPageToken": "…"}`, newest first. `GET /api/v1/held/orders/{orderId}`
returns `{"order": {…}}`. Another maker's order is 404.

Read `nextPageToken`, not the size of the page: one call looks at no more than 2,048 of your orders,
so with a filter a page can hold fewer orders than `limit`, even none, and still carry a token. The
listing has ended when there is no token. A field with an empty value is not sent, on every route: a
listing of nothing is `{}`, a `seq` or a `cursor` of 0 and a `false` are absent.

These read the pool's memory. Orders that ended without being sent (replaced, withdrawn, expired)
stay readable for 2 minutes, orders that were sent for 10 minutes, and at most your last 4,096 ended
orders in all; after that an order is 404 (your fills are Hyperliquid's record, section 11).
Nothing of an earlier epoch is listed. `cloid=` searches the accounts on your allowlist (an account
uses a cloid once).

### 6.5 The event stream

`GET /api/v1/held/events?cursor=N&epoch=E&book=B` is a long-lived chunked response of
newline-delimited JSON, one event per line:

```
{"result":{"cursor":"1","type":"heartbeat","epoch":"9f2c1a7b3d5e8f01","time":"2026-11-06T12:00:00Z"}}
{"result":{"cursor":"2","type":"replaced","book":4242,"seq":"2","orders":[{"orderId":"0x…","cloid":"0x…","state":"HELD_ORDER_STATE_REPLACED"}],"time":"…"}}
{"result":{"cursor":"3","type":"accepted","book":4242,"seq":"2","orders":[{"orderId":"0x…","cloid":"0x…","state":"HELD_ORDER_STATE_LIVE"}],"time":"…"}}
```

| `type` | When | Carries |
|---|---|---|
| `heartbeat` | first message, then every 15 s while idle | the cursor to resume from, and the `epoch` it belongs to |
| `reset` | in place of the first heartbeat, or at any time | the stream cannot go on from your cursor. `resetReason` says why and what to do (below). Carries the `epoch` and the cursor to go on from |
| `accepted` | an update brought orders | the new orders (kept ones are not repeated) |
| `replaced` | an update replaced orders | the replaced orders |
| `withdrawn` | you (or Skew's operator) withdrew | the withdrawn orders |
| `expired` | `place.expiresAfter` passed | the expired orders |
| `claimed`, `released`, `posted`, `filled`, `part_filled`, `cleared`, `failed` | the matcher's steps | one order with its `oid`, `filledSz`, `reason` |

Cursors count **your** events from 1 without gaps **within an epoch**, and start again in each, so
once you have processed cursor `n` you have seen everything up to `n` of that epoch. Ignore event
types you do not know. Events reach the stream as they happen.

A cursor and its epoch are a **position**. Reconnect with `?cursor=n&epoch=E`, `E` being the epoch of
the last heartbeat (or reset) you saw, and the stream replays what came after it. A cursor means
nothing without its epoch: always send both. That holds at 0 too: a client that stood at cursor 0 of
this run (`?epoch=E`) gets everything it missed, or a reset if the feed no longer reaches that far.

**Neither a cursor nor an epoch means from now on: nothing is replayed**, whatever passed before you
connected. Use it to start. Never use it to reconnect: what passed while you were away is skipped, and
nothing tells you. To notice a restart when you start, compare the first heartbeat's `epoch` with the
one in the rules.

A **`reset`** comes in place of the first heartbeat, or on an open stream. It is not an error and the
stream goes on, from the cursor and under the epoch it carries. Its two reasons mean different things:

| `resetReason` | When | What it means | What to do |
|---|---|---|---|
| `POOL_EMPTY` | the epoch you sent is not this run's (Skew's engine restarted), or the pool was reset under an open stream | the pool holds **none** of the orders you sent before | **send every book again**; every `seq` starts from 0 |
| `EVENTS_MISSED` | your cursor is older than the events kept (ten minutes, and at most your last 4,096 events) because you fell behind or were away; or it is past the head; or it came **without its epoch**, so nobody can say which run it counts in | events cannot be sent to you, and **your orders may still be live** | read them (`GET /orders?states=HELD_ORDER_STATE_LIVE`), or send every book again, which is always safe |

Do not treat `EVENTS_MISSED` as "my orders are gone": they may still be matched.

You may hold 4 streams at once. Heartbeats arrive every 15 s; if you see none for 45 s, reconnect.
A stream ends on its own within about a second when its key is replaced or the maker disabled
(section 2): reconnect with the new key. It also ends, `UNAVAILABLE`, when Skew's engine stops
serving (a rollout, a lost database): reconnect with your cursor and epoch once it answers again.

Spell the path plainly. An encoded spelling of `/api/v1/held` (`/api/v1/%68eld/…`) is not a route of
this service: it answers 404.

### 6.6 Errors

Ordinary calls answer errors as:

```json
{"code": "UNAUTHENTICATED", "message": "authentication required",
 "details": [{"@type": "type.googleapis.com/rfq.v1.ErrorDetail", "reason": "UNAUTHENTICATED"}]}
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `INVALID_ARGUMENT` | the request itself is malformed: no `seq`, book 0, more than 64 orders, a declared body over its limit (section 7) |
| 400 | (none) | a body that cannot be parsed, or that did not arrive within 5 s of the headers, never reaches the service: the answer is `{"message": "…"}` alone, with no `code` and no `details` |
| 401 | `UNAUTHENTICATED` | no key, or one nobody has |
| 403 | `FORBIDDEN` | the maker is disabled; or, on a book update, the key was replaced a moment ago (401 follows within a second) |
| 404 | `NOT_FOUND` | no such order, or it is another maker's |
| 429 | `RATE_LIMITED` | a rate limit, or too many of your requests in flight; wait `details[0].retryAfterMs`. A call refused for a slot has spent no token |
| 429 | `TOO_MANY_STREAMS` | more than 4 streams of yours, or more than the service holds in all |
| 503 | `UNAVAILABLE` | Skew's engine is starting or restarting, or its market list or screening is down; or, on a book update alone, it has not been able to read its record of the makers for 30 s (a withdraw and the reads still work). Retry with backoff, then read the rules' `epoch` |

**A call is admitted, or refused, from its headers, before its body is read:** the key, your being
enabled, your requests in flight and your rate. Over REST the answer is the same either way. Over
**gRPC** a refusal at that door carries the status code and the message alone, with no details; the
reason and the wait are in the message: `[RATE_LIMITED] too many requests (held-write); retry in 50 ms`.
Refusals made after the body is read (the rate of one book) carry the details as well. A method that
is not exactly one of the service's (`/rfq.v1.HeldOrderService/ReplaceBookOrders`, with its leading
slash) is `UNIMPLEMENTED`. An admitted call has **5 s for its request to arrive and end**; past that it
is ended (`CANCELLED` over gRPC), and its slot is free again. Over gRPC that includes half-closing:
every standard client does so at once after its one message, but a hand-written one that keeps its
side of a call open is cut, a stream included.

On the **stream** path the refusals at that door have the ordinary shape above. What the stream itself
says, at its opening or when it ends, has the gateway's stream shape, under the same HTTP status when
nothing was sent yet: `{"error": {"message": "[TOO_MANY_STREAMS] …", "details": [{"reason":
"TOO_MANY_STREAMS"}]}}`. Read the reason from `details`.

A well-formed update that the pool declines is never an HTTP error: read `applied`, `code` and the
verdicts.

## 7. Limits

All limits are **per maker** (per API key). You are never limited by IP address, however many books
you update from one server.

| Limit | Default | Refusal |
|---|---|---|
| orders in one book update | 16 (at most 64) | `TOO_MANY_ORDERS` |
| books with live orders | 200 | `TOO_MANY_BOOKS` |
| one order's size | none | `SIZE_CAP` |
| one order's value | none | `NOTIONAL_CAP` |
| book updates, all books | 20 a second, burst 40 | 429 `RATE_LIMITED` |
| book updates of any one book | 5 a second, burst 10 | 429 `RATE_LIMITED` |
| reads (rules, list, get, opening a stream) | 20 a second, burst 60 | 429 `RATE_LIMITED` |
| withdraws | 20 a second, burst 40; only withdraws spend it | 429 `RATE_LIMITED` |
| a book update's size | 64 KB over gRPC, 128 KB of JSON over REST (64 orders are about 46 KB and 55 KB) | | `RESOURCE_EXHAUSTED`, 400 |
| any other request's size | 4 KB | | `RESOURCE_EXHAUSTED`, 400 |
| concurrent event streams | 4 | 429 `TOO_MANY_STREAMS` |
| the pool's orders in memory, every maker's together | 100,000 | `POOL_FULL` (update) |
| the margin on everything one account quotes (the capacity rule) | 1,000 bps, one tenth | `CAPACITY` |
| how deep one account stands on one book (the capacity rule) | its free USDC; less where a maximum is set for the market | `CAPACITY` |
| your requests in flight (admitted, not yet answered; a stream until its request has arrived) | 8, the last of them for withdraws alone | 429 `RATE_LIMITED` |
| every maker's requests in flight | 64; a withdraw is not held to it | 429 `RATE_LIMITED` |
| concurrent event streams, every maker's together | 64 | 429 `TOO_MANY_STREAMS` |

**Pulling your quotes.** A withdraw is the one call your own traffic cannot stop, however fast your
quoting runs and whatever is stuck. It has a rate of its own that nothing else spends: no book update,
read or book's rate is charged to it or can refuse it. The last of your slots is kept for withdraws, and
the cap on every maker's requests does not apply to them. `POST /api/v1/held/withdraw` pulls every book
in one call.

Skew's engine can refuse a withdraw for these reasons, and no others:

| Answer | Why | What to do |
|---|---|---|
| 429 `RATE_LIMITED` (`held-withdraw`) | you sent more than 20 withdraws a second, past a burst of 40 | wait `retryAfterMs` (50 ms), or withdraw every book in one call |
| 429 `RATE_LIMITED` (`held-in-flight-maker`) | all 8 of your slots are taken and the last by a withdraw of yours | retry: a stuck request gives its slot back within 5 s |
| 503 `UNAVAILABLE` | the engine is not serving: it is starting, or lost the pool. What it held is gone (section 2) and none of that is ever sent | retry, then read the `epoch` |
| 401, 403 | your key was replaced, or Skew's operator switched you off, which withdraws your orders itself | use the new key |

A claimed order cannot be pulled: it is already being sent, and runs to its end within seconds.

**To pull a quote through anything, use `POST /api/v1/held/withdraw`** (`{"book": N}` for one book): it and gRPC's `WithdrawBook` have their own rate and are never refused for your other traffic, while `/api/v1/held/books/{book}/withdraw` shares the books' limits (and can be answered 429 or 503 with no `code`).

Skew sets each maker's limits. A new maker starts on small ones (section 13), and Skew raises them
once you quote cleanly. Yours are in the rules response of each book. Re-sending an unchanged
order costs nothing against the pool's size: only orders new to the pool are held.

**Your IP address and your key.** The only per-IP limit counts calls whose key is **no maker's** (20
in a burst, then one a second, per IPv4 address or IPv6 /64): an
address that keeps sending such keys is refused with 429. A call with a maker's key **never reaches
that limit**: not on its first call, not from an address that is being refused for bad keys, not
whatever Skew's database is doing. Skew knows a key within about a second of issuing it; from then
on the statement holds without exception.

**Signers.** Whether a signer may sign for an account is asked of Hyperliquid (`userRole`) and
remembered (also across restarts of Skew's engine):

- a **yes** is fresh for 10 minutes. After that it keeps being honoured while Skew asks again in the
  background, and for at most 30 minutes after Hyperliquid last said yes if Hyperliquid cannot be
  asked. A wallet you revoke on Hyperliquid can therefore pass Skew's check for up to 30 minutes at
  worst; Hyperliquid itself refuses its orders (section 4).
- a **no** is remembered for 30 seconds. A wallet you approved a moment ago is asked about again at
  your first update after that, and the lookup is one of your new signers' (below): it is accepted
  from 30 seconds on, and within about a minute if nobody else is taking lookups.
- a signer Skew has **never seen** costs one lookup, the most expensive read Hyperliquid has. Until
  yours is made, that signer's orders are answered `SIGNER_CHECK_UNAVAILABLE`: send the update again
  a few seconds later. Nothing is wrong with the order.

What you can rely on for new signers:

| | |
|---|---|
| your first new signer | checked within seconds of asking, within about a minute when other makers are adding signers too |
| your next ones | one about every minute |
| another maker's new signers | are charged to that maker alone, and never take the lookups kept for signers that already sign |
| a signer with a yes | passes for 30 minutes after Hyperliquid last said yes, whatever anyone does with the lookups |

There is no queue. When **several** makers ask for new signers at once they can together take every
lookup, and yours then goes to whichever update asks first after one comes free: keep sending it.
A lookup that cannot be made now is answered the same `SIGNER_CHECK_UNAVAILABLE`.

Because a not-strict update replaces your book even when its orders are refused, **send the first
update under a new signer as `strict`**: a `SIGNER_CHECK_UNAVAILABLE` then leaves your previous
orders live instead of emptying the book. Tell Skew before you add signers in bulk.

**The capacity rule.** When it runs (`capacityRule` true in the rules), an order of value `a` on a
book is admitted while both hold, with `free` your account's free Hyperliquid spot USDC, `margin` your
`limits.capacityMarginBps` and `max` the book's `limits.maxDepthMicro` when the rules show one:

```
quoted on that book + a                       <= free, and <= max
(quoted on every book + a) x margin / 10,000  <= free
```

What your account has live, claimed or being sent counts as quoted; the orders an update replaces do
not. No book is ever deeper than `free`. At 1,000 bps (one tenth), 1,000 USDC quotes up to 1,000 on
each of ten books, or 250 on each of forty, and never more than 1,000 on one. Refusals: `CAPACITY`
(the reason names your account and the figures), `CAPACITY_UNAVAILABLE` (send the update again). Skew
reads your balance every few seconds and, while it cannot read it again, uses one up to a few minutes
old; whatever it read, Hyperliquid refuses at the send an order your account cannot pay
(`INSUFFICIENT_BALANCE`, section 10).

## 8. Verdict codes

Codes are stable; the `reason` text beside them is not. "order" codes are an order's verdict;
"update" codes refuse a whole update (the response's `code`).

| Code | Scope | Meaning |
|---|---|---|
| `ACCEPTED` | order | the order is live in the pool |
| `NOT_APPLIED` | order | the order passed every check, but its strict update was refused: nothing changed |
| `BAD_ORDER` | order | the entry is not a held order: no place, no clear, or an account or signer that is not an address |
| `ACCOUNT_NOT_ALLOWED` | order | the account is not on your allowlist (or was taken off it a moment ago): ask Skew to add it |
| `ACCOUNT_SCREENED` | order | the account cannot be served |
| `VAULT_NOT_ALLOWED` | order | an action names a vault address: v1 takes no vault or sub-account orders |
| `BAD_ACTION` | order | place.action is not an L1 order action of the expected shape (the reason names the field) |
| `BUILDER_NOT_ALLOWED` | order | place.action carries a builder field: held orders carry none |
| `BAD_GROUPING` | order | place.action's grouping is not "na" |
| `ORDER_COUNT` | order | place.action must carry exactly one order |
| `REDUCE_ONLY` | order | the order is reduce-only (r must be false) |
| `NO_CLOID` | order | the order has no cloid (c), or one that is not 0x + 32 hex |
| `TIF_NOT_ALLOWED` | order | the order's time in force is not Alo: a maker's held order is post-only |
| `WRONG_BOOK` | order | the order's asset is not one of the book's two assets |
| `NOT_CANONICAL` | order | the price or the size is not the canonical decimal string Hyperliquid hashes |
| `BAD_PRICE` | order | the price is off the 0.00001 tick or not strictly between 0 and 1 |
| `BAD_SIZE` | order | the size is not a positive whole number of shares |
| `MIN_VALUE` | order | the order's own value, size x price, is under 1 USDC |
| `SIZE_CAP` | order | the size is over your cap per order |
| `NOTIONAL_CAP` | order | the order's own value is over your cap per order |
| `BAD_CLEAR` | order | clear.action is not a cancelByCloid action with exactly one cancel |
| `CLEAR_MISMATCH` | order | the clear names another asset or another cloid than the order's |
| `NO_EXPIRY` | order | an action carries no expiresAfter: both must |
| `EXPIRES_TOO_SOON` | order | place.expiresAfter is closer than the minimum life (also an unchanged order sent again in its last 5 s) |
| `EXPIRES_TOO_LATE` | order | place.expiresAfter is further than the maximum life, however large the number |
| `CLEAR_EXPIRES_TOO_SOON` | order | clear.expiresAfter is under place.expiresAfter + the grace: the cancel must outlive the order |
| `CLEAR_EXPIRES_TOO_LATE` | order | clear.expiresAfter is over place.expiresAfter + the most a cancel may outlive its order (the rules' clearMaxMs, one hour) |
| `SAME_NONCE` | order | place and clear carry the same nonce: each action needs its own |
| `NONCE_OUT_OF_WINDOW` | order | a nonce is outside the window the pool takes (unix ms, at most 47 h behind and 23 h ahead of now) |
| `BAD_SIGNATURE` | order | a signature is malformed or does not recover |
| `SIGNER_MISMATCH` | order | a signature recovers to another address than the signer you named |
| `TOO_MANY_ORDERS` | order | the update carries more orders than your limit for one book |
| `SELF_CROSS` | order | the order would cross another order of the same account in this update: one account cannot be both sides |
| `NONCE_USED` | order | a (signer, nonce) is already taken in the pool, or twice in this update |
| `CLOID_REUSED` | order | the account already used this cloid in the pool, or twice in this update |
| `SIGNER_NOT_AUTHORIZED` | order | the signer is neither the account nor an API wallet Hyperliquid lists for it |
| `SIGNER_CHECK_UNAVAILABLE` | order | Hyperliquid could not be asked about the signer, or has not been asked yet: send the update again |
| `CAPACITY` | order | the capacity rule refused the order (only when the operator switched it on) |
| `CAPACITY_UNAVAILABLE` | order | the account's balance could not be read for the capacity rule: send the update again |
| `STALE_SEQ` | update | seq is not greater than the book's last applied seq: nothing changed |
| `STRICT_REFUSED` | update | the update was strict and at least one order was refused: nothing changed |
| `BOOK_NOT_OPEN` | update | the outcome is not one of Skew's listed, unexpired markets (also the answer to a withdraw of such a book you never wrote to) |
| `TOO_MANY_BOOKS` | update | you already hold live orders on as many books as you may |
| `POOL_FULL` | update | the pool stores as many orders as it may, every maker's together: nothing changed; send the update again in a minute (a withdraw and an update with no orders still apply) |

`SIGNER_MISMATCH` is the one you will meet first. Its usual causes, in order: signed for the other
network; `expiresAfter` left out of the hash, or not the value you sent; a number string that is not
canonical; the action hashed in another key order; the wrong key (name your API wallet as `signer`).

## 9. What "binding" means

A live held order is a firm quote. Skew may relay it **at any time before `place.expiresAfter`**,
without asking again. There is no last look.

To pull a quote: replace or withdraw the book, or let the order expire. To make it impossible to
send: the noop of section 4. Until one of those has happened the order can fill.

Skew intends to score each maker's **fill ratio**: of the orders Skew sent, how many Hyperliquid
accepted. An order that Hyperliquid refuses when sent (its nonce buried, its wallet rotated, its
balance gone) would count against you; so would an order you cancelled or revoked on Hyperliquid
while it was live here. Orders you replace, withdraw or let expire would not. **Intended, not yet in
force**: nothing scores it today. Each refusal is in your event stream (`failed`, with its `reason`).

A held order locks nothing on Hyperliquid until it is sent: your balance is yours to use. Keep
enough free USDC (or shares, for a sale) in the account to back what you quote.

## 10. What happens at a match

This section describes the matcher and the sender. The Hyperliquid facts in it were measured on
2026-11-06. The timings could differ.

1. A taker's order arrives that your quote can fill. The matcher **claims** your order (event
   `claimed`). One order is claimed at most once at a time.
2. Skew sends your `place` body first, or together with the taker's order. **[measured]**
   A post-only order and the taker's order sent together matched 60 of 60 times: post-only orders
   ran ahead of a taker's order sent up to 200 ms *earlier*. A pair took 0.87 s (median) sent
   together, 1.43 s when the post was awaited first.
3. Your order rests (event `posted`, with Hyperliquid's `oid`) and the taker's order trades against
   it. Your order rests on the public book for about a second: anyone may fill it at your price.
4. Skew sends your `clear` body for whatever is left. Outcome: `filled`, `part_filled` or `cleared`.
   **[measured]** A cancel for an order that already filled answers
   `"Order was never placed, already canceled, or filled. asset=…"`: harmless, 1 request.
5. If Hyperliquid refuses your order, the outcome is `failed` with a `reason`:

| `reason` | Hyperliquid's words **[measured]** | What it means for you |
|---|---|---|
| `NONCE_TOO_LOW` | `Invalid nonce: nonce too low A < B` | your signer landed 100 newer nonces (section 4) |
| `NONCE_SPENT` | `Invalid nonce: duplicate nonce N` | you revoked the order with a noop, or reused the nonce; also Skew's own answer, without sending, to an order it had already claimed for sending before a restart (section 5) |
| `NONCE_TOO_HIGH` | `Invalid nonce: nonce too high A > B` | the nonce was dated more than about 23 h 58 min ahead |
| `EXPIRED_AT_VENUE` | `Action already expired` | it reached Hyperliquid after `expiresAfter` (Skew's margin should prevent this) |
| `SIGNER_REVOKED` | `Must deposit before performing actions. User: …` or `User or API Wallet 0x… does not exist.` | the API wallet was replaced or removed |
| `POST_WOULD_CROSS` | `Post only order would have immediately matched. asset=…` | an order already rested at a price that would match yours; the nonce is spent, no retry |
| `MIN_VALUE` | `Order must have minimum value of 1 USDC. asset=…` | |
| `INSUFFICIENT_BALANCE` | (not probed) | the account could not pay when the order was sent |
| `HALTED`, `RATE_LIMITED`, `REFUSED` | (not probed) | the market is halted; your request budget is spent; anything else |
| `CLAIM_UNKNOWN` | (none: Skew's own) | Skew lost its database at the very moment it claimed the order and cannot say whether the claim was written. The order was **not sent**, and it ends rather than return to the book: send a fresh one |

**You should also cancel your own stragglers.** If you see one of your held-order cloids resting on
Hyperliquid for more than a few seconds, cancel it yourself. Skew's `clear` is the normal path; your
own cancel is the backstop if Skew is slow or down.

**A held post-only order cannot fill a user order that already rests on Hyperliquid's book at a
price that would match it** (`POST_WOULD_CROSS`). Resting user orders are on the public book: take them there
directly with your own non-post-only orders. Held orders are post-only in v1.

**Request budget.** **[measured]** Hyperliquid charges the **signer's account**: 1 request per order
or cancel (also for a refused post-only order and for a noop), 5 for an expired action, 0 for a
duplicate, a bad nonce or an altered body. A mint adds no volume to your request cap; closing
trades do. Your held orders spend your budget only when Skew sends them; an order that is held and
never sent costs nothing.

**Not possible on Hyperliquid [measured]:** two signers' actions in one HTTP request (a JSON array
of two signed payloads is HTTP 422). Skew sends your action and the taker's as two requests.

## 11. Fills and where to see them

A fill is an ordinary Hyperliquid fill on your account. Read it where you read every fill:
Hyperliquid's `userFills` (REST) or the `userFills` and `orderUpdates` WebSocket channels, matched
by your **cloid**. Skew's event stream tells you the outcome per order (`filled`, `part_filled` with
`filledSz`), but Hyperliquid is the record.

**[measured]** When a limit order fills in part, Hyperliquid's answer is only
`{"filled": {"totalSz", "avgPx"}}`; nothing says a remainder rests. Compare `totalSz` with the size,
or read open orders. Each resting level fills at its own price; `avgPx` is the blend.

Fees are Hyperliquid's, charged on your account. **[measured]** On Skew's markets, at the base fee
tier and Skew's deployer fee scale: opening 0, closing taker 14 bps, closing maker 8 bps.

## 12. One order per action

A `place` action carries exactly one order in v1, so each quote level is one held order and can be
matched on its own. **[measured]** for a later version: several post-only orders in one action all
rest from one request with one status each; one order under the 1 USDC minimum sinks the whole
action with a single status; an order that would cross is refused alone; one `cancelByCloid` may
list several cloids and answers per cloid.

## 13. Starting on mainnet, and a quick start

There is no test environment: Skew runs no staging deployment for makers. You start on production, on Hyperliquid mainnet, with small limits.

1. Skew gives you a key and the base URL, and adds your mainnet account addresses to your allowlist.
2. Your limits start small: few orders, a low size cap and a low capacity. The rules response of each
   book shows them (section 7).
3. Send your first orders to production at small sizes. The order must still be worth at least 1 USDC
   (section 3), so quote the smallest size that clears it.
4. Skew raises your limits once you quote cleanly. Ask when you need more.

`rules.hyperliquidApi` names the Hyperliquid API Skew relays to (`https://api.hyperliquid.xyz`).

With TypeScript (the maker SDK, `@skew-trade/sdk/maker`: `ts/src/maker.ts`, viem for
the key). It retries what is safe to repeat (a book update and a withdraw included, by their seq),
and its feed reopens itself from the cursor and epoch it last saw:

```ts
import { privateKeyToAccount } from "viem/accounts"
import { createMakerClient, randomCloid, signHeldOrder } from "@skew-trade/sdk/maker"

const wallet = privateKeyToAccount(process.env.HELD_WALLET_KEY as `0x${string}`) // an API wallet used for held orders only
const client = createMakerClient({ baseUrl: process.env.SKEW_API!, makerKey: process.env.SKEW_MAKER_KEY! })

const rules = await client.getBookRules(4242)
const now = Date.parse(rules.serverTime!)
const order = await signHeldOrder(
  {
    account: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    signer: wallet.address,
    book: 4242, side: 0, isBuy: true, px: "0.55", sz: "20",
    cloid: randomCloid(),
    nonce: Date.now(),
    expiresAfter: now + 60_000,
    clearExpiresAfter: now + 120_000,
    mainnet: true, // the deployment checks for Hyperliquid mainnet: rules.hyperliquidChain is "Mainnet"
  },
  (typedData) => wallet.signTypedData(typedData),
)
const res = await client.replaceBookOrders(4242, { seq: Date.now(), orders: [order] })
for (const v of res.verdicts ?? []) console.log(v.cloid, v.code, v.reason ?? "")
for await (const ev of client.watchOrders()) console.log(ev.cursor, ev.type)
```

With curl:

```sh
curl -s -H "X-Skew-Maker-Key: $SKEW_MAKER_KEY" "$SKEW_API/api/v1/held/books/4242/rules"
curl -s -H "X-Skew-Maker-Key: $SKEW_MAKER_KEY" -H 'Content-Type: application/json' \
     -d @update.json "$SKEW_API/api/v1/held/books/4242/orders"
curl -sN -H "X-Skew-Maker-Key: $SKEW_MAKER_KEY" "$SKEW_API/api/v1/held/events"
```

A checklist for the first accepted order:

1. `GET …/rules` answers 200 and lists your account.
2. Your clock is within a second of `serverTime`.
3. `p` and `s` are canonical strings; the value is at least 1 USDC.
4. `expiresAfter` is inside both hashes.
5. You sign for mainnet (`source` "a"), as `hyperliquidChain` says.
6. `signer` names the address whose key signed; Hyperliquid lists it for `account`.
7. The cloid and both nonces are new.
