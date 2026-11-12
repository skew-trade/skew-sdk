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
