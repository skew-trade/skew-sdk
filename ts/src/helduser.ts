/**
 * Held orders: the USER's side.
 *
 * A user's held order is the same object a maker hands in (./heldwire says what they share), with
 * three differences:
 *
 *  - `place` carries ONE normal limit order (tif Gtc) with a cloid: what does not fill against
 *    the makers Skew pairs it with RESTS on Hyperliquid's book, in the user's own account;
 *  - it has a DEADLINE: when Skew sends the user's cancel for whatever still rests;
 *  - `clear`, the `cancelByCloid` of the order's asset and cloid, is signed with a nonce dated at
 *    the deadline, so that the signer's later actions cannot bury it (Hyperliquid keeps a
 *    signer's 100 highest nonces and refuses a lower one).
 *
 * The app signs both actions with the agent wallet it already keeps for the user's Hyperliquid
 * account and hands them to the edge; Skew relays the two request bodies byte for byte, holds no
 * key and can change nothing. Nothing is signed for Skew: no fee, no builder, no approval.
 *
 * The afternoon's integration, with `createRfqClient` (./rest):
 *
 *     const terms = await client.getUserHeldTerms(book)
 *     const clock = userHeldClock(terms)                    // the SERVER's clock from here on
 *     const draft = planUserHeldOrder(terms, { account, signer: agent.address, side: YES, isBuy: true,
 *       px: "0.55", sz: "10", deadlineMs: clock() + 3_600_000, nonce: nonces() }, clock())
 *     const request = await signUserHeldOrder(draft, agent)  // viem account, or (payload) => signature
 *     const answer = await client.placeUserHeldOrder(request)
 *     if (isUserHeldRefusal(answer)) show(answer.refusal.code) else follow(answer.order)
 *     for await (const u of client.watchUserHeldOrders({ cursor })) ...   // resumes by itself
 *
 * and when the user presses cancel, a cancel signed AT THAT MOMENT (an ordinary nonce, a minute to
 * live), which Skew relays; the pre-signed one stays for the deadline:
 *
 *     const cancel = await signUserHeldCancel(planUserHeldCancel(terms, order, clock(), { nonce: nonces() }), agent)
 *     const answer = await client.cancelUserHeldOrder(order.orderId, cancel)
 *
 *  - `planUserHeldOrder`: the four signed times from the terms answer (the server's clock, the
 *    bounds, the nonce rules); it refuses, with the edge's own code, what the edge would refuse;
 *  - `userHeldPlaceAction`, `heldClearAction` (./heldwire): the two actions as Hyperliquid hashes them;
 *  - `signUserHeldOrder`: signs both with an injected signer and returns the place's request body;
 *  - `planUserHeldCancel`, `signUserHeldCancel`: the cancel on request and the cancel route's body;
 *  - `userHeldOrderId`: the id the edge gives the order, known before the answer (placing the same
 *    signed bytes again answers the same order);
 *  - `userHeldOrder`: an order view with its numbers parsed and protobuf JSON's omitted zeros filled in.
 *
 * Every byte is pinned to testdata/held_user_vectors.json, which the Go side generates THROUGH the
 * edge: the requests there are what the app must send and
 * the answers what it gets.
 */

import { keccak_256 } from "@noble/hashes/sha3.js"
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"

import type {
  GetUserHeldTermsResponseJson,
  UserHeldOrderStateJson,
  UserHeldOrderViewJson,
  UserHeldRefusalJson,
} from "./gen/rfq/v1/held_pb"
import {
  heldClearAction,
  isAddress,
  isHeldCloid,
  oneOrderAction,
  randomCloid,
  signL1Action,
  signedWire,
  signerFunction,
  unixMs,
  type CancelByCloidAction,
  type HeldSignedWire,
  type HeldSigner,
  type SignedHeldOrder,
} from "./heldwire"
import { actionHash, asset as assetOf, parseSz, type Hex, type MsgValue, type OrderAction, type Side, type SignTypedData } from "./hl"

export type { HeldSigner } from "./heldwire"

// ---------------------------------------------------------------- the terms

