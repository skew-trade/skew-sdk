/**
 * Hyperliquid's L1 actions and HIP-4's rules, as the client needs them to sign held orders (a
 * user's, ./helduser, signed by the app's agent key; a maker's, ./maker):
 *
 *  - the HIP-4 rules (Go's internal/hip4): the ids of a market side, the 0.00001 price tick,
 *    whole-share sizes, the 1 USDC minimum on an order's own value;
 *  - CANONICAL number strings: Hyperliquid hashes px and sz as they are written, so "0.9" and
 *    "0.90" are two different actions, and a signature over the second recovers a stranger
 *    ("User or API Wallet ... does not exist");
 *  - the msgpack subset an order action needs, in Hyperliquid's key order;
 *  - the action hash, keccak256(msgpack(action) || be64(nonce) || 0x00 || 0x00 || be64(expiresAfter)),
 *    and the phantom agent { source: "a" mainnet | "b" testnet, connectionId: actionHash } as
 *    EIP-712 typed data under Hyperliquid's L1 domain ("Exchange", "1", 1337, 0x0);
 *  - the signature in the one canonical { r, s, v } form Hyperliquid takes.
 *
 * Every byte here is pinned to testdata/hl_order_vectors.json and testdata/hip4_vectors.json,
 * which the Go side generates and checks (internal/hip4), and the signature to
 * viem's signTypedData (hl.test.ts). Money is integer micro-USDC, sizes whole shares, prices
 * integer ticks: never a float.
 */

import { keccak_256 } from "@noble/hashes/sha3.js"
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js"

export type Hex = `0x${string}`

// ---------------------------------------------------------------- the rules' constants

/** An outcome side's asset id is ASSET_BASE + 10 x outcome + side. */
export const ASSET_BASE = 100_000_000
/** The spotBalance precompile reads an outcome side's balance at TOKEN_BASE + 10 x outcome + side. */
export const TOKEN_BASE = 100_000_000
/** Outcome-token wei per share (the precompile's unit). */
export const TOKEN_WEI_PER_SHARE = 100_000n
/** The price's decimal places: the tick is 0.00001. */
export const PX_DECIMALS = 5
/** The size's decimal places: whole shares. */
export const SZ_DECIMALS = 0
/** Ticks in 1 USDC: the price of a share that pays 1. */
export const TICKS = 100_000
/** Hyperliquid's smallest order, on the order's own value (size x limit price): 1 USDC. */
export const MIN_ORDER_VALUE_MICRO = 1_000_000n
/** One share at one tick, micro-USDC. */
export const MICRO_PER_TICK_SHARE = 10n
/** How far Hyperliquid's reference signer rounds a number before it normalizes it. */
export const CANONICAL_MAX_DECIMALS = 8

/** A binary outcome's side as Hyperliquid encodes it. */
export const YES = 0
export const NO = 1
export type Side = typeof YES | typeof NO

// ---------------------------------------------------------------- refusals

/**
 * The Hyperliquid rule a value or an order breaks: off the tick, not whole shares, a price outside
 * (0, 1), an order under the 1 USDC minimum (`value`; `user_value` for the order a user signs), or a
 * number that is not canonical.
 */
export type HlRule = "tick" | "size" | "price" | "value" | "user_value" | "number"

export class HlRuleError extends Error {
  constructor(
    readonly rule: HlRule,
    message: string,
  ) {
    super(message)
    this.name = "HlRuleError"
  }
}

// ---------------------------------------------------------------- ids

/** 10 x outcome + side. */
export function enc(outcome: number, side: Side): number {
  checkOutcome(outcome)
  return 10 * outcome + side
}

/** The order and cancel asset id of an outcome side. */
export function asset(outcome: number, side: Side): number {
  return ASSET_BASE + enc(outcome, side)
}

/** The book coin of an outcome side: "#<enc>". */
export function coin(outcome: number, side: Side): string {
  return `#${enc(outcome, side)}`
}

