import type {
  BookDeltaJson,
  BookSnapshotJson,
  HlLayerJson,
  IndexFrameJson,
  PoolLayerJson,
  RfqLayerJson,
  StateFrameJson,
  TobFrameJson,
} from "./gen/rfq/v1/book_pb"
import {
  EPOCH_SHIFT,
  connectMarketsWith,
  num,
  pairLevels,
  setLevel,
  type FeedStatus,
  type MarketsClientOptions,
  type MarketsDecoder,
  type MarketsState,
  type MarketsStats,
} from "./markets-core"

export {
  MARKETS_SUBPROTOCOL,
  MarketsClose,
  MarketsError,
  type FeedStatus,
  type MarketsClientOptions,
  type MarketsState,
  type MarketsStats,
} from "./markets-core"

/**
 * The markets feed (wss://markets.skew.trade/v1/ws): each market's book on
 * Hyperliquid and in the held orders pool, its state, top of book and the market index, read-only
 * and public. Protocol v1, proto/rfq/v1/book.proto (its header lists the frames and fields this
 * feed serves). The connection (one socket, refcounted
 * subscriptions, the book_seq chain and its resync, the server's clock, close codes, pausing a
 * hidden tab) is ./markets-core's; this module is what a view holds.
 *
 * A BOOK VIEW has up to three layers, all in YES space, prices in milli, sizes in whole shares:
 *
 *  - `hl`: Hyperliquid's own book on the outcome's YES coin, as Hyperliquid shows it, on the milli
 *    grid (asks rounded up, bids down). Display only: nothing here fills it. A level travels as a
 *    triple [px, sz, 0]; the third number is ignored.
 *  - `pool` (absent until the feed has one): the held orders pool's resting orders, summed per
 *    price per side (an order on the NO side at q shows at 1000 - q on the other side of the
 *    book). Binding: a user's held order is matched against them.
 *  - `rfq` (absent until the feed serves one): Skew RFQ, indicative depth Skew may fill. Summed
 *    per price per side (a NO price q shows at 1000 - q on the bid side). Not binding: an order
 *    may fill in part or not at all.
 *
 * Only the fields book.proto names for this feed are read: anything else a frame carries is
 * dropped from the view, its `raw` and the tob, state and index frames delivered.
 *
 * STALENESS. A layer's `stale` says the feed has not heard for a while, and `reason` why it is
 * blank; `ageMs` is how long ago the book last changed, in server time. The book_seq chain is the feed's own: it moves
 * only when something public changed.
 */

/** One price level: milli and whole shares. */
export interface Level {
  readonly px: number
  readonly sz: number
}

/** A level of the `hl` layer. */
export type HlLevel = Level

export interface HlView {
  /** Best (highest) first. */
  readonly bids: readonly Level[]
  /** Best (lowest) first. */
  readonly asks: readonly Level[]
  readonly stale: boolean
  /** Why the layer is blank: HL_FEED_DOWN, HL_OFF, EXPIRED, DELISTED, UNAVAILABLE. */
  readonly reason: string
}

export interface PoolView {
  /** Best (highest) first. */
  readonly bids: readonly Level[]
  /** Best (lowest) first. */
  readonly asks: readonly Level[]
  readonly stale: boolean
  /** Why the layer is blank: POOL_DOWN, HALTED (nothing can be matched now), UNAVAILABLE. */
  readonly reason: string
}

/** Skew RFQ: indicative depth Skew may fill. Not binding: an order may fill in part or not at all. */
export interface RfqView {
  /** Best (highest) first. */
  readonly bids: readonly Level[]
  /** Best (lowest) first. */
  readonly asks: readonly Level[]
  /** False: a blank layer says why in `reason`. */
  readonly stale: boolean
  /** Why the layer is blank: UNAVAILABLE, HALTED. Empty when it shows. */
  readonly reason: string
}

export interface BookView {
  readonly market: string
  readonly bookSeq: bigint
  readonly epoch: number
  /** When the book was published, server ms. */
  readonly ts: number
  /** open, expired, settled. */
  readonly phase: string
  /** Unix seconds. */
  readonly expiry: number
  /** The settled result (YES or NO), once phase is settled. */
  readonly result: string
  readonly hl: HlView
  /** The held orders pool's depth; absent when the feed has none for the market. */
  readonly pool?: PoolView
  /** Skew RFQ; absent when the feed serves none for the market. */
  readonly rfq?: RfqView
  /** The server's feed status when this view was delivered. */
  readonly feed: FeedStatus
  /** The snapshot's fields this feed serves, with the deltas applied (wire form). */
  readonly raw: BookSnapshotJson
}

export interface MarketsClient {
  subscribeBook(market: string, cb: (view: BookView) => void): () => void
  subscribeTob(markets: readonly string[] | "*", cb: (tob: TobFrameJson) => void): () => void
  subscribeState(market: string, cb: (state: StateFrameJson) => void): () => void
  subscribeIndex(cb: (index: IndexFrameJson) => void): () => void
  book(market: string): BookView | undefined
  index(): IndexFrameJson | undefined
  serverNow(): number
  feed(): FeedStatus
  /** How long ago the book last changed (its `ts`), in server time. */
  ageMs(view: BookView, of?: "book"): number
  /** Unsubscribe every book (a hidden tab); tob, state and index stay. */
  pauseBooks(): void
  /** Resubscribe the books with `since`. */
  resumeBooks(): void
  state(): MarketsState
  stats(): MarketsStats
  close(): void
}