/** The terms of one book with their numbers parsed (protobuf JSON writes 64-bit integers as strings). */
export interface UserHeldTerms {
  /** The outcome id. */
  readonly book: number
  readonly yesAsset: number
  readonly noAsset: number
  /** The network the signatures are checked for: it is inside the signed hash. */
  readonly mainnet: boolean
  /** The Hyperliquid API Skew relays to. */
  readonly hyperliquidApi: string
  /** place.expiresAfter - the server's clock: the bounds. minLifeMs also bounds deadline - clock. */
  readonly minLifeMs: number
  readonly maxLifeMs: number
  /** deadline - the server's clock: at most. */
  readonly maxDeadlineMs: number
  /** clear.expiresAfter - deadline: at least. */
  readonly cancelGraceMs: number
  /** A nonce's bounds around the server's clock. */
  readonly nonceMaxAgeMs: number
  readonly nonceMaxAheadMs: number
  /** No action is relayed with less than this before its expiresAfter. */
  readonly sendMarginMs: number
  /** The largest order, whole shares, and how many open held orders a user may have. */
  readonly maxShares: bigint
  readonly openOrders: number
  /** Whether the book takes orders now, and its expiry when known. */
  readonly open: boolean
  readonly expiryMs?: number
  /** The server's clock when it answered. */
  readonly serverTimeMs: number
  /** "await" or "together": how Skew sends a match. */
  readonly sendMode: string
}

function num(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/u.test(v) ? Number(v) : Number.NaN
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`the terms' ${what} is not a whole number: ${JSON.stringify(v)}`)
  return n
}

function time(v: unknown, what: string): number {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN
  if (!Number.isFinite(t)) throw new TypeError(`${what} is not a time: ${JSON.stringify(v)}`)
  return t
}

/** The terms answer with its numbers parsed. It refuses an answer that is not a terms answer. */
export function userHeldTerms(j: GetUserHeldTermsResponseJson): UserHeldTerms {
  if (j.hyperliquidChain !== "Mainnet" && j.hyperliquidChain !== "Testnet") {
    throw new TypeError(`the terms' hyperliquidChain is neither Mainnet nor Testnet: ${JSON.stringify(j.hyperliquidChain)}`)
  }
  if (!(j.tifs ?? []).includes("Gtc")) throw new TypeError(`the terms take no Gtc order: ${JSON.stringify(j.tifs)}`)
  return {
    book: num(j.book, "book"),
    yesAsset: num(j.yesAsset, "yesAsset"),
    noAsset: num(j.noAsset, "noAsset"),
    mainnet: j.hyperliquidChain === "Mainnet",
    hyperliquidApi: j.hyperliquidApi ?? "",
    minLifeMs: num(j.minLifeMs, "minLifeMs"),
    maxLifeMs: num(j.maxLifeMs, "maxLifeMs"),
    maxDeadlineMs: num(j.maxDeadlineMs, "maxDeadlineMs"),
    cancelGraceMs: num(j.cancelGraceMs, "cancelGraceMs"),
    nonceMaxAgeMs: num(j.nonceMaxAgeMs, "nonceMaxAgeMs"),
    nonceMaxAheadMs: num(j.nonceMaxAheadMs, "nonceMaxAheadMs"),
    sendMarginMs: num(j.sendMarginMs ?? "0", "sendMarginMs"),
    maxShares: BigInt(num(j.maxShares ?? "0", "maxShares")),
    openOrders: num(j.openOrders ?? 0, "openOrders"),
    open: j.open === true,
    ...(j.expiry === undefined ? {} : { expiryMs: time(j.expiry, "the terms' expiry") }),
    serverTimeMs: time(j.serverTime, "the terms' serverTime"),
    sendMode: j.sendMode ?? "",
  }
}

const parsed = (t: GetUserHeldTermsResponseJson | UserHeldTerms): UserHeldTerms => ("serverTimeMs" in t ? t : userHeldTerms(t))

/**
 * The SERVER's clock from a terms answer: a function giving unix ms on the server's clock, from
 * the answer's `serverTime` and what the local clock says passed since `receivedAtMs` (the local
 * time the answer arrived: call this as it arrives, or pass that time). Every bound of a held
 * order is checked against the server's clock, never the device's.
 */
export function userHeldClock(
  terms: GetUserHeldTermsResponseJson | UserHeldTerms,
  receivedAtMs: number = Date.now(),
  localNow: () => number = Date.now,
): () => number {
  const offset = parsed(terms).serverTimeMs - receivedAtMs
  return () => Math.trunc(localNow() + offset)
}

/**
 * Nonces that never repeat: the clock in ms, or one more than the last one given. Hyperliquid
 * takes a signer's nonce once and the edge claims each (NONCE_USED), so two actions signed in one
 * millisecond need two nonces. Keep ONE source per signing key, for everything that key signs.
 */
