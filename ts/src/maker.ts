/**
 * @skew-trade/sdk/maker: the maker SDK for Skew's held pool
 * (docs/MAKER-SPEC.md).
 *
 * A maker's HELD ORDER is two Hyperliquid L1 actions the maker signs and does NOT send:
 *
 *  - `place`: an `order` action carrying exactly ONE post-only order (tif Alo) with a cloid;
 *  - `clear`: the `cancelByCloid` of that asset and cloid, under another nonce.
 *
 * Both carry `expiresAfter` inside the signed hash. Skew holds the two request bodies and may
 * relay them to Hyperliquid, byte for byte, until `place.expiresAfter`; it holds no key and can
 * change nothing. A maker hands in ALL of its orders for ONE book at a time
 * (`replaceBookOrders`), under a `seq` that grows per book.
 *
 *  - `heldPlaceAction`, `heldClearAction`: the two actions exactly as Hyperliquid hashes them
 *    (key order, canonical number strings, lowercase cloid);
 *  - `signHeldOrder`: signs both with the key that already signs the maker's Hyperliquid orders
 *    (the account's own, or one of its API wallets) and returns `heldOrder`'s JSON;
 *  - `heldOrder`: the exact JSON the API takes for one order: `place` and `clear` are each the
 *    body their signer would POST to Hyperliquid's /exchange;
 *  - `createMakerClient`: the client of the endpoints under /api/v1/held/: the book's rules, a
 *    book update, a withdraw, the orders, one order, and the event feed (reconnecting, resumed by
 *    cursor and epoch). The maker's API key travels in X-Skew-Maker-Key; no session.
 *
 * RETRIES (./http), by what is safe to repeat, as the Go maker client's table:
 *  - 429 (RATE_LIMITED, TOO_MANY_STREAMS): every call, after the wait the edge asked for;
 *  - a network error, a timeout, 502/503/504: the reads, a book update (its seq must grow per
 *    book: a repeat of an update that was applied is answered STALE_SEQ and changes nothing,
 *    which `appliedEarlier` reports) and a withdraw (with no seq, a repeat withdraws what is left,
 *    which is what was asked). A withdraw gets more attempts than anything else
 *    (`withdrawAttempts`): a maker must always be able to pull its orders;
 *  - never: UNAUTHENTICATED (a key the edge does not know costs the caller's address a token of
 *    the edge's bad-key bucket), FORBIDDEN, INVALID_ARGUMENT, NOT_FOUND.
 *
 * Every byte that is signed is pinned to testdata/held_vectors.json, which the Go side generates.
 * The Hyperliquid primitives are ./hl's, the parts a user's held order shares
 * ./heldwire's.
 */

import type {
  GetHeldBookRulesResponseJson,
  GetHeldOrderResponseJson,
  HeldOrderEventJson,
  HeldOrderStateJson,
  ListHeldOrdersResponseJson,
  ReplaceHeldBookOrdersResponseJson,
  WithdrawHeldBookResponseJson,
} from "./gen/rfq/v1/held_pb"
import type { BackoffOptions } from "./backoff"
import { createCaller, makerKeyAuth, queryString, type CallOptions, type CallerDefaults, type TransportOptions } from "./http"
import { followStream } from "./stream"
import {
  heldClearAction,
  isAddress,
  oneOrderAction,
  signL1Action,
  signedWire,
  unixMs,
  type CancelByCloidAction,
  type SignedHeldOrder,
} from "./heldwire"
import { asset as assetOf, isCanonical, type Hex, type OrderAction, type Side, type SignTypedData } from "./hl"

export {
  heldClearAction,
  randomCloid,
  type CancelByCloidAction,
  type HeldSignedWire,
  type HeldSigner,
  type SignedHeldOrder,
} from "./heldwire"
export { MAKER_KEY_HEADER, type CallOptions, type TransportOptions } from "./http"
export { Reason, RfqApiError, isRfqApiError, type ReasonCode } from "./errors"
export type { BackoffOptions } from "./backoff"
export type { Hex, OrderAction, Side, SignTypedData } from "./hl"

export type {
  GetHeldBookRulesResponseJson,
  GetHeldOrderResponseJson,
  HeldEventOrderJson,
  HeldLimitsJson,
  HeldOrderEventJson,
  HeldOrderStateJson,
  HeldOrderViewJson,
  HeldVerdictJson,
  ListHeldOrdersResponseJson,
  ReplaceHeldBookOrdersResponseJson,
  WithdrawHeldBookResponseJson,
} from "./gen/rfq/v1/held_pb"

