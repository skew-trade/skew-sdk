import type {
  BookDeltaJson,
  BookSnapshotJson,
  ErrorFrameJson,
  FeedFrameJson,
  HeartbeatFrameJson,
  HelloFrameJson,
  IndexFrameJson,
  StateFrameJson,
  TobFrameJson,
} from "./gen/rfq/v1/book_pb"
import { backoffMs } from "./backoff"
import type { TokenRequest } from "./http"

/**
 * The markets feed's CONNECTION (protocol v1, proto/rfq/v1/book.proto): one socket, its subscriptions, the book chain, the server's
 * clock, reconnects. What a book view holds is not this module's business: a client hands it a
 * decoder (`MarketsDecoder`: the snapshot it keeps, the view it makes, how a delta applies) and
 * the extra channels it offers, and ./markets builds the client of the public feed on it.
 *
 *   wss://<host>/v1/ws   Sec-WebSocket-Protocol: skew.markets.v1 [, bearer.<jwt>]
 *
 * ONE socket serves every subscription of the page, refcounted: the first callback on a market
 * subscribes, the last one's release unsubscribes.
 *
 * BOOKS. A book subscription receives a snapshot, then deltas. The client asserts the chain: a
 * delta whose prev_seq is not the book_seq it holds, or a book_seq of another builder epoch
 * (book_seq >> 40), is a GAP (the server guarantees there are none, so it counts one in
 * `stats().gaps`, calls `onGap`, and asks for a `resync`); the view keeps its last good state
 * until the snapshot arrives. After a reconnect every book is resubscribed with `since`, so
 * markets that did not move cost no snapshot.
 *
 * TIME. `serverNow()` is the local clock corrected by the minimum of (hb.ts - receive time) over
 * the last ten heartbeats; a client judges a book's age in server time.
 *
 * CLOSE CODES. 4400/4403 stop; 4401 refreshes the token once, then carries on anonymously; 4429
 * waits at least 10 s; 1013 at least 2 s; 1012 (a server draining) reconnects after the server's
 * hint (uniform 0-3 s) with no backoff growth; 1001 "idle" stays idle until something is
 * subscribed; anything else backs off exponentially with full jitter (0.5 s, capped at 15 s).
 * Fifteen seconds without any frame (heartbeats arrive every 5 s) reopens the socket.
 */

export const MARKETS_SUBPROTOCOL = "skew.markets.v1"

/** The close codes the markets server uses. */
export const MarketsClose = {
  BadRequest: 4400,
  Unauthorized: 4401,
  Forbidden: 4403,
  TooMany: 4429,
  TryAgainLater: 1013,
  ServiceRestart: 1012,
  MessageTooBig: 1009,
  GoingAway: 1001,
} as const

export type FeedStatus = "ok" | "stale" | "down" | "unknown"
export type MarketsState = "idle" | "connecting" | "open" | "reconnecting" | "closed"

export interface MarketsStats {
  readonly gaps: number
  readonly resyncs: number
  readonly reconnects: number
  readonly snapshots: number
  readonly deltas: number
}

/** A server `error` frame. */
export class MarketsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly markets: readonly string[] = [],
    readonly id?: number,
  ) {
    super(`${code}: ${message}`)
    this.name = "MarketsError"
  }
}

export interface MarketsClientOptions {
  /** e.g. "wss://markets.skew.trade/v1/ws" */
  readonly url: string
  /** A session JWT raises the limits (book "*", more subscriptions). Omit for anonymous reads. */
  readonly getToken?: (request?: TokenRequest) => string | undefined | Promise<string | undefined>
  readonly onState?: (state: MarketsState) => void
  readonly onError?: (error: unknown) => void
  readonly onFeed?: (status: FeedStatus) => void
  /** A client-side gap (a server bug): report it as the client_gap metric. */
  readonly onGap?: (market: string, why: "prev_seq" | "epoch") => void
  /** Pause books while the document is hidden (default true where `document` exists). */
  readonly pauseWhenHidden?: boolean
  readonly WebSocketImpl?: typeof WebSocket
  readonly initialBackoffMs?: number
  readonly maxBackoffMs?: number
  /** Reopen after this long without any frame (default 15 s; 0 turns it off). */
  readonly silenceTimeoutMs?: number
  readonly now?: () => number
  readonly random?: () => number
}

/** A frame of an extra channel as the client keeps it: the market it is for and its value. */
export interface ChannelValue {
  readonly market: string
  readonly value: unknown
}