export function nonceSource(clock: () => number = Date.now): () => number {
  let last = 0
  return () => {
    last = Math.max(Math.trunc(clock()), last + 1)
    return last
  }
}

// ---------------------------------------------------------------- the plan

/** The life the planner gives the place when asked for none: at most the terms' maxLifeMs. */
export const DEFAULT_USER_HELD_LIFE_MS = 60_000

/**
 * What the planner refuses, under the code the edge would answer (`refusal.code`): BOOK_NOT_OPEN,
 * SIZE_CAP, EXPIRES_TOO_SOON, EXPIRES_TOO_LATE, DEADLINE_TOO_SOON, DEADLINE_TOO_LATE,
 * NONCE_OUT_OF_WINDOW, CANCEL_NONCE_AHEAD, WRONG_BOOK, BAD_ORDER, BAD_SIZE.
 */
export class UserHeldPlanError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "UserHeldPlanError"
  }
}

/** What the user wants: one limit order and when Skew cancels what still rests of it. */
export interface UserHeldIntent {
  /** The user's Hyperliquid account: the wallet the session is for. */
  readonly account: Hex
  /** The address whose key signs: the app's agent wallet for the account. Absent: the account itself. */
  readonly signer?: Hex
  /** The side of the book the order is on: 0 Yes, 1 No. */
  readonly side: Side
  readonly isBuy: boolean
  /** The limit, canonical ("0.55"), on the 0.00001 tick, strictly between 0 and 1. */
  readonly px: string
  /** The size, canonical ("10"), whole shares; size x px must be at least 1 USDC. */
  readonly sz: string
  /** When Skew cancels what still rests: unix ms on the SERVER's clock (`userHeldClock`). */
  readonly deadlineMs: number
  /** The order's client order id, 0x + 32 hex, used once, ever. Absent: a random one. */
  readonly cloid?: Hex
  /** The place's nonce (unix ms). Absent: the server's clock. Draw it from `nonceSource`. */
  readonly nonce?: number
  /** place.expiresAfter - the server's clock: how long Skew may send the order. Absent: 60 s. */
  readonly lifeMs?: number
}

/** A user's held order before it is signed: the order and the four signed times. */
export interface UserHeldDraft {
  readonly account: Hex
  readonly signer: Hex
  readonly book: number
  readonly side: Side
  readonly isBuy: boolean
  readonly px: string
  readonly sz: string
  readonly cloid: Hex
  /** The place's nonce and expiresAfter; the cancel's. All unix ms. */
  readonly nonce: number
  readonly expiresAfter: number
  readonly clearNonce: number
  readonly clearExpiresAfter: number
  /** When Skew cancels what still rests. */
  readonly deadlineMs: number
  readonly mainnet: boolean
}

function checkCloid(cloid: string): void {
  if (!isHeldCloid(cloid)) throw new UserHeldPlanError("BAD_ORDER", `cloid ${cloid}: a held order needs a cloid of 0x + 32 hex (and not zero)`)
}

/**
 * The order action of a user's held order, exactly as Hyperliquid hashes it: { type: "order",
 * orders: [{ a, b, p, s, r: false, t: { limit: { tif: "Gtc" } }, c }], grouping: "na" }. It
 * refuses (HlRuleError) a number that is not canonical, a price off the tick, a fraction of a
 * share and a value under 1 USDC.
 */
export function userHeldPlaceAction(d: Pick<UserHeldDraft, "book" | "side" | "isBuy" | "px" | "sz" | "cloid">): OrderAction {
  return oneOrderAction(d, "Gtc", (fault, message) => new UserHeldPlanError(fault, message))
}

/**
 * Plans a user's held order from the terms answer: the order as asked, and the four signed times
 * by the one rule every signer of one follows (the edge applies the same rule):
 *
 *     place.nonce        = the server's clock (or intent.nonce)
 *     place.expiresAfter = the server's clock + life (60 s, at most the terms' maxLifeMs)
 *     clear.expiresAfter = deadline + cancelGraceMs
 *     clear.nonce        = deadline + the cloid's last two bytes as a number (0..65535 ms), and
 *                          at most the server's clock + nonceMaxAheadMs
 *
 * `nowMs` is the SERVER's clock now (`userHeldClock(terms)()`); absent, the terms' own serverTime,
 * which is right only for terms fetched this instant. It throws UserHeldPlanError with the code
 * the edge would refuse with, and HlRuleError for a price or a size Hyperliquid would not take.
 */