/** The layers an index entry may list here. */
const LAYERS = new Set(["hl", "pool"])

/** An hl triple array as levels: [px, sz, ignored], levels of no size dropped. */
function hlLevels(a: readonly number[] | undefined): Level[] {
  const out: Level[] = []
  if (a === undefined) return out
  for (let i = 0; i + 2 < a.length; i += 3) if ((a[i + 1] ?? 0) > 0) out.push({ px: a[i] ?? 0, sz: a[i + 1] ?? 0 })
  return out
}

/** The packed hl triples as this feed serves them: [px, sz, 0]. */
const hlTriples = (a: readonly number[]): number[] => hlLevels(a).flatMap((l) => [l.px, l.sz, 0])
const pairs = (a: readonly number[]): number[] => a.slice(0, a.length - (a.length % 2))

function hlLayer(h: HlLayerJson): HlLayerJson {
  const out: HlLayerJson = {}
  if (h.stale !== undefined) out.stale = h.stale
  if (h.reason !== undefined) out.reason = h.reason
  if (h.bids !== undefined) out.bids = hlTriples(h.bids)
  if (h.asks !== undefined) out.asks = hlTriples(h.asks)
  return out
}

function poolLayer(p: PoolLayerJson): PoolLayerJson {
  const out: PoolLayerJson = {}
  if (p.stale !== undefined) out.stale = p.stale
  if (p.reason !== undefined) out.reason = p.reason
  if (p.bids !== undefined) out.bids = pairs(p.bids)
  if (p.asks !== undefined) out.asks = pairs(p.asks)
  return out
}

function rfqLayer(r: RfqLayerJson): RfqLayerJson {
  const out: RfqLayerJson = {}
  if (r.stale !== undefined) out.stale = r.stale
  if (r.reason !== undefined) out.reason = r.reason
  if (r.bids !== undefined) out.bids = pairs(r.bids)
  if (r.asks !== undefined) out.asks = pairs(r.asks)
  return out
}

/** A snapshot's fields this feed serves (a fresh copy). */
function bookOf(s: BookSnapshotJson): BookSnapshotJson {
  const out: BookSnapshotJson = {}
  if (s.t !== undefined) out.t = s.t
  if (s.market !== undefined) out.market = s.market
  if (s.book_seq !== undefined) out.book_seq = s.book_seq
  if (s.ts !== undefined) out.ts = s.ts
  if (s.phase !== undefined) out.phase = s.phase
  if (s.expiry !== undefined) out.expiry = s.expiry
  if (s.result !== undefined) out.result = s.result
  if (s.hl !== undefined) out.hl = hlLayer(s.hl)
  if (s.pool !== undefined) out.pool = poolLayer(s.pool)
  if (s.rfq !== undefined) out.rfq = rfqLayer(s.rfq)
  return out
}

function tobOf(t: TobFrameJson): TobFrameJson {
  const out: TobFrameJson = {}
  if (t.t !== undefined) out.t = t.t
  if (t.market !== undefined) out.market = t.market
  if (t.book_seq !== undefined) out.book_seq = t.book_seq
  if (t.ts !== undefined) out.ts = t.ts
  if (t.hl !== undefined) out.hl = { ...(t.hl.bid === undefined ? {} : { bid: t.hl.bid }), ...(t.hl.ask === undefined ? {} : { ask: t.hl.ask }) }
  if (t.pool !== undefined) out.pool = { ...(t.pool.bid === undefined ? {} : { bid: t.pool.bid }), ...(t.pool.ask === undefined ? {} : { ask: t.pool.ask }) }
  if (t.rfq !== undefined) out.rfq = { ...(t.rfq.bid === undefined ? {} : { bid: t.rfq.bid }), ...(t.rfq.ask === undefined ? {} : { ask: t.rfq.ask }) }
  return out
}

function stateOf(s: StateFrameJson): StateFrameJson {
  const out: StateFrameJson = {}
  for (const k of ["t", "market", "ts", "phase", "expiry", "series", "rung", "strike", "result"] as const) {
    if (s[k] !== undefined) (out as Record<string, unknown>)[k] = s[k]
  }
  return out
}

function indexFrameOf(idx: IndexFrameJson): IndexFrameJson {
  const out: IndexFrameJson = {}
  if (idx.t !== undefined) out.t = idx.t
  if (idx.ts !== undefined) out.ts = idx.ts
  if (idx.markets !== undefined) {
    out.markets = idx.markets.map((e) => {
      const entry: NonNullable<IndexFrameJson["markets"]>[number] = {}
      for (const k of ["market", "series", "rung", "strike", "expiry", "phase"] as const) {
        if (e[k] !== undefined) (entry as Record<string, unknown>)[k] = e[k]
      }
      if (e.layers !== undefined) entry.layers = e.layers.filter((l) => LAYERS.has(l))
      return entry
    })
  }
  return out
}