// ---------------------------------------------------------------- the two actions

/** One held order before it is signed. Prices and sizes are the canonical strings Hyperliquid hashes. */
export interface HeldDraft {
  /** The Hyperliquid account that trades (one of the maker's allowlisted accounts). */
  readonly account: Hex
  /** The address whose key signs: the account itself (the default), or one of its API wallets. */
  readonly signer?: Hex
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
  /** The place action's nonce (unix ms, unique per signer); the clear's is `clearNonce`, else nonce + 1. */
  readonly nonce: bigint | number
  readonly clearNonce?: bigint | number
  /** unix ms: the order may be relayed until then (5 to 120 s ahead of the server's clock). */
  readonly expiresAfter: bigint | number
  /** unix ms: the cancel works until then (at least expiresAfter + 60 s). */
  readonly clearExpiresAfter: bigint | number
  /** The network the signatures are for: it is inside the hash. */
  readonly mainnet: boolean
}

/**
 * The order action of a held order, exactly as Hyperliquid hashes it: { type: "order", orders:
 * [{ a, b, p, s, r: false, t: { limit: { tif: "Alo" } }, c }], grouping: "na" }. It refuses what
 * the pool would refuse for the order itself: a number that is not canonical, a price off the
 * tick, a fraction of a share, a value under 1 USDC, a missing cloid.
 */
export function heldPlaceAction(d: Pick<HeldDraft, "book" | "side" | "isBuy" | "px" | "sz" | "cloid">): OrderAction {
  return oneOrderAction(d, "Alo", (fault, message) => (fault === "BAD_SIZE" ? new RangeError(message) : new TypeError(message)))
}

// ---------------------------------------------------------------- the API's JSON

/** One held order as the API takes it (an entry of a book update's `orders`). */
export type HeldOrderWire = SignedHeldOrder

/**
 * The exact JSON the API takes for one held order, from its parts: the two actions, the nonces
 * and expiresAfter they were signed with, and the two 65-byte signatures (r || s || v, as viem
 * returns them). The signatures are written in Hyperliquid's { r, s, v } form (v 27 or 28, low s).
 */
export function heldOrder(parts: {
  account: Hex
  signer?: Hex
  place: { action: OrderAction; nonce: bigint | number; expiresAfter: bigint | number; signature: Hex }
  clear: { action: CancelByCloidAction; nonce: bigint | number; expiresAfter: bigint | number; signature: Hex }
}): HeldOrderWire {
  if (!isAddress(parts.account)) throw new TypeError(`account: not an address: ${parts.account}`)
  const signer = parts.signer ?? parts.account
  if (!isAddress(signer)) throw new TypeError(`signer: not an address: ${signer}`)
  const order = parts.place.action.orders[0]
  const cancel = parts.clear.action.cancels[0]
  if (parts.place.action.orders.length !== 1 || order === undefined) throw new TypeError("a held order's place action carries exactly one order")
  if (parts.clear.action.cancels.length !== 1 || cancel === undefined) throw new TypeError("a held order's clear action carries exactly one cancel")
  if (cancel.asset !== order.a || cancel.cloid !== order.c) throw new TypeError("the clear must cancel the order's own asset and cloid")
  if (order.t.limit.tif !== "Alo") throw new TypeError(`a maker's held order is post-only (Alo), not ${order.t.limit.tif}`)
  if (!isCanonical(order.p) || !isCanonical(order.s)) throw new TypeError("the order's p and s must be canonical decimal strings")
  if (unixMs(parts.place.nonce, "place.nonce") === unixMs(parts.clear.nonce, "clear.nonce")) throw new RangeError("place and clear need different nonces")
  return {
    account: parts.account.toLowerCase(),
    signer: signer.toLowerCase(),
    place: signedWire(parts.place.action, parts.place.nonce, parts.place.expiresAfter, parts.place.signature, "place"),
    clear: signedWire(parts.clear.action, parts.clear.nonce, parts.clear.expiresAfter, parts.clear.signature, "clear"),
  }
}

/**
 * Builds and signs one held order: the post-only order and the cancel of its cloid, each hashed
 * with its own nonce and expiresAfter for the draft's network, signed by `signTypedData` (viem's
 * `privateKeyToAccount(apiWalletKey).signTypedData`, or any signer of the phantom agent). The
 * answer is the JSON `replaceBookOrders` takes.
 *
 * One rule about the key: Hyperliquid keeps each signer's 100 highest nonces and refuses anything
 * lower, so a held order dies once its signer has landed 100 newer nonces. Sign held orders with
 * an API wallet that signs nothing else, or date the nonces ahead (MAKER-SPEC §4).
 */