/**
 * How a client reads the frames. `snapshot` is what it keeps of a received snapshot (what deltas
 * apply to and `since` reads); `view` makes the view its callbacks receive; `apply` applies a delta
 * to a kept snapshot (it does not check prev_seq: the connection does). `tob`, `state` and `index`
 * are what it delivers of those frames. `channels` are the channels it offers beyond book, tob,
 * state and index, by frame kind (`t`): each frame is decoded, kept per market and delivered.
 * Frames of any other kind are dropped.
 */
export interface MarketsDecoder<V> {
  snapshot(s: BookSnapshotJson): BookSnapshotJson
  view(raw: BookSnapshotJson, feed: FeedStatus): V
  apply(raw: BookSnapshotJson, d: BookDeltaJson): BookSnapshotJson
  tob(f: TobFrameJson): TobFrameJson
  state(f: StateFrameJson): StateFrameJson
  index(f: IndexFrameJson): IndexFrameJson
  readonly channels?: Readonly<Record<string, (frame: Record<string, unknown>) => ChannelValue>>
}

/** The connection a client is built on. */
export interface MarketsConnection<V> {
  subscribeBook(market: string, cb: (view: V) => void): () => void
  subscribeTob(markets: readonly string[] | "*", cb: (tob: TobFrameJson) => void): () => void
  subscribeState(market: string, cb: (state: StateFrameJson) => void): () => void
  subscribeIndex(cb: (index: IndexFrameJson) => void): () => void
  /** One of the decoder's `channels`. */
  subscribe(channel: string, market: string, cb: (value: unknown) => void): () => void
  book(market: string): V | undefined
  /** The last value of one of the decoder's `channels` for a market. */
  last(channel: string, market: string): unknown
  index(): IndexFrameJson | undefined
  serverNow(): number
  feed(): FeedStatus
  /** Unsubscribe every book (a hidden tab); every other channel stays. */
  pauseBooks(): void
  /** Resubscribe the books with `since`. */
  resumeBooks(): void
  state(): MarketsState
  stats(): MarketsStats
  close(): void
}

/** The builder's lease epoch sits above bit 40 of a book_seq. */
export const EPOCH_SHIFT = 40n

/** A wire number (protojson writes 64-bit integers as strings), 0 when absent. */
export const num = (v: number | string | undefined): number => (v === undefined ? 0 : Number(v))

/** A packed [px, sz, ...] array as levels. */
export function pairLevels(a: readonly number[] | undefined): { px: number; sz: number }[] {
  const out: { px: number; sz: number }[] = []
  if (a === undefined) return out
  for (let i = 0; i + 1 < a.length; i += 2) out.push({ px: a[i] ?? 0, sz: a[i + 1] ?? 0 })
  return out
}

/**
 * Replaces the level at px in a packed array of `stride` numbers per level ([px, ...vals]) and
 * keeps it sorted: all-zero vals remove it.
 */
export function setLevel(arr: readonly number[] | undefined, stride: number, px: number, vals: number[], ascending: boolean): number[] {
  const rows: number[][] = []
  const a = arr ?? []
  for (let i = 0; i + stride <= a.length; i += stride) if (a[i] !== px) rows.push(a.slice(i, i + stride))
  if (vals.some((v) => v > 0)) rows.push([px, ...vals])
  rows.sort((x, y) => (ascending ? (x[0] ?? 0) - (y[0] ?? 0) : (y[0] ?? 0) - (x[0] ?? 0)))
  return rows.flat()
}

interface Book<V> {
  raw?: BookSnapshotJson
  view?: V
  resyncAt: number
}

const BOOK = "book"
const TOB = "tob"
const STATE = "state"
const INDEX = "index"

