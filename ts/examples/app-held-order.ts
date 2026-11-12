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