export function planUserHeldOrder(termsIn: GetUserHeldTermsResponseJson | UserHeldTerms, intent: UserHeldIntent, nowMs?: number): UserHeldDraft {
  const terms = parsed(termsIn)
  const now = Math.trunc(nowMs ?? terms.serverTimeMs)
  if (!isAddress(intent.account)) throw new UserHeldPlanError("BAD_ORDER", `account: not an address: ${intent.account}`)
  const signer = intent.signer ?? intent.account
  if (!isAddress(signer)) throw new UserHeldPlanError("BAD_ORDER", `signer: not an address: ${signer}`)
  if (!terms.open) throw new UserHeldPlanError("BOOK_NOT_OPEN", `book ${terms.book} takes no orders now`)
  const cloid = intent.cloid ?? randomCloid()
  const order = { book: terms.book, side: intent.side, isBuy: intent.isBuy, px: intent.px, sz: intent.sz, cloid }
  const asset = userHeldPlaceAction(order).orders[0]?.a
  if (asset !== (intent.side === 0 ? terms.yesAsset : terms.noAsset)) throw new UserHeldPlanError("WRONG_BOOK", `asset ${asset} is not on book ${terms.book}`)
  if (terms.maxShares > 0n && parseSz(intent.sz) > terms.maxShares) {
    throw new UserHeldPlanError("SIZE_CAP", `${intent.sz} shares is over the cap of ${terms.maxShares} shares an order`)
  }
  const life = Math.trunc(intent.lifeMs ?? Math.min(DEFAULT_USER_HELD_LIFE_MS, terms.maxLifeMs))
  if (life < terms.minLifeMs) throw new UserHeldPlanError("EXPIRES_TOO_SOON", `a life of ${life} ms is under the least, ${terms.minLifeMs} ms`)
  if (life > terms.maxLifeMs) throw new UserHeldPlanError("EXPIRES_TOO_LATE", `a life of ${life} ms is over the most, ${terms.maxLifeMs} ms`)
  const deadline = intent.deadlineMs
  if (!Number.isSafeInteger(deadline) || deadline - now < terms.minLifeMs) {
    throw new UserHeldPlanError("DEADLINE_TOO_SOON", `the deadline is under ${terms.minLifeMs} ms from the server's clock`)
  }
  if (deadline - now > terms.maxDeadlineMs) {
    throw new UserHeldPlanError("DEADLINE_TOO_LATE", `the deadline is over ${terms.maxDeadlineMs} ms ahead of the server's clock: sign again for longer`)
  }
  const nonce = intent.nonce ?? now
  if (!Number.isSafeInteger(nonce) || nonce <= 0 || nonce < now - terms.nonceMaxAgeMs || nonce > now + terms.nonceMaxAheadMs) {
    throw new UserHeldPlanError("NONCE_OUT_OF_WINDOW", `place.nonce ${nonce} is outside the window around the server's clock`)
  }
  const clearNonce = Math.min(deadline + Number.parseInt(cloid.slice(-4), 16), now + terms.nonceMaxAheadMs)
  if (clearNonce < deadline) {
    throw new UserHeldPlanError("DEADLINE_TOO_LATE", "the deadline is past the furthest nonce Hyperliquid takes: sign again for longer")
  }
  return {
    account: intent.account,
    signer,
    ...order,
    nonce,
    expiresAfter: now + life,
    clearNonce,
    clearExpiresAfter: deadline + terms.cancelGraceMs,
    deadlineMs: deadline,
    mainnet: terms.mainnet,
  }
}

// ---------------------------------------------------------------- signing

/** A user's held order as the API takes it: each half is the body its signer would POST to Hyperliquid's /exchange. */
export type UserHeldOrderWire = SignedHeldOrder

/** The body of POST /api/v1/rfq/held/orders. */
export interface PlaceUserHeldOrderWire {
  readonly order: UserHeldOrderWire
  /** When Skew cancels what still rests: unix ms, a decimal string (protobuf JSON's 64-bit form). */
  readonly deadlineMs: string
}