export function connectMarketsWith<V>(opts: MarketsClientOptions, decoder: MarketsDecoder<V>): MarketsConnection<V> {
  const WS = opts.WebSocketImpl ?? globalThis.WebSocket
  const now = opts.now ?? (() => Date.now())
  const random = opts.random ?? Math.random
  const initial = opts.initialBackoffMs ?? 500
  const max = opts.maxBackoffMs ?? 15_000
  const silenceMs = opts.silenceTimeoutMs ?? 15_000
  const extra = Object.keys(decoder.channels ?? {})
  /** Resubscribed in this order after a reconnect; a refused market is retried on these. */
  const resubscribeOrder = [INDEX, STATE, ...extra, TOB, BOOK]
  const perMarket = [BOOK, TOB, ...extra, STATE]

  const subs = new Map<string, Set<(v: never) => void>>() // "ch|market"
  const books = new Map<string, Book<V>>()
  const kept = new Map<string, unknown>() // "ch|market": an extra channel's last value
  let indexFrame: IndexFrameJson | undefined
  const offsets: number[] = []
  let feed: FeedStatus = "unknown"
  let state: MarketsState = "idle"
  let socket: WebSocket | undefined
  let closed = false
  let paused = false
  let attempt = 0
  let authFailures = 0
  let anonymous = false
  let forceRefresh = false
  let nextId = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let silence: ReturnType<typeof setTimeout> | undefined
  const counts = { gaps: 0, resyncs: 0, reconnects: 0, snapshots: 0, deltas: 0 }
  const unknown = new Set<string>() // "ch|market" refused as UNKNOWN_MARKET, retried on the next index

  const setState = (s: MarketsState) => {
    if (s === state) return
    state = s
    opts.onState?.(s)
  }
  const report = (e: unknown) => opts.onError?.(e)
  const key = (ch: string, m: string) => `${ch}|${m}`
  const marketsOf = (ch: string) => {
    const out: string[] = []
    for (const k of subs.keys()) {
      const [c, m] = k.split("|") as [string, string]
      if (c === ch) out.push(m)
    }
    return out
  }
  const hasSubs = () => subs.size > 0

  function send(op: Record<string, unknown>): boolean {
    if (socket === undefined || socket.readyState !== 1) return false
    nextId += 1
    socket.send(JSON.stringify({ ...op, id: nextId }))
    return true
  }

  function subscribeOp(ch: string, markets: string[]) {
    if (ch === INDEX) return void send({ op: "subscribe", ch })
    if (markets.length === 0) return
    const op: Record<string, unknown> = { op: "subscribe", ch, m: markets }
    if (ch === BOOK) {
      const since: Record<string, string> = {}
      for (const m of markets) {
        const s = books.get(m)?.raw?.book_seq
        if (s !== undefined) since[m] = s
      }
      if (Object.keys(since).length > 0) op.since = since
    }
    send(op)
  }

  function resubscribeAll() {
    for (const ch of resubscribeOrder) {
      if (ch === BOOK && paused) continue
      const ms = marketsOf(ch)
      if (ms.length > 0) subscribeOp(ch, ms)
    }
  }

  function notify<T>(k: string, v: T) {
    for (const cb of subs.get(k) ?? []) {
      try {
        ;(cb as (x: T) => void)(v)
      } catch (e) {
        report(e)
      }
    }
  }

  function clearTimers() {
    if (timer !== undefined) clearTimeout(timer)
    if (silence !== undefined) clearTimeout(silence)
    timer = silence = undefined
  }

  function detach(ws: WebSocket) {
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
  }

  function armSilence(ws: WebSocket) {
    if (silenceMs <= 0) return
    if (silence !== undefined) clearTimeout(silence)
    silence = setTimeout(() => {
      if (socket !== ws || closed) return
      socket = undefined
      detach(ws)
      try {
        ws.close(4000, "no frames")
      } catch {
        // already closed
      }
      schedule(backoff())
    }, silenceMs)
  }

  const backoff = () => {
    const d = attempt === 0 ? 0 : backoffMs(attempt - 1, { initialMs: initial, maxMs: max, jitter: 1 })
    attempt += 1
    return d
  }

  function schedule(delay: number) {
    if (closed) return
    if (!hasSubs()) {
      setState("idle")
      return
    }
    setState("reconnecting")
    counts.reconnects += 1
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void connect()
    }, delay)
  }

  function stop(error?: unknown) {
    if (closed) return
    closed = true
    clearTimers()
    const ws = socket
    socket = undefined
    if (ws !== undefined) {
      detach(ws)
      try {
        ws.close(1000, "client closed")
      } catch {
        // already closed
      }
    }
    setState("closed")
    if (error !== undefined) report(error)
  }

  function onClose(code: number, reason: string) {
    socket = undefined
    if (silence !== undefined) clearTimeout(silence)
    if (closed) return
    switch (code) {
      case MarketsClose.BadRequest:
      case MarketsClose.Forbidden:
        stop(new MarketsError(String(code), reason || "refused by the server"))
        return
      case MarketsClose.Unauthorized:
        authFailures += 1
        if (authFailures >= 2 || opts.getToken === undefined) anonymous = true
        else forceRefresh = true
        schedule(0)
        return
      case MarketsClose.TooMany:
        schedule(10_000 + random() * 5_000)
        return
      case MarketsClose.TryAgainLater:
        schedule(Math.max(2_000, backoff()))
        return
      case MarketsClose.ServiceRestart: {
        const hint = /reconnect_ms=(\d+)/.exec(reason)
        schedule(hint ? Number(hint[1]) : random() * 3_000)
        return
      }
      default:
        schedule(backoff())
    }
  }

  function onFrame(ws: WebSocket, data: unknown) {
    armSilence(ws)
    if (typeof data !== "string") return
    let f: { t?: string } & Record<string, unknown>
    try {
      f = JSON.parse(data) as typeof f
    } catch (e) {
      report(e)
      return
    }
    switch (f.t) {
      case "hello": {
        const h = f as HelloFrameJson
        attempt = 0
        if (h.tier === "jwt") authFailures = 0
        setState("open")
        return
      }
      case "hb": {
        const hb = f as HeartbeatFrameJson
        offsets.push(num(hb.ts) - now())
        if (offsets.length > 10) offsets.shift()
        if (hb.feed !== undefined) setFeed(hb.feed as FeedStatus)
        return
      }
      case "feed":
        setFeed(((f as FeedFrameJson).status ?? "unknown") as FeedStatus)
        return
      case "snapshot":
        return onSnapshot(f as BookSnapshotJson)
      case "delta":
        return onDelta(f as BookDeltaJson)
      case "tob": {
        const t = decoder.tob(f as TobFrameJson)
        notify(key(TOB, t.market ?? ""), t)
        notify(key(TOB, "*"), t)
        return
      }
      case "state": {
        const s = decoder.state(f as StateFrameJson)
        notify(key(STATE, s.market ?? ""), s)
        return
      }
      case "index": {
        indexFrame = decoder.index(f as IndexFrameJson)
        notify(key(INDEX, "*"), indexFrame)
        retryUnknown()
        return
      }
      case "error": {
        const e = f as ErrorFrameJson
        if (e.code === "UNKNOWN_MARKET") for (const m of e.m ?? []) for (const ch of perMarket) if (subs.has(key(ch, m))) unknown.add(key(ch, m))
        report(new MarketsError(e.code ?? "ERROR", e.msg ?? "", e.m ?? [], e.id))
        return
      }
      default: {
        // An extra channel's frame, or ack, pong, and kinds this client does not know.
        const ch = f.t
        const decode = ch !== undefined && extra.includes(ch) ? decoder.channels?.[ch] : undefined
        if (ch === undefined || decode === undefined) return
        const c = decode(f)
        const k = key(ch, c.market)
        if (!subs.has(k)) return
        kept.set(k, c.value)
        notify(k, c.value)
      }
    }
  }

  function setFeed(s: FeedStatus) {
    if (s === feed) return
    feed = s
    opts.onFeed?.(s)
    for (const [m, b] of books) {
      if (b.raw === undefined) continue
      b.view = decoder.view(b.raw, feed)
      notify(key(BOOK, m), b.view)
    }
  }

  function retryUnknown() {
    if (unknown.size === 0) return
    const by = new Map<string, string[]>()
    for (const k of unknown) {
      const [c, m] = k.split("|") as [string, string]
      if (!subs.has(k)) continue
      by.set(c, [...(by.get(c) ?? []), m])
    }
    unknown.clear()
    for (const [c, ms] of by) subscribeOp(c, ms)
  }

  function onSnapshot(s: BookSnapshotJson) {
    const m = s.market ?? ""
    const b = books.get(m)
    if (b === undefined || !subs.has(key(BOOK, m))) return
    if (b.raw !== undefined && BigInt(s.book_seq ?? "0") <= BigInt(b.raw.book_seq ?? "0") && b.resyncAt === 0) return
    b.raw = decoder.snapshot(s)
    b.resyncAt = 0
    b.view = decoder.view(b.raw, feed)
    counts.snapshots += 1
    notify(key(BOOK, m), b.view)
  }

  function onDelta(d: BookDeltaJson) {
    const m = d.market ?? ""
    const b = books.get(m)
    if (b === undefined || !subs.has(key(BOOK, m))) return
    if (b.resyncAt !== 0) return // waiting for the snapshot
    const held = b.raw?.book_seq
    if (held === undefined) return gap(m, b, "prev_seq")
    const seq = BigInt(d.book_seq ?? "0")
    if (seq <= BigInt(held)) return // already applied
    if (seq >> EPOCH_SHIFT !== BigInt(held) >> EPOCH_SHIFT) return gap(m, b, "epoch")
    if (d.prev_seq !== held) return gap(m, b, "prev_seq")
    b.raw = decoder.apply(b.raw as BookSnapshotJson, d)
    b.view = decoder.view(b.raw, feed)
    counts.deltas += 1
    notify(key(BOOK, m), b.view)
  }

  function gap(m: string, b: Book<V>, why: "prev_seq" | "epoch") {
    counts.gaps += 1
    opts.onGap?.(m, why)
    if (b.resyncAt !== 0 && now() - b.resyncAt < 2_000) return
    b.resyncAt = now()
    counts.resyncs += 1
    send({ op: "resync", m: [m] })
  }

  async function connect() {
    if (closed) return
    if (!hasSubs()) {
      setState("idle")
      return
    }
    setState(state === "reconnecting" ? "reconnecting" : "connecting")
    let token: string | undefined
    if (opts.getToken !== undefined && !anonymous) {
      try {
        const refresh = forceRefresh
        forceRefresh = false
        token = await opts.getToken(refresh ? { forceRefresh: true } : undefined)
      } catch (e) {
        report(e)
        token = undefined
      }
    }
    if (closed || socket !== undefined) return
    const protocols = token ? [MARKETS_SUBPROTOCOL, `bearer.${token}`] : [MARKETS_SUBPROTOCOL]
    const ws = new WS(opts.url, protocols)
    socket = ws
    armSilence(ws)
    ws.onopen = () => {
      for (const b of books.values()) b.resyncAt = 0
      resubscribeAll()
    }
    ws.onmessage = (ev: MessageEvent) => onFrame(ws, ev.data)
    ws.onerror = (ev: Event) => report(ev)
    ws.onclose = (ev: CloseEvent) => {
      if (socket === ws) onClose(ev.code, ev.reason)
    }
  }

  function add<T>(ch: string, market: string, cb: (v: T) => void): () => void {
    if (closed) throw new Error("markets client is closed")
    const k = key(ch, market)
    let set = subs.get(k)
    const first = set === undefined
    if (set === undefined) {
      set = new Set()
      subs.set(k, set)
    }
    set.add(cb as (v: never) => void)
    if (ch === BOOK && !books.has(market)) books.set(market, { resyncAt: 0 })
    if (first) {
      if (socket === undefined && timer === undefined) void connect()
      else if (!(ch === BOOK && paused)) subscribeOp(ch, ch === INDEX ? [] : [market])
    }
    // Deliver what is already known.
    if (ch === BOOK) {
      const v = books.get(market)?.view
      if (v !== undefined) (cb as unknown as (x: V) => void)(v)
    } else if (ch === INDEX) {
      if (indexFrame !== undefined) (cb as (x: IndexFrameJson) => void)(indexFrame)
    } else if (kept.has(k)) (cb as (x: unknown) => void)(kept.get(k))
    let done = false
    return () => {
      if (done) return
      done = true
      set.delete(cb as (v: never) => void)
      if (set.size > 0) return
      subs.delete(k)
      unknown.delete(k)
      kept.delete(k)
      if (ch === BOOK) books.delete(market)
      if (ch === INDEX) send({ op: "unsubscribe", ch })
      else send({ op: "unsubscribe", ch, m: [market] })
    }
  }

  const connection: MarketsConnection<V> = {
    subscribeBook: (m, cb) => add(BOOK, m, cb),
    subscribeTob(markets, cb) {
      const list = markets === "*" ? ["*"] : [...markets]
      const offs = list.map((m) => add(TOB, m, cb))
      return () => offs.forEach((off) => off())
    },
    subscribeState: (m, cb) => add(STATE, m, cb),
    subscribeIndex: (cb) => add(INDEX, "*", cb),
    subscribe(channel, market, cb) {
      if (!extra.includes(channel)) throw new Error(`markets client offers no channel ${channel}`)
      return add(channel, market, cb)
    },
    book: (m) => books.get(m)?.view,
    last: (channel, m) => kept.get(key(channel, m)),
    index: () => indexFrame,
    serverNow: () => (offsets.length > 0 ? now() + Math.min(...offsets) : now()),
    feed: () => feed,
    pauseBooks() {
      if (paused) return
      paused = true
      const ms = marketsOf(BOOK)
      if (ms.length > 0) send({ op: "unsubscribe", ch: BOOK, m: ms })
    },
    resumeBooks() {
      if (!paused) return
      paused = false
      subscribeOp(BOOK, marketsOf(BOOK))
    },
    state: () => state,
    stats: () => ({ ...counts }),
    close: () => stop(),
  }

  if (opts.pauseWhenHidden ?? typeof document !== "undefined") {
    const doc = (globalThis as { document?: Document }).document
    doc?.addEventListener("visibilitychange", () => (doc.visibilityState === "hidden" ? connection.pauseBooks() : connection.resumeBooks()))
  }

  return connection
}