/** Unpacks a snapshot (wire form) into a view: the hl, pool and rfq layers and the book's header, nothing else. */
export function toBookView(s: BookSnapshotJson, feed: FeedStatus = "unknown"): BookView {
  const raw = bookOf(s)
  const seq = BigInt(raw.book_seq ?? "0")
  const pool = raw.pool
  const rfq = raw.rfq
  return {
    market: raw.market ?? "",
    bookSeq: seq,
    epoch: Number(seq >> EPOCH_SHIFT),
    ts: num(raw.ts),
    phase: raw.phase ?? "",
    expiry: num(raw.expiry),
    result: raw.result ?? "",
    hl: {
      bids: hlLevels(raw.hl?.bids),
      asks: hlLevels(raw.hl?.asks),
      stale: raw.hl?.stale ?? false,
      reason: raw.hl?.reason ?? "",
    },
    ...(pool === undefined
      ? {}
      : { pool: { bids: pairLevels(pool.bids), asks: pairLevels(pool.asks), stale: pool.stale ?? false, reason: pool.reason ?? "" } }),
    ...(rfq === undefined
      ? {}
      : { rfq: { bids: pairLevels(rfq.bids), asks: pairLevels(rfq.asks), stale: rfq.stale ?? false, reason: rfq.reason ?? "" } }),
    feed,
    raw,
  }
}

/**
 * Applies a delta to a snapshot (replacement semantics: the level at (layer, side, px) becomes
 * sz, and sz 0 removes it; header fields replace; a present `pool` or `rfq` header is the
 * layer's appearance when the snapshot has none). Only the hl, pool and rfq layers and the book's
 * header are read; the result
 * carries the snapshot's fields this feed serves and nothing else. It does not check prev_seq: the
 * caller does.
 */
export function applyDelta(s: BookSnapshotJson, d: BookDeltaJson): BookSnapshotJson {
  const out = bookOf(s)
  if (d.book_seq !== undefined) out.book_seq = d.book_seq
  if (d.ts !== undefined) out.ts = d.ts
  if (d.phase !== undefined) out.phase = d.phase
  if (d.expiry !== undefined) out.expiry = d.expiry
  if (d.result !== undefined) out.result = d.result
  if (d.hl !== undefined) {
    const hl = (out.hl ??= {})
    if (d.hl.stale !== undefined) hl.stale = d.hl.stale
    if (d.hl.reason !== undefined) hl.reason = d.hl.reason
  }
  if (d.pool !== undefined) {
    const pool = (out.pool ??= {})
    if (d.pool.stale !== undefined) pool.stale = d.pool.stale
    if (d.pool.reason !== undefined) pool.reason = d.pool.reason
  }
  if (d.rfq !== undefined) {
    const rfq = (out.rfq ??= {})
    if (d.rfq.stale !== undefined) rfq.stale = d.rfq.stale
    if (d.rfq.reason !== undefined) rfq.reason = d.rfq.reason
  }
  for (const l of d.levels ?? []) {
    const px = l.px ?? 0
    const sz = l.sz ?? 0
    if (l.layer === "hl") {
      const hl = (out.hl ??= {})
      if (l.side === "bid") hl.bids = setLevel(hl.bids, 3, px, [sz, 0], false)
      else if (l.side === "ask") hl.asks = setLevel(hl.asks, 3, px, [sz, 0], true)
    } else if (l.layer === "pool") {
      const pool = (out.pool ??= {})
      if (l.side === "bid") pool.bids = setLevel(pool.bids, 2, px, [sz], false)
      else if (l.side === "ask") pool.asks = setLevel(pool.asks, 2, px, [sz], true)
    } else if (l.layer === "rfq") {
      const rfq = (out.rfq ??= {})
      if (l.side === "bid") rfq.bids = setLevel(rfq.bids, 2, px, [sz], false)
      else if (l.side === "ask") rfq.asks = setLevel(rfq.asks, 2, px, [sz], true)
    }
  }
  return out
}

const decoder: MarketsDecoder<BookView> = {
  snapshot: bookOf,
  view: toBookView,
  apply: applyDelta,
  tob: tobOf,
  state: stateOf,
  index: indexFrameOf,
}

export function connectMarkets(opts: MarketsClientOptions): MarketsClient {
  const c = connectMarketsWith(opts, decoder)
  return {
    subscribeBook: c.subscribeBook,
    subscribeTob: c.subscribeTob,
    subscribeState: c.subscribeState,
    subscribeIndex: c.subscribeIndex,
    book: c.book,
    index: c.index,
    serverNow: c.serverNow,
    feed: c.feed,
    ageMs: (view) => c.serverNow() - view.ts,
    pauseBooks: c.pauseBooks,
    resumeBooks: c.resumeBooks,
    state: c.state,
    stats: c.stats,
    close: c.close,
  }
}