/**
 * Builds and signs a planned order: the Gtc limit order and the cancel of its cloid, each hashed
 * with its own nonce and expiresAfter for the draft's network and signed by `signer`: an account
 * with its address (the app's agent wallet: a viem account, or anything shaped like `HeldSigner`),
 * or the bare signing function. No raw key is taken. The answer is the place's request body.
 *
 * A signer given with its address must be the draft's signer: the edge recovers the address from
 * the signature and refuses another (SIGNER_MISMATCH).
 */
export async function signUserHeldOrder(d: UserHeldDraft, signer: HeldSigner | SignTypedData): Promise<PlaceUserHeldOrderWire> {
  const sign = signerFunction(signer)
  if (typeof signer !== "function" && signer.address.toLowerCase() !== d.signer.toLowerCase()) {
    throw new TypeError(`the signer is ${signer.address}, the draft was planned for ${d.signer}`)
  }
  if (!isAddress(d.account)) throw new TypeError(`account: not an address: ${d.account}`)
  if (!isAddress(d.signer)) throw new TypeError(`signer: not an address: ${d.signer}`)
  const nonce = unixMs(d.nonce, "place.nonce")
  const clearNonce = unixMs(d.clearNonce, "clear.nonce")
  const expiresAfter = unixMs(d.expiresAfter, "place.expiresAfter")
  const clearExpiresAfter = unixMs(d.clearExpiresAfter, "clear.expiresAfter")
  const deadline = unixMs(d.deadlineMs, "deadlineMs")
  if (nonce === clearNonce) throw new RangeError("place and clear need different nonces")
  if (clearNonce < deadline) throw new RangeError("clear.nonce must be at or past the deadline")
  const place = userHeldPlaceAction(d)
  const clear = heldClearAction(assetOf(d.book, d.side), d.cloid)
  const placeSig = await signL1Action(place, nonce, expiresAfter, d.mainnet, sign)
  const clearSig = await signL1Action(clear, clearNonce, clearExpiresAfter, d.mainnet, sign)
  return {
    order: {
      account: d.account.toLowerCase(),
      signer: d.signer.toLowerCase(),
      place: signedWire(place, nonce, expiresAfter, placeSig, "place"),
      clear: signedWire(clear, clearNonce, clearExpiresAfter, clearSig, "clear"),
    },
    deadlineMs: String(deadline),
  }
}

// ---------------------------------------------------------------- the cancel on request

/** A cancel on request before it is signed: the order's asset and cloid, and the two signed times. */
export interface UserHeldCancelDraft {
  readonly asset: number
  readonly cloid: Hex
  /** The cancel's nonce and expiresAfter, unix ms. */
  readonly nonce: number
  readonly expiresAfter: number
  readonly mainnet: boolean
}

/** The body of POST /api/v1/rfq/held/orders/{orderId}/cancel. */
export interface CancelUserHeldOrderWire {
  /** The cancelByCloid signed now: the body its signer would POST to Hyperliquid's /exchange. */
  readonly cancel: HeldSignedWire<CancelByCloidAction>
  /** The address that signed it. Left out: the order's own signer. */
  readonly signer?: string
}

/**
 * Plans the cancel of one of the user's orders, to be signed NOW: the user is at
 * the app, so the cancel carries an ordinary nonce and a short life, and Skew relays it as soon as
 * the order rests. (The cancel the order was placed with is dated at the deadline; sent early it
 * would sit among the signer's 100 highest nonces.) The edge applies the same rule:
 *
 *     cancel.nonce        = the server's clock (or o.nonce, from `nonceSource`)
 *     cancel.expiresAfter = the server's clock + life (60 s, at most the terms' maxLifeMs)
 *
 * `order` is the order's view, or its asset and cloid. `nowMs` is the SERVER's clock now
 * (`userHeldClock(terms)()`); absent, the terms' own serverTime, right only for terms fetched this
 * instant. Sign a NEW cancel for every press: an expired one is refused (EXPIRES_TOO_SOON).
 */