export async function signHeldOrder(d: HeldDraft, signTypedData: SignTypedData): Promise<HeldOrderWire> {
  const place = heldPlaceAction(d)
  const clear = heldClearAction(assetOf(d.book, d.side), d.cloid)
  const placeNonce = BigInt(d.nonce)
  const clearNonce = d.clearNonce === undefined ? placeNonce + 1n : BigInt(d.clearNonce)
  const placeSig = await signL1Action(place, placeNonce, d.expiresAfter, d.mainnet, signTypedData)
  const clearSig = await signL1Action(clear, clearNonce, d.clearExpiresAfter, d.mainnet, signTypedData)
  return heldOrder({
    account: d.account,
    ...(d.signer === undefined ? {} : { signer: d.signer }),
    place: { action: place, nonce: placeNonce, expiresAfter: d.expiresAfter, signature: placeSig },
    clear: { action: clear, nonce: clearNonce, expiresAfter: d.clearExpiresAfter, signature: clearSig },
  })
}

// ---------------------------------------------------------------- the feed's position

/** A `reset` of your feed, `resetReason`: the pool restarted and holds NOTHING you sent. Send every book again; every seq starts from 0. */
export const HELD_RESET_POOL_EMPTY = "POOL_EMPTY"
/**
 * A `reset` of your feed, `resetReason`: events could not be sent (you fell behind, or were away longer than the feed
 * reaches, or your cursor came without its epoch). Your orders MAY STILL BE LIVE: read them with `listOrders`, or send
 * every book again, which is always safe.
 */
export const HELD_RESET_EVENTS_MISSED = "EVENTS_MISSED"

/** Where your feed stands: what to reconnect with. Cursors mean nothing outside the epoch they belong to. */
export interface HeldFeedPosition {
  readonly cursor: string
  readonly epoch: string
}

/**
 * The position after an event of your feed. Feed it every event, heartbeats and resets included: they alone carry the
 * epoch (and a cursor of 0 is not sent). `watchOrders({ ...position })` reconnects, and replays what passed while you
 * were away, whatever the cursor, 0 included. A position only moves forward within an epoch: a heartbeat never takes it
 * back. Only a reset moves it elsewhere, since that says where the stream goes on from. `watchOrders` keeps its own
 * position this way across the streams it reopens; keep yours to resume after a restart of your process.
 */
export function advanceHeldFeed(at: HeldFeedPosition | undefined, ev: HeldOrderEventJson): HeldFeedPosition | undefined {
  const epoch = ev.epoch ?? at?.epoch
  if (epoch === undefined) return undefined // an event before any heartbeat: the stream opens with one
  const held = at?.epoch === epoch ? at.cursor : "0"
  const cursor = ev.cursor ?? (ev.type === "reset" ? "0" : held)
  return { epoch, cursor: ev.type !== "reset" && BigInt(cursor) < BigInt(held) ? held : cursor }
}

export interface WatchHeldOrdersOptions {
  /**
   * Resume after this cursor (the last one processed), with `epoch`. Neither a cursor nor an epoch: the events from now on,
   * NOTHING replayed, whatever passed before.
   */
  readonly cursor?: bigint | number | string
  /**
   * The epoch the cursor belongs to: the epoch of the last heartbeat or reset you saw. With this run's epoch the cursor is a
   * position, 0 included: what came after it is replayed. A cursor without it is answered with a `reset`, since nobody can
   * say which run of the pool it counts in (`advanceHeldFeed` keeps the two together).
   */
  readonly epoch?: string
  /** Only this book. */
  readonly book?: number
  /** Ends the feed. */
  readonly signal?: AbortSignal
  /**
   * Reopen the feed when it ends or fails, from the cursor and epoch it last saw (default true). False: the generator
   * ends with the first stream, and throws its failure.
   */
  readonly reconnect?: boolean
  /**
   * Called each time a stream opens, with where it resumes from. `resumed` false: no epoch yet, the events from now on:
   * list your orders then (`listOrders`), or send every book again.
   */
  readonly onOpen?: (info: { readonly cursor: string; readonly epoch?: string; readonly resumed: boolean }) => void
  /** A feed silent this long, not even a heartbeat, is taken for dead and reopened (default 45 s). */
  readonly idleTimeoutMs?: number
}

// ---------------------------------------------------------------- the client