/** The balance name of an outcome side: "+<enc>". */
export function token(outcome: number, side: Side): string {
  return `+${enc(outcome, side)}`
}

/** An asset id's outcome and side, or undefined for one that is not an outcome side's. */
export function fromAsset(a: number): { outcome: number; side: Side } | undefined {
  if (!Number.isSafeInteger(a) || a < ASSET_BASE) return undefined
  const e = a - ASSET_BASE
  const side = e % 10
  if (side > 1) return undefined
  return { outcome: (e - side) / 10, side: side as Side }
}

function checkOutcome(outcome: number): void {
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 0xffffffff) throw new RangeError(`outcome ${outcome} is not a uint32`)
}

// ---------------------------------------------------------------- canonical decimal strings

/**
 * Units of 10^-decimals as the canonical decimal string Hyperliquid hashes: no exponent, no
 * sign, no trailing zeros and no trailing point ("45", "0.5", "0.00001").
 */
export function formatUnits(units: bigint, decimals: number): string {
  if (units < 0n) throw new RangeError(`a negative amount: ${units}`)
  let s = units.toString(10)
  if (decimals <= 0) return s
  if (s.length <= decimals) s = "0".repeat(decimals - s.length + 1) + s
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/u, "")
  return frac === "" ? whole : `${whole}.${frac}`
}

class TooPrecise extends Error {}

/**
 * Reads a plain non-negative decimal ("12", "0.5", ".5", "5.", "007.50") into units of
 * 10^-decimals, refusing anything else and any non-zero digit beyond `decimals` (Go's
 * hip4.parseDecimal, rule for rule).
 */
function parseDecimal(s: string, decimals: number): bigint {
  if (s === "") throw new Error("empty")
  const point = s.indexOf(".")
  const whole = point < 0 ? s : s.slice(0, point)
  let frac = point < 0 ? "" : s.slice(point + 1)
  if (whole === "" && frac === "") throw new Error("no digits")
  if (frac.includes(".")) throw new Error("two decimal points")
  if (!/^[0-9]*$/u.test(whole) || !/^[0-9]*$/u.test(frac)) throw new Error("not a plain decimal")
  if (frac.length > decimals) {
    if (/[1-9]/u.test(frac.slice(decimals))) throw new TooPrecise("more decimal places than allowed")
    frac = frac.slice(0, decimals)
  }
  frac += "0".repeat(decimals - frac.length)
  const n = BigInt((whole === "" ? "0" : whole) + frac)
  if (n >= 1n << 64n) throw new Error("out of range")
  return n
}

/**
 * A non-negative decimal string the way Hyperliquid's reference signer renders a number it
 * hashes (float_to_wire: at most 8 places, then normalized): "0.90" is "0.9", ".5" is "0.5",
 * "10.0" is "10". It refuses a sign, an exponent, a stray character and more than 8
 * significant decimal places.
 */
export function canonical(s: string): string {
  try {
    return formatUnits(parseDecimal(s, CANONICAL_MAX_DECIMALS), CANONICAL_MAX_DECIMALS)
  } catch (error) {
    throw new HlRuleError("number", `${JSON.stringify(s)} is not a canonical-able decimal: ${(error as Error).message}`)
  }
}