export function planUserHeldCancel(
  termsIn: GetUserHeldTermsResponseJson | UserHeldTerms,
  order: { readonly asset?: number | string; readonly cloid?: string },
  nowMs?: number,
  o: { readonly nonce?: number; readonly lifeMs?: number } = {},
): UserHeldCancelDraft {
  const terms = parsed(termsIn)
  const now = Math.trunc(nowMs ?? terms.serverTimeMs)
  const asset = Number(order.asset)
  if (asset !== terms.yesAsset && asset !== terms.noAsset) throw new UserHeldPlanError("WRONG_BOOK", `asset ${String(order.asset)} is not on book ${terms.book}`)
  const cloid = String(order.cloid ?? "")
  checkCloid(cloid)
  const life = Math.trunc(o.lifeMs ?? Math.min(DEFAULT_USER_HELD_LIFE_MS, terms.maxLifeMs))
  if (life < terms.minLifeMs) throw new UserHeldPlanError("EXPIRES_TOO_SOON", `a life of ${life} ms is under the least, ${terms.minLifeMs} ms`)
  if (life > terms.maxLifeMs) throw new UserHeldPlanError("EXPIRES_TOO_LATE", `a life of ${life} ms is over the most, ${terms.maxLifeMs} ms`)
  const nonce = o.nonce ?? now
  if (!Number.isSafeInteger(nonce) || nonce <= 0 || nonce < now - terms.nonceMaxAgeMs) {
    throw new UserHeldPlanError("NONCE_OUT_OF_WINDOW", `cancel.nonce ${nonce} is outside the window around the server's clock`)
  }
  if (nonce > now + terms.maxLifeMs) {
    throw new UserHeldPlanError("CANCEL_NONCE_AHEAD", `cancel.nonce ${nonce} is dated ahead of the server's clock: a cancel on request is signed with the current time`)
  }
  return { asset, cloid: cloid.toLowerCase() as Hex, nonce, expiresAfter: now + life, mainnet: terms.mainnet }
}

/**
 * Signs a planned cancel with `signer` (the app's agent wallet: an account with its address, or
 * the bare signing function) and returns the cancel route's body. A signer given with its address
 * is named in the request, so a cancel signed by a NEWER agent wallet of the account than the one
 * that signed the order is taken too (Hyperliquid must list it: SIGNER_NOT_AUTHORIZED otherwise).
 */
export async function signUserHeldCancel(d: UserHeldCancelDraft, signer: HeldSigner | SignTypedData): Promise<CancelUserHeldOrderWire> {
  const sign = signerFunction(signer)
  const nonce = unixMs(d.nonce, "cancel.nonce")
  const expiresAfter = unixMs(d.expiresAfter, "cancel.expiresAfter")
  const action = heldClearAction(d.asset, d.cloid)
  const cancel = signedWire(action, nonce, expiresAfter, await signL1Action(action, nonce, expiresAfter, d.mainnet, sign), "cancel")
  return typeof signer === "function" ? { cancel } : { cancel, signer: signer.address.toLowerCase() }
}

const ORDER_ID_TAG = utf8ToBytes("skew-held-order-v1")

/**
 * The id the edge gives a held order: the first 16 bytes of keccak256("skew-held-order-v1" ||
 * signer || the place action's hash). The same signed bytes always have the same id, so the app
 * knows it before the answer and placing them again is safe.
 */
export function userHeldOrderId(order: Pick<UserHeldOrderWire, "signer" | "place">): Hex {
  const placeHash = actionHash(order.place.action as unknown as MsgValue, order.place.nonce, order.place.expiresAfter)
  const h = keccak_256(concatBytes(ORDER_ID_TAG, hexToBytes(order.signer.slice(2)), hexToBytes(placeHash.slice(2))))
  return `0x${bytesToHex(h.slice(0, 16))}`
}

// ---------------------------------------------------------------- the answers

/**
 * Narrows a place's or a cancel's answer to the refusal: a stable `code` and a sentence. Nothing
 * was recorded (a declined cancel leaves the order as it was: sign again and ask again).
 */
export function isUserHeldRefusal<R extends { refusal?: UserHeldRefusalJson }>(r: R): r is R & { refusal: UserHeldRefusalJson & { code: string } } {
  return r.refusal !== undefined && typeof r.refusal.code === "string" && r.refusal.code !== ""
}

/** The states an order ends in: nothing more will change. */
export const USER_HELD_ENDED: ReadonlySet<UserHeldOrderStateJson> = new Set<UserHeldOrderStateJson>([
  "USER_HELD_ORDER_STATE_FILLED",
  "USER_HELD_ORDER_STATE_CANCELLED",
  "USER_HELD_ORDER_STATE_REJECTED",
  "USER_HELD_ORDER_STATE_EXPIRED",
  "USER_HELD_ORDER_STATE_LAPSED",
])

/** One maker order of the match as the user sees it. */
export interface UserHeldFill {
  /** The price on the user's own asset. */
  readonly px: string
  /** What filled of the leg, by anyone: the same as filledSz (the maker's order size is not shown). */
  readonly sz: bigint
  readonly filledSz: bigint
  /** posted, filled, part_filled, cleared, failed or released. */
  readonly state: string
}

