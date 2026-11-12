/**
 * Held orders on the wire: what a maker's held order (./maker) and a user's (./helduser) share.
 *
 * A HELD ORDER is two Hyperliquid L1 actions its owner signs and does NOT send:
 *
 *  - `place`: an `order` action carrying exactly ONE limit order under a cloid (a maker's is
 *    post-only, tif Alo; a user's a normal limit order, tif Gtc);
 *  - `clear`: the `cancelByCloid` of that asset and cloid, under another nonce.
 *
 * Each carries its own nonce and `expiresAfter` inside the signed hash. Skew holds the two request
 * bodies and relays them to Hyperliquid byte for byte; it holds no key and can change nothing.
 *
 * This module is the part both sides build alike: the one-order action and its cancel exactly as
 * Hyperliquid hashes them (key order, canonical number strings, lowercase cloid), the signing of an
 * action with the phantom agent, and the JSON a signed action travels in (each half is the body
 * its signer would POST to Hyperliquid's /exchange). The Hyperliquid primitives are ./hl's.
 */

import {
  actionHash,
  asset as assetOf,
  checkValue,
  fromAsset,
  orderAction,
  parsePx,
  parseSz,
  phantomAgentTypedData,
  splitSignature,
  type Hex,
  type MsgValue,
  type OrderAction,
  type Side,
  type SignTypedData,
} from "./hl"

/** The `cancelByCloid` action: { type, cancels: [{ asset, cloid }] }, in the hashed key order. */
export interface CancelByCloidAction {
  readonly type: "cancelByCloid"
  readonly cancels: readonly { readonly asset: number; readonly cloid: string }[]
}

/** One signed action as the API takes it: Hyperliquid's own /exchange request body. */
export interface HeldSignedWire<A> {
  readonly action: A
  /** unix ms; a JSON number, as Hyperliquid takes it. */
  readonly nonce: number
  readonly signature: { readonly r: string; readonly s: string; readonly v: number }
  readonly expiresAfter: number
}

/** A signed held order: the account that trades, the address that signed, and the two halves. */
export interface SignedHeldOrder {
  readonly account: string
  readonly signer: string
  readonly place: HeldSignedWire<OrderAction>
  readonly clear: HeldSignedWire<CancelByCloidAction>
}

/**
 * A signer of Hyperliquid's phantom agent with its address: a viem account
 * (`privateKeyToAccount(agentKey)`) is one, and so is a wallet client's account given as
 * `{ address, signTypedData: (p) => walletClient.signTypedData({ account, ...p }) }`.
 */
export interface HeldSigner {
  readonly address: Hex
  readonly signTypedData: SignTypedData
}

const CLOID = /^0x[0-9a-fA-F]{32}$/u
const ADDRESS = /^0x[0-9a-fA-F]{40}$/u

/** A cloid a held order may carry: 0x + 32 hex, and not zero. */
export function isHeldCloid(cloid: string): boolean {
  return CLOID.test(cloid) && !/^0x0{32}$/u.test(cloid)
}

/** An EVM address: 0x + 40 hex. */
export function isAddress(v: string): v is Hex {
  return ADDRESS.test(v)
}

/** A random cloid (crypto.getRandomValues). */
export function randomCloid(): Hex {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  if (b.every((x) => x === 0)) b[15] = 1
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`
}

/** What the builder refuses about the order itself: a cloid it cannot carry, or no share at all. */
export type HeldOrderFault = "BAD_ORDER" | "BAD_SIZE"

/** The order of a held order before it is signed. Prices and sizes are the canonical strings Hyperliquid hashes. */
export interface HeldOrderTerms {
  /** The book: the outcome id. */
  readonly book: number
  /** The side of the book the order is on: 0 Yes, 1 No. */
  readonly side: Side
  readonly isBuy: boolean
  /** The limit, canonical ("0.55"), on the 0.00001 tick, strictly between 0 and 1. */
  readonly px: string
  /** The size, canonical ("20"), whole shares; size x px must be at least 1 USDC. */
  readonly sz: string
  /** The order's client order id, 0x + 32 hex: use each one once, ever. `randomCloid()` draws one. */
  readonly cloid: Hex
}

/**
 * The order action of a held order, exactly as Hyperliquid hashes it: { type: "order", orders:
 * [{ a, b, p, s, r: false, t: { limit: { tif } }, c }], grouping: "na" }. It refuses (HlRuleError)
 * a number that is not canonical, a price off the tick and a value under 1 USDC, and through
 * `refuse` a cloid that is missing, short or zero (BAD_ORDER) and an order of no share (BAD_SIZE).
 */
export function oneOrderAction(d: HeldOrderTerms, tif: "Alo" | "Gtc", refuse: (fault: HeldOrderFault, message: string) => Error): OrderAction {
  if (!isHeldCloid(d.cloid)) throw refuse("BAD_ORDER", `cloid ${d.cloid}: a held order needs a cloid of 0x + 32 hex (and not zero)`)
  const action = orderAction({ asset: assetOf(d.book, d.side), isBuy: d.isBuy, px: d.px, sz: d.sz, tif, cloid: d.cloid })
  const sz = parseSz(d.sz)
  if (sz === 0n) throw refuse("BAD_SIZE", "a held order needs at least one share")
  checkValue(sz, parsePx(d.px))
  return action
}

/** The cancelByCloid of a held order: the same asset and cloid as its order action. */
export function heldClearAction(asset: number, cloid: Hex): CancelByCloidAction {
  if (!isHeldCloid(cloid)) throw new TypeError(`cloid ${cloid}: a held order needs a cloid of 0x + 32 hex (and not zero)`)
  if (fromAsset(asset) === undefined) throw new TypeError(`asset ${asset} is no outcome side`)
  return { type: "cancelByCloid", cancels: [{ asset, cloid: cloid.toLowerCase() }] }
}

/** A positive unix ms that fits a JSON number, or a RangeError naming `what`. */
export function unixMs(v: bigint | number, what: string): number {
  const n = Number(v)
  if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError(`${what}: ${String(v)} is not a positive unix ms`)
  return n
}

/** The signature of one L1 action: the phantom agent over its hash with the nonce and expiresAfter, for the network. */
export function signL1Action(action: OrderAction | CancelByCloidAction, nonce: bigint | number, expiresAfter: bigint | number, mainnet: boolean, sign: SignTypedData): Promise<Hex> {
  return sign(phantomAgentTypedData(actionHash(action as unknown as MsgValue, nonce, expiresAfter), mainnet))
}

/**
 * One signed half as the API takes it: the action, its nonce and expiresAfter as JSON numbers, and
 * the 65-byte signature (r || s || v, as viem returns it) in Hyperliquid's { r, s, v } form (v 27 or
 * 28, low s).
 */
export function signedWire<A>(action: A, nonce: bigint | number, expiresAfter: bigint | number, signature: Hex, what: string): HeldSignedWire<A> {
  return { action, nonce: unixMs(nonce, `${what}.nonce`), signature: splitSignature(signature), expiresAfter: unixMs(expiresAfter, `${what}.expiresAfter`) }
}

/** A signer given as an account with its address, or as the bare signing function: the function. */
export function signerFunction(signer: HeldSigner | SignTypedData): SignTypedData {
  return typeof signer === "function" ? signer : (p) => signer.signTypedData(p)
}