/** The maker's client: the transport and the maker's API key. Defaults: 4 attempts (8 for a withdraw), 100 ms doubling to 2 s, a 10 s attempt. */
export interface MakerClientOptions extends TransportOptions {
  /** The maker's API key (skm_...), or a function that returns it (asked on every call: a rotated key needs no restart). */
  readonly makerKey: string | (() => string | Promise<string>)
  /** A withdraw's attempts (default: the larger of 8 and `maxAttempts`, so turning retries off leaves a withdraw its own). */
  readonly withdrawAttempts?: number
}

/** @deprecated The maker client's options are `MakerClientOptions`. */
export type HeldClientOptions = MakerClientOptions

/** The maker client's defaults (the Go maker client's). */
export const MAKER_DEFAULTS: CallerDefaults & { readonly withdrawAttempts: number } = {
  maxAttempts: 4,
  withdrawAttempts: 8,
  backoff: { initialMs: 100, maxMs: 2_000 } satisfies BackoffOptions,
  timeoutMs: 10_000,
}

/** A book update's answer, and what the client knows about how it was sent. */
export type ReplaceBookOrdersAnswer = ReplaceHeldBookOrdersResponseJson & {
  /** How many times the update was sent. */
  readonly attempts: number
  /**
   * An earlier attempt's answer was lost and this one found the book's last applied seq to be the update's own
   * (STALE_SEQ, the same seq): the update WAS applied, by that attempt. This answer carries none of its verdicts:
   * `listOrders` shows what stands.
   */
  readonly appliedEarlier: boolean
}

/** A withdraw's answer, and what the client knows about how it was sent. */
export type WithdrawAnswer = WithdrawHeldBookResponseJson & {
  readonly attempts: number
  /** As a book update's, for a withdraw under a seq of its own. */
  readonly appliedEarlier: boolean
}

/**
 * The maker API under /api/v1/held/ (protobuf JSON through the gateway: 64-bit integers come
 * back as decimal strings). Errors are `RfqApiError` with the edge's stable `code`
 * (UNAUTHENTICATED, FORBIDDEN, RATE_LIMITED with `retryAfterMs`, ...). An update the pool
 * declines is NOT an error: read `applied`, `code` and each order's verdict.
 */
export interface MakerClient {
  /** GET /api/v1/held/books/{book}/rules: the assets, the tick, the lives, your limits, your seq, the server's clock. */
  getBookRules(book: number, o?: CallOptions): Promise<GetHeldBookRulesResponseJson>
  /** POST /api/v1/held/books/{book}/orders: replace ALL of your orders on the book. */
  replaceBookOrders(
    book: number,
    update: { seq: bigint | number | string; strict?: boolean; orders: readonly HeldOrderWire[] },
    o?: CallOptions,
  ): Promise<ReplaceBookOrdersAnswer>
  /**
   * POST /api/v1/held/withdraw with {"book": N}: withdraw the book (seq absent: its next seq). That route
   * has its own rate and is never refused for your other traffic.
   */
  withdrawBook(book: number, seq?: bigint | number | string, o?: CallOptions): Promise<WithdrawAnswer>
  /** POST /api/v1/held/withdraw: withdraw every book. */
  withdrawAll(o?: CallOptions): Promise<WithdrawAnswer>
  /** GET /api/v1/held/orders. */
  listOrders(
    q?: { book?: number; states?: readonly HeldOrderStateJson[]; limit?: number; pageToken?: string; cloid?: string },
    o?: CallOptions,
  ): Promise<ListHeldOrdersResponseJson>
  /** GET /api/v1/held/orders/{orderId}. */
  getOrder(orderId: string, o?: CallOptions): Promise<GetHeldOrderResponseJson>
  /**
   * GET /api/v1/held/events: your feed, one event at a time (heartbeats included: their cursor and
   * epoch are where to resume). The feed is reopened when it ends, stalls or fails, from the last
   * cursor AND epoch it saw (`reconnect: false` turns that off), and ends when `signal` aborts. A
   * `reset` event says the stream cannot go on from there, and `resetReason` why:
   * `HELD_RESET_POOL_EMPTY`, send every book again; `HELD_RESET_EVENTS_MISSED`, your orders may
   * still be live: list them, or send every book again. It throws RfqApiError on what a retry
   * cannot mend (UNAUTHENTICATED, FORBIDDEN, ...).
   */
  watchOrders(o?: WatchHeldOrdersOptions): AsyncGenerator<HeldOrderEventJson, void, void>
}

/** @deprecated The maker client is `MakerClient`. */
export type HeldClient = MakerClient

const STALE_SEQ = "STALE_SEQ"