/** A user's held order with its numbers parsed and protobuf JSON's omitted zeros filled in. */
export interface UserHeldOrder {
  readonly orderId: string
  readonly account: string
  readonly signer: string
  readonly book: number
  readonly asset: number
  readonly side: Side
  readonly isBuy: boolean
  readonly px: string
  readonly sz: bigint
  readonly tif: string
  readonly cloid: string
  readonly state: UserHeldOrderStateJson
  /**
   * True once nothing more will change, but for one case: with the reason PLACE_UNKNOWN, fills that show
   * later correct the order (to FILLED, or CANCELLED with filledSz), as one more change in the feed.
   */
  readonly ended: boolean
  /**
   * REJECTED, EXPIRED, CANCELLED, LAPSED: why, one stable word, and the sentence. Also on CANCELLING
   * with PLACE_UNKNOWN: Skew had no answer for the order, and its cancel is settling whether it rests.
   * Ended with PLACE_UNKNOWN (EXPIRED or CANCELLED): that cancel found nothing open and no fill shows so
   * far, which does not say the order never reached Hyperliquid. LAPSED: CANCEL_LAPSED, CANCEL_REFUSED,
   * or CLOID_REUSED, when the user used the order's cloid again on Hyperliquid and a cancel by it would
   * reach that other order. `detail` says how to end it, and may be set on a FILLED that fills corrected.
   */
  readonly reason: string
  readonly detail: string
  /** Whether the order was relayed to Hyperliquid, when, and Hyperliquid's order id. */
  readonly sent: boolean
  readonly sentAtMs?: number
  readonly oid?: string
  /** Whole shares filled, their average price, and what rests on Hyperliquid in the user's account. */
  readonly filledSz: bigint
  readonly avgPx: string
  readonly restingSz: bigint
  /** When Skew cancels what rests; place.expiresAfter; clear.expiresAfter. */
  readonly deadlineMs: number
  readonly validUntilMs: number
  readonly clearUntilMs: number
  readonly cancelRequested: boolean
  /** "await" or "together", once matched. */
  readonly mode: string
  readonly fills: readonly UserHeldFill[]
  readonly createdAtMs: number
  readonly updatedAtMs: number
  /** The position of the order's last change in the user's stream. */
  readonly cursor: string
}

const whole = (v: string | undefined): bigint => (v === undefined || v === "" ? 0n : BigInt(v))

/** An order view as the edge writes it (a zero, a false and an empty string are left out there), read in full. */
export function userHeldOrder(v: UserHeldOrderViewJson): UserHeldOrder {
  const state = v.state ?? "USER_HELD_ORDER_STATE_UNSPECIFIED"
  return {
    orderId: v.orderId ?? "",
    account: v.account ?? "",
    signer: v.signer ?? "",
    book: v.book ?? 0,
    asset: Number(v.asset ?? "0"),
    side: (v.side ?? 0) === 1 ? 1 : 0,
    isBuy: v.isBuy === true,
    px: v.px ?? "",
    sz: whole(v.sz),
    tif: v.tif ?? "",
    cloid: v.cloid ?? "",
    state,
    ended: USER_HELD_ENDED.has(state),
    reason: v.reason ?? "",
    detail: v.detail ?? "",
    sent: v.sent === true,
    ...(v.sentAt === undefined ? {} : { sentAtMs: time(v.sentAt, "sentAt") }),
    ...(v.oid === undefined || v.oid === "0" ? {} : { oid: v.oid }),
    filledSz: whole(v.filledSz),
    avgPx: v.avgPx ?? "",
    restingSz: whole(v.restingSz),
    deadlineMs: time(v.deadline, "deadline"),
    validUntilMs: time(v.validUntil, "validUntil"),
    clearUntilMs: time(v.clearUntil, "clearUntil"),
    cancelRequested: v.cancelRequested === true,
    mode: v.mode ?? "",
    fills: (v.fills ?? []).map((f) => ({ px: f.px ?? "", sz: whole(f.sz), filledSz: whole(f.filledSz), state: f.state ?? "" })),
    createdAtMs: time(v.createdAt, "createdAt"),
    updatedAtMs: time(v.updatedAt, "updatedAt"),
    cursor: v.cursor ?? "0",
  }
}