/** Whether s is already in canonical form. */
export function isCanonical(s: string): boolean {
  try {
    return canonical(s) === s
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- prices and sizes

/** A milli price (the markets feed's grid: 450 = 0.450) in ticks. */
export function pxFromMilli(milli: number): number {
  if (!Number.isInteger(milli) || milli < 0 || milli > 1000) throw new RangeError(`milli price ${milli}`)
  return milli * 100
}

/** A price in ticks as its canonical string ("0.9", "0.51234"). */
export function pxString(ticks: number): string {
  return formatUnits(BigInt(ticks), PX_DECIMALS)
}

/** The other side's price at the same merged level: 1 - p. */
export function complement(ticks: number): number {
  return ticks >= TICKS ? 0 : TICKS - ticks
}

/** Reads a decimal price into ticks, refusing one off the 0.00001 tick or outside (0, 1). */
export function parsePx(s: string): number {
  let u: bigint
  try {
    u = parseDecimal(s, PX_DECIMALS)
  } catch (error) {
    if (error instanceof TooPrecise) throw new HlRuleError("tick", `price ${JSON.stringify(s)} is not on the 0.00001 tick`)
    throw new HlRuleError("price", `price ${JSON.stringify(s)}: ${(error as Error).message}`)
  }
  if (u === 0n || u >= BigInt(TICKS)) throw new HlRuleError("price", `price ${JSON.stringify(s)} is not strictly between 0 and 1`)
  return Number(u)
}

/** Reads a decimal size, refusing a fraction of a share. */
export function parseSz(s: string): bigint {
  try {
    return parseDecimal(s, 0)
  } catch (error) {
    if (error instanceof TooPrecise) throw new HlRuleError("size", `size ${JSON.stringify(s)} is not a whole number of shares`)
    throw new HlRuleError("size", `size ${JSON.stringify(s)}: ${(error as Error).message}`)
  }
}

/** An order's own value, size x limit price, micro-USDC (exact: one share at one tick is 10). */
export function valueMicro(sz: bigint, ticks: number): bigint {
  return sz * BigInt(ticks) * MICRO_PER_TICK_SHARE
}

/** Refuses an order worth under Hyperliquid's 1 USDC on its own value. */
export function checkValue(sz: bigint, ticks: number): void {
  const v = valueMicro(sz, ticks)
  if (v < MIN_ORDER_VALUE_MICRO) {
    throw new HlRuleError("user_value", `${sz} shares at ${pxString(ticks)} is ${formatUnits(v, 6)} USDC, under the 1 USDC minimum order value`)
  }
}

// ---------------------------------------------------------------- msgpack

/**
 * An ordered map for msgpack: a plain object's string keys keep their insertion order (the
 * action's keys are never integer-like), which is the order Hyperliquid hashes.
 */
export type MsgMap = { readonly [key: string]: MsgValue }
export type MsgValue = null | boolean | string | number | bigint | readonly MsgValue[] | MsgMap

/**
 * The msgpack an L1 action hashes, as Go's internal/hl and Hyperliquid's reference SDK write
 * it: the shortest encoding of every integer and string length, maps and arrays by element
 * count. Integers must be safe non-negative numbers or bigints; a float is refused (amounts
 * are decimal strings).
 */
export function msgpack(v: MsgValue): Uint8Array {
  const out: number[] = []
  const be = (n: bigint, bytes: number) => {
    for (let i = bytes - 1; i >= 0; i -= 1) out.push(Number((n >> BigInt(8 * i)) & 0xffn))
  }
  const uint = (n: bigint) => {
    if (n < 0n) throw new RangeError(`msgpack: a negative integer (${n})`)
    if (n <= 0x7fn) out.push(Number(n))
    else if (n <= 0xffn) out.push(0xcc, Number(n))
    else if (n <= 0xffffn) (out.push(0xcd), be(n, 2))
    else if (n <= 0xffffffffn) (out.push(0xce), be(n, 4))
    else if (n < 1n << 64n) (out.push(0xcf), be(n, 8))
    else throw new RangeError(`msgpack: ${n} does not fit a uint64`)
  }
  const str = (s: string) => {
    const b = utf8ToBytes(s)
    const n = b.length
    if (n < 32) out.push(0xa0 | n)
    else if (n <= 0xff) out.push(0xd9, n)
    else if (n <= 0xffff) (out.push(0xda), be(BigInt(n), 2))
    else (out.push(0xdb), be(BigInt(n), 4))
    for (const x of b) out.push(x)
  }
  const header = (n: number, fix: number, b16: number, b32: number) => {
    if (n < 16) out.push(fix | n)
    else if (n <= 0xffff) (out.push(b16), be(BigInt(n), 2))
    else (out.push(b32), be(BigInt(n), 4))
  }
  const pack = (x: MsgValue) => {
    if (x === null) out.push(0xc0)
    else if (typeof x === "boolean") out.push(x ? 0xc3 : 0xc2)
    else if (typeof x === "string") str(x)
    else if (typeof x === "bigint") uint(x)
    else if (typeof x === "number") {
      if (!Number.isSafeInteger(x)) throw new RangeError(`msgpack: refusing ${x}: amounts are decimal strings`)
      uint(BigInt(x))
    } else if (Array.isArray(x)) {
      header(x.length, 0x90, 0xdc, 0xdd)
      for (const e of x as readonly MsgValue[]) pack(e)
    } else {
      const entries = Object.entries(x as MsgMap)
      header(entries.length, 0x80, 0xde, 0xdf)
      for (const [k, v] of entries) {
        str(k)
        pack(v)
      }
    }
  }
  pack(v)
  return Uint8Array.from(out)
}

// ---------------------------------------------------------------- the order action

/** One order of an order action, as Hyperliquid's reference SDK keys it (a, b, p, s, r, t, c). */
export interface OrderWire {
  readonly a: number
  readonly b: boolean
  readonly p: string
  readonly s: string
  readonly r: boolean
  readonly t: { readonly limit: { readonly tif: string } }
  readonly c?: string
}

/** The order action: { type: "order", orders, grouping: "na" }, in the hashed key order. */
export interface OrderAction {
  readonly type: "order"
  readonly orders: readonly OrderWire[]
  readonly grouping: string
}

/** What an order of the action says. px and sz must already be canonical. */
export interface Placement {
  readonly asset: number
  readonly isBuy: boolean
  readonly px: string
  readonly sz: string
  readonly reduceOnly?: boolean
  readonly tif: "Ioc" | "Alo" | "Gtc"
  readonly cloid?: Hex
}

/** The order action of one placement, exactly as Hyperliquid hashes it (it refuses a non-canonical number). */
export function orderAction(p: Placement): OrderAction {
  if (!isCanonical(p.px)) throw new HlRuleError("number", `px ${JSON.stringify(p.px)} is not canonical (${canonicalOr(p.px)})`)
  if (!isCanonical(p.sz)) throw new HlRuleError("number", `sz ${JSON.stringify(p.sz)} is not canonical (${canonicalOr(p.sz)})`)
  const o: OrderWire = { a: p.asset, b: p.isBuy, p: p.px, s: p.sz, r: p.reduceOnly ?? false, t: { limit: { tif: p.tif } } }
  return { type: "order", orders: [p.cloid === undefined ? o : { ...o, c: p.cloid.toLowerCase() }], grouping: "na" }
}

function canonicalOr(s: string): string {
  try {
    return `canonical: ${JSON.stringify(canonical(s))}`
  } catch (error) {
    return (error as Error).message
  }
}

/** The action as JSON, in the hashed key order: what action_json carries. */
export function actionJson(a: OrderAction): string {
  return JSON.stringify(a)
}

const u64be = (n: bigint): Uint8Array => {
  if (n < 0n || n >= 1n << 64n) throw new RangeError(`${n} does not fit a uint64`)
  const b = new Uint8Array(8)
  let rest = n
  for (let i = 7; i >= 0; i -= 1) {
    b[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return b
}

const hex = (b: Uint8Array): Hex => `0x${bytesToHex(b)}`

/**
 * The phantom agent's connectionId: keccak256(msgpack(action) || be64(nonce) || vault marker ||
 * [0x00 || be64(expiresAfter)]), the vault marker 0x00 (no vault) or 0x01 || vault address.
 */
export function actionHash(action: MsgValue, nonce: bigint | number, expiresAfter?: bigint | number, vault?: Hex): Hex {
  const parts = [msgpack(action), u64be(BigInt(nonce))]
  parts.push(vault === undefined ? new Uint8Array([0]) : concatBytes(new Uint8Array([1]), hexToBytes(vault.slice(2))))
  if (expiresAfter !== undefined) parts.push(new Uint8Array([0]), u64be(BigInt(expiresAfter)))
  return hex(keccak_256(concatBytes(...parts)))
}

/** Hyperliquid's L1 domain: the phantom agent is signed under chain 1337 on every network. */
export const L1_DOMAIN = { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" } as const

/** The phantom agent's type. */
export const AGENT_TYPES = {
  Agent: [
    { name: "source", type: "string" },
    { name: "connectionId", type: "bytes32" },
  ],
} as const

/** The phantom agent as a viem signTypedData payload: source "a" on mainnet, "b" on testnet. */
export function phantomAgentTypedData(connectionId: Hex, mainnet: boolean) {
  return {
    domain: L1_DOMAIN,
    types: AGENT_TYPES,
    primaryType: "Agent",
    message: { source: mainnet ? "a" : "b", connectionId },
  } as const
}

const DOMAIN_TYPE_HASH = keccak_256(utf8ToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))
const AGENT_TYPE_HASH = keccak_256(utf8ToBytes("Agent(string source,bytes32 connectionId)"))

function word(n: bigint): Uint8Array {
  const b = new Uint8Array(32)
  let rest = n
  for (let i = 31; i >= 0 && rest > 0n; i -= 1) {
    b[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return b
}

const L1_SEPARATOR = keccak_256(
  concatBytes(DOMAIN_TYPE_HASH, keccak_256(utf8ToBytes(L1_DOMAIN.name)), keccak_256(utf8ToBytes(L1_DOMAIN.version)), word(1337n), new Uint8Array(32)),
)

/** The EIP-712 digest an agent signs for an L1 action: what Hyperliquid recovers the signer from. */
export function l1Digest(connectionId: Hex, mainnet: boolean): Hex {
  const structHash = keccak_256(concatBytes(AGENT_TYPE_HASH, keccak_256(utf8ToBytes(mainnet ? "a" : "b")), hexToBytes(connectionId.slice(2))))
  return hex(keccak_256(concatBytes(new Uint8Array([0x19, 0x01]), L1_SEPARATOR, structHash)))
}

/** secp256k1's group order n: EIP-2 keeps s at most n / 2. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

/**
 * A 65-byte r || s || v signature as Hyperliquid's { r, s, v } in its one canonical form, the
 * one the edge stores and relays: r and s minimal 0x-hex, v 27 or 28 (0 or 1 mapped
 * up), and s in the lower half of the curve order (EIP-2: a high s becomes n - s with v flipped,
 * the same signature by the same signer).
 */
export function splitSignature(sig: Hex): { r: string; s: string; v: number } {
  if (!/^0x[0-9a-fA-F]{130}$/u.test(sig)) throw new TypeError(`not a 65-byte signature: ${sig}`)
  let v = Number.parseInt(sig.slice(130, 132), 16)
  if (v < 27) v += 27
  if (v !== 27 && v !== 28) throw new TypeError(`signature v=${v}`)
  const r = BigInt(`0x${sig.slice(2, 66)}`)
  let s = BigInt(`0x${sig.slice(66, 130)}`)
  if (r === 0n || r >= SECP256K1_N || s === 0n || s >= SECP256K1_N) throw new TypeError("signature r or s outside 1..n-1")
  if (s > SECP256K1_N / 2n) {
    s = SECP256K1_N - s
    v = 27 + 28 - v
  }
  return { r: `0x${r.toString(16)}`, s: `0x${s.toString(16)}`, v }
}

// ---------------------------------------------------------------- signing

/** What signs the phantom agent: viem's `signTypedData` (an account or a wallet client), or any signer of the same shape. */
export type SignTypedData = (payload: ReturnType<typeof phantomAgentTypedData>) => Promise<Hex>