const appliedEarlier = (attempts: number, a: { applied?: boolean; code?: string; seq?: string }, sent: string | undefined): boolean =>
  attempts > 1 && a.applied !== true && a.code === STALE_SEQ && sent !== undefined && sent !== "0" && a.seq === sent

/** Where the feed stands inside the client: a cursor and its epoch, either possibly unknown. */
interface FeedAt {
  readonly cursor?: string
  readonly epoch?: string
}

export function createMakerClient(o: MakerClientOptions): MakerClient {
  const caller = createCaller({ ...o, auth: makerKeyAuth(o.makerKey) }, MAKER_DEFAULTS)
  const withdrawAttempts = o.withdrawAttempts ?? Math.max(MAKER_DEFAULTS.withdrawAttempts, o.maxAttempts ?? MAKER_DEFAULTS.maxAttempts)
  // Every call of this API is safe to repeat after a failure where it may have run: the reads, and
  // the two writes because of their seq (see the header).
  const counted = async <T>(method: "GET" | "POST", path: string, body: unknown, co: CallOptions | undefined, attempts?: number) => {
    let sent = 0
    const answer = await caller.call<T | null>(method, path, body, true, {
      ...(co?.signal === undefined ? {} : { signal: co.signal }),
      ...(attempts === undefined ? {} : { attempts }),
      onSend: () => void (sent += 1),
    })
    return { answer: (answer ?? {}) as T, sent }
  }
  const withdraw = async (body: Record<string, unknown>, co?: CallOptions): Promise<WithdrawAnswer> => {
    const { answer, sent } = await counted<WithdrawHeldBookResponseJson>("POST", "/api/v1/held/withdraw", body, co, withdrawAttempts)
    return { ...answer, attempts: sent, appliedEarlier: appliedEarlier(sent, answer, body["seq"] as string | undefined) }
  }

  return {
    getBookRules: async (book, co) => (await counted<GetHeldBookRulesResponseJson>("GET", `/api/v1/held/books/${book}/rules`, undefined, co)).answer,
    async replaceBookOrders(book, update, co) {
      const seq = String(update.seq)
      const { answer, sent } = await counted<ReplaceHeldBookOrdersResponseJson>(
        "POST",
        `/api/v1/held/books/${book}/orders`,
        { seq, strict: update.strict ?? false, orders: update.orders },
        co,
      )
      return { ...answer, attempts: sent, appliedEarlier: appliedEarlier(sent, answer, seq) }
    },
    withdrawBook: (book, seq, co) => withdraw(seq === undefined ? { book } : { book, seq: String(seq) }, co),
    withdrawAll: (co) => withdraw({ allBooks: true }, co),
    listOrders: async (q = {}, co) =>
      (
        await counted<ListHeldOrdersResponseJson>(
          "GET",
          `/api/v1/held/orders${queryString({ book: q.book, states: q.states, limit: q.limit, pageToken: q.pageToken, cloid: q.cloid })}`,
          undefined,
          co,
        )
      ).answer,
    getOrder: async (orderId, co) => (await counted<GetHeldOrderResponseJson>("GET", `/api/v1/held/orders/${encodeURIComponent(orderId)}`, undefined, co)).answer,
    watchOrders(w = {}) {
      const start: FeedAt | undefined =
        w.cursor === undefined && w.epoch === undefined
          ? undefined
          : { ...(w.cursor === undefined ? {} : { cursor: String(w.cursor) }), ...(w.epoch === undefined ? {} : { epoch: w.epoch }) }
      return followStream<HeldOrderEventJson, FeedAt>(caller, {
        ...(start === undefined ? {} : { start }),
        path: (at) =>
          `/api/v1/held/events${queryString({ cursor: at?.cursor === undefined || at.cursor === "0" ? undefined : at.cursor, epoch: at?.epoch, book: w.book })}`,
        advance: (at, ev) => advanceHeldFeed(at?.epoch === undefined ? undefined : { cursor: at.cursor ?? "0", epoch: at.epoch }, ev) ?? at,
        ...(w.signal === undefined ? {} : { signal: w.signal }),
        ...(w.reconnect === undefined ? {} : { reconnect: w.reconnect }),
        ...(w.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: w.idleTimeoutMs }),
        ...(w.onOpen === undefined
          ? {}
          : {
              onOpen: (at: FeedAt | undefined) =>
                w.onOpen?.({ cursor: at?.cursor ?? "0", ...(at?.epoch === undefined ? {} : { epoch: at.epoch }), resumed: at?.epoch !== undefined }),
            }),
      })
    },
  }
}

/** @deprecated The maker client is `createMakerClient`. */
export const createHeldClient = createMakerClient
