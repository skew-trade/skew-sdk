import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it, type TestContext } from "node:test"

import type { BookDeltaJson, BookSnapshotJson } from "./gen/rfq/v1/book_pb"
import {
  MARKETS_SUBPROTOCOL,
  MarketsClose,
  MarketsError,
  applyDelta,
  connectMarkets,
  toBookView,
  type BookView,
  type MarketsClient,
  type MarketsClientOptions,
} from "./markets"
import {
  E1,
  FakeWS,
  REAL_PUBLIC_DELTA,
  REAL_PUBLIC_SNAPSHOT,
  baseOptions,
  delta,
  flush,
  last,
  prepare,
  ready,
  seq,
  type Recorder,
} from "./markets-harness.test"

// The PUBLIC client against the public feed's frames (book.proto's header lists them).

function snapshot(n: bigint, extra: Partial<BookSnapshotJson> = {}, epoch = 1n): BookSnapshotJson {
  return {
    t: "snapshot",
    market: "10294",
    book_seq: seq(n, epoch),
    ts: "1000",
    phase: "open",
    expiry: "1794154747",
    hl: unread({ stale: false, reason: "", bids: [3, 1505, 0, 1, 16000, 0], asks: [670, 22, 0, 690, 31, 0] }, { extra: { n: "990" } }),
    ...extra,
  }
}

/**
 * A frame part with fields the client does not know (a newer server's, say), which it must not read.
 * Added apart from the part's type, which need not have them.
 */
function unread<T extends object>(part: T, extra: Record<string, unknown>): T {
  return { ...part, ...extra } as T
}

interface Harness extends Recorder {
  client: MarketsClient
}

function open(t: TestContext, extra: Partial<MarketsClientOptions> = {}): Harness {
  const r = prepare(t)
  return Object.assign(r, { client: connectMarkets({ ...baseOptions(r), ...extra }) })
}

/** The keys a public book view's raw frame may carry, at any depth (book.proto's header lists them). */
const PUBLIC_KEYS = new Set(["t", "market", "book_seq", "prev_seq", "ts", "phase", "expiry", "result", "hl", "pool", "rfq", "stale", "reason", "bids", "asks"])

/** Fails on any key of `v`, at any depth, that the public feed does not serve. */
function onlyPublicKeys(v: unknown, path = "raw"): void {
  if (Array.isArray(v) || v === null || typeof v !== "object") return
  for (const [k, x] of Object.entries(v)) {
    assert.ok(PUBLIC_KEYS.has(k), `${path}.${k} is not a field of the public feed`)
    onlyPublicKeys(x, `${path}.${k}`)
  }
}

describe("books", () => {
  it("subscribe on open, unpack the snapshot and apply deltas: hl triples (the third number ignored), pool levels", async (t) => {
    const h = open(t)
    const views: BookView[] = []
    h.client.subscribeBook("10294", (v) => views.push(v))
    const ws = await ready()
    assert.deepEqual(ws.protocols, [MARKETS_SUBPROTOCOL])
    assert.deepEqual(ws.ops("subscribe"), [{ op: "subscribe", ch: "book", m: ["10294"], id: 1 }])
    ws.frame(snapshot(5n, { pool: unread({ stale: false, reason: "", bids: [480, 40, 475, 30], asks: [672, 30] }, { extra: "995" }) }))
    ws.frame(
      delta(6n, 5n, [
        { layer: "hl", side: "bid", px: 4, sz: 7 },
        { layer: "hl", side: "ask", px: 670, sz: 0 },
        { layer: "pool", side: "bid", px: 475, sz: 0 },
        { layer: "pool", side: "ask", px: 677, sz: 35 },
      ]),
    )
    const v = views.at(-1)!
    assert.equal(v.bookSeq, E1 | 6n)
    assert.equal(v.epoch, 1)
    assert.deepEqual(v.hl.bids, [{ px: 4, sz: 7 }, { px: 3, sz: 1505 }, { px: 1, sz: 16000 }])
    assert.deepEqual(v.hl.asks, [{ px: 690, sz: 31 }])
    assert.deepEqual(v.pool, { bids: [{ px: 480, sz: 40 }], asks: [{ px: 672, sz: 30 }, { px: 677, sz: 35 }], stale: false, reason: "" })
    assert.deepEqual(v.raw.hl?.bids, [4, 7, 0, 3, 1505, 0, 1, 16000, 0], "the triple keeps its shape")
    assert.deepEqual(h.client.stats(), { gaps: 0, resyncs: 0, reconnects: 0, snapshots: 1, deltas: 1 })
    h.client.close()
  })

  it("read the real feed's frames: hl triples with 0, the pool, a delta that keeps the chain", async (t) => {
    const h = open(t)
    const views: BookView[] = []
    h.client.subscribeBook("10294", (v) => views.push(v))
    const ws = await ready()
    ws.frame(REAL_PUBLIC_SNAPSHOT)
    ws.frame(REAL_PUBLIC_DELTA)
    assert.equal(views.length, 2)
    const v = views[1]!
    assert.equal(v.bookSeq, 1099511627778n, "the delta moves the book_seq")
    assert.equal(v.ts, 1794459344133)
    assert.equal(v.phase, "open")
    assert.equal(v.expiry, 1794462943)
    assert.deepEqual(v.hl.asks.slice(0, 2), [{ px: 670, sz: 22 }, { px: 690, sz: 35 }])
    assert.deepEqual(v.hl.bids, [{ px: 3, sz: 1505 }])
    assert.deepEqual(v.pool?.bids, [{ px: 480, sz: 40 }, { px: 475, sz: 30 }])
    assert.deepEqual(v.pool?.asks, [{ px: 672, sz: 30 }, { px: 677, sz: 35 }])
    // The next delta chains on it.
    ws.frame({ t: "delta", market: "10294", book_seq: "1099511627779", prev_seq: "1099511627778", ts: "1794459344500", levels: [{ layer: "pool", side: "bid", px: 482, sz: 5 }] })
    assert.deepEqual(h.client.book("10294")!.pool?.bids[0], { px: 482, sz: 5 })
    assert.deepEqual(h.gaps, [])
    assert.equal(h.client.stats().deltas, 2)
    h.client.close()
  })

  it("the pool layer: absent until the feed has one, its appearance in a delta header, its stale and reason", () => {
    const s = snapshot(5n)
    const v = toBookView(s)
    assert.equal("pool" in v, false, "a book without a pool layer has no pool")
    const appeared = applyDelta(s, { ...delta(6n, 5n), pool: {} })
    assert.deepEqual(toBookView(appeared).pool, { bids: [], asks: [], stale: false, reason: "" })
    const filled = applyDelta(appeared, delta(7n, 6n, [{ layer: "pool", side: "ask", px: 520, sz: 30 }, { layer: "pool", side: "ask", px: 515, sz: 10 }]))
    assert.deepEqual(toBookView(filled).pool?.asks, [{ px: 515, sz: 10 }, { px: 520, sz: 30 }], "asks ascend")
    const down = applyDelta(filled, { ...delta(8n, 7n), pool: unread({ stale: true, reason: "POOL_DOWN" }, { extra: "1234" }) })
    assert.deepEqual(toBookView(down).pool, { bids: [], asks: [{ px: 515, sz: 10 }, { px: 520, sz: 30 }], stale: true, reason: "POOL_DOWN" })
    // A delta's hl header: stale, reason (and a field the client does not read).
    const hl = applyDelta(down, { ...delta(9n, 8n), hl: unread({ stale: true, reason: "HL_FEED_DOWN" }, { extra: { n: "2000" } }) })
    assert.deepEqual(toBookView(hl).hl, { bids: [{ px: 3, sz: 1505 }, { px: 1, sz: 16000 }], asks: [{ px: 670, sz: 22 }, { px: 690, sz: 31 }], stale: true, reason: "HL_FEED_DOWN" })
    // Header fields replace.
    const settled = applyDelta(hl, { ...delta(10n, 9n), phase: "settled", result: "YES" })
    assert.equal(toBookView(settled).phase, "settled")
    assert.equal(toBookView(settled).result, "YES")
  })

  it("the rfq layer (Skew RFQ): absent until the feed serves one, its levels, its appearance, its stale and reason", () => {
    const s = snapshot(5n)
    assert.equal("rfq" in toBookView(s), false, "a book without an rfq layer has no rfq")
    const shown = snapshot(5n, { rfq: { stale: false, reason: "", bids: [440, 50, 420, 80], asks: [445, 100, 450, 100] } })
    assert.deepEqual(toBookView(shown).rfq, {
      bids: [{ px: 440, sz: 50 }, { px: 420, sz: 80 }],
      asks: [{ px: 445, sz: 100 }, { px: 450, sz: 100 }],
      stale: false,
      reason: "",
    })
    const fell = applyDelta(shown, delta(6n, 5n, [{ layer: "rfq", side: "ask", px: 445, sz: 70 }, { layer: "rfq", side: "bid", px: 430, sz: 5 }]))
    assert.deepEqual(toBookView(fell).rfq?.asks, [{ px: 445, sz: 70 }, { px: 450, sz: 100 }])
    assert.deepEqual(toBookView(fell).rfq?.bids, [{ px: 440, sz: 50 }, { px: 430, sz: 5 }, { px: 420, sz: 80 }], "bids descend")
    const blank = applyDelta(fell, {
      ...delta(7n, 6n, [
        { layer: "rfq", side: "ask", px: 445 },
        { layer: "rfq", side: "ask", px: 450 },
        { layer: "rfq", side: "bid", px: 440 },
        { layer: "rfq", side: "bid", px: 430 },
        { layer: "rfq", side: "bid", px: 420 },
      ]),
      rfq: { stale: false, reason: "UNAVAILABLE" },
    })
    assert.deepEqual(toBookView(blank).rfq, { bids: [], asks: [], stale: false, reason: "UNAVAILABLE" })
    // Its appearance in a delta header (the snapshot had none), then its levels.
    const appeared = applyDelta(s, { ...delta(6n, 5n, [{ layer: "rfq", side: "ask", px: 470, sz: 20 }]), rfq: { stale: false, reason: "" } })
    assert.deepEqual(toBookView(appeared).rfq, { bids: [], asks: [{ px: 470, sz: 20 }], stale: false, reason: "" })
    // Only its four fields are read.
    const extra = { ...shown, rfq: { ...shown.rfq, x: "5", y: [1] } } as unknown as BookSnapshotJson
    assert.deepEqual(Object.keys(toBookView(extra).raw.rfq!).sort(), ["asks", "bids", "reason", "stale"])
  })

  it("follow the Go builder's public frames with the rfq layer (testdata/golden/public-rfq-frames.jsonl)", async (t) => {
    const lines = readFileSync(new URL("../../testdata/markets/public-rfq-frames.jsonl", import.meta.url), "utf8").trim().split("\n")
    const h = open(t)
    const views: BookView[] = []
    h.client.subscribeBook("23377", (v) => views.push(v))
    const ws = await ready()
    for (const line of lines) ws.frame((JSON.parse(line) as { frame: BookSnapshotJson | BookDeltaJson }).frame)
    assert.deepEqual(h.gaps, [], "the public chain has no gap")
    assert.ok(h.client.stats().deltas >= 6, `deltas ${h.client.stats().deltas}`)
    const rfqs = views.map((v) => JSON.stringify(v.rfq))
    const seen = rfqs.filter((r, i) => i === 0 || r !== rfqs[i - 1])
    const lv = (px: number, sz: number) => ({ px, sz })
    const shown = (bid: number, ask: number) =>
      JSON.stringify({ bids: [lv(bid, 50), lv(420, 80)], asks: [lv(445, ask), lv(450, 100)], stale: false, reason: "" })
    assert.deepEqual(seen, [
      shown(440, 100),
      shown(440, 70),
      JSON.stringify({ bids: [], asks: [], stale: false, reason: "UNAVAILABLE" }),
      shown(440, 100),
      JSON.stringify({ bids: [], asks: [], stale: false, reason: "UNAVAILABLE" }),
      shown(440, 100),
      shown(435, 100),
    ])
    for (const v of views) onlyPublicKeys(v.raw)
    h.client.close()
  })

  it("assert the chain: a prev_seq gap or an epoch change asks for a resync and keeps the last good view", async (t) => {
    const h = open(t)
    h.client.subscribeBook("10294", () => {})
    const ws = await ready()
    ws.frame(snapshot(5n))
    ws.frame(delta(7n, 6n))
    assert.deepEqual(h.gaps, [["10294", "prev_seq"]])
    assert.deepEqual(ws.ops("resync").map((o) => o.m), [["10294"]])
    assert.equal(h.client.book("10294")!.bookSeq, E1 | 5n, "the view keeps its last good state")
    ws.frame(delta(8n, 7n)) // ignored while waiting for the snapshot
    assert.equal(h.client.stats().gaps, 1)
    ws.frame(snapshot(8n))
    assert.equal(h.client.book("10294")!.bookSeq, E1 | 8n)
    ws.frame(delta(1n, 8n, [], 2n)) // another epoch without a snapshot
    assert.deepEqual(h.gaps.at(-1), ["10294", "epoch"])
    ws.frame(snapshot(1n, {}, 2n))
    assert.equal(h.client.book("10294")!.epoch, 2)
    assert.equal(h.client.stats().resyncs, 2)
    h.client.close()
  })

  it("resubscribe with since after a reconnect, and count each subscription once", async (t) => {
    const h = open(t)
    const off1 = h.client.subscribeBook("10294", () => {})
    const off2 = h.client.subscribeBook("10294", () => {})
    let ws = await ready()
    assert.equal(ws.ops("subscribe").length, 1, "two callbacks, one subscription")
    ws.frame(snapshot(9n))
    ws.serverClose(1006)
    t.mock.timers.tick(0)
    await flush()
    ws = last()
    ws.open()
    assert.deepEqual(ws.ops("subscribe"), [{ op: "subscribe", ch: "book", m: ["10294"], since: { "10294": seq(9n) }, id: 2 }])
    off1()
    assert.equal(ws.ops("unsubscribe").length, 0)
    off2()
    assert.deepEqual(ws.ops("unsubscribe").map((o) => o.m), [["10294"]])
    h.client.close()
  })

  it("pause books (a hidden tab) and resume them with since", async (t) => {
    const h = open(t)
    h.client.subscribeBook("10294", () => {})
    h.client.subscribeTob("*", () => {})
    const ws = await ready()
    ws.frame(snapshot(3n))
    h.client.pauseBooks()
    assert.deepEqual(ws.ops("unsubscribe"), [{ op: "unsubscribe", ch: "book", m: ["10294"], id: 3 }])
    h.client.resumeBooks()
    assert.deepEqual(ws.ops("subscribe").at(-1), { op: "subscribe", ch: "book", m: ["10294"], since: { "10294": seq(3n) }, id: 4 })
    h.client.close()
  })
})

describe("the close codes", () => {
  it("1012: reconnect after the server's hint, without growing the backoff", async (t) => {
    const h = open(t)
    h.client.subscribeBook("10294", () => {})
    const ws = await ready()
    ws.serverClose(MarketsClose.ServiceRestart, "service restart; reconnect_ms=1234")
    t.mock.timers.tick(1233)
    await flush()
    assert.equal(FakeWS.instances.length, 1)
    t.mock.timers.tick(1)
    await flush()
    assert.equal(FakeWS.instances.length, 2)
    h.client.close()
  })

  it("4429 waits at least 10 s, 1013 at least 2 s", async (t) => {
    const h = open(t)
    h.client.subscribeBook("10294", () => {})
    let ws = await ready()
    ws.serverClose(MarketsClose.TooMany)
    t.mock.timers.tick(9_999)
    await flush()
    assert.equal(FakeWS.instances.length, 1)
    t.mock.timers.tick(5_000)
    await flush()
    assert.equal(FakeWS.instances.length, 2)
    ws = await ready()
    ws.serverClose(MarketsClose.TryAgainLater)
    t.mock.timers.tick(1_999)
    await flush()
    assert.equal(FakeWS.instances.length, 2)
    t.mock.timers.tick(1)
    await flush()
    assert.equal(FakeWS.instances.length, 3)
    h.client.close()
  })

  it("4400 and 4403 stop", async (t) => {
    const h = open(t)
    h.client.subscribeBook("10294", () => {})
    const ws = await ready()
    ws.serverClose(MarketsClose.Forbidden, "origin")
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(FakeWS.instances.length, 1)
    assert.equal(h.client.state(), "closed")
    assert.ok(h.errors.at(-1) instanceof MarketsError)
  })

  it("4401 refreshes the token once, then reads anonymously", async (t) => {
    let n = 0
    const h: Harness = open(t, {
      getToken: (req) => {
        h.tokens.push(req)
        n += 1
        return `jwt-${n}`
      },
    })
    h.client.subscribeBook("10294", () => {})
    let ws = await ready()
    assert.deepEqual(ws.protocols, [MARKETS_SUBPROTOCOL, "bearer.jwt-1"])
    ws.serverClose(MarketsClose.Unauthorized, "token expired")
    t.mock.timers.tick(0)
    await flush()
    ws = last()
    assert.deepEqual(ws.protocols, [MARKETS_SUBPROTOCOL, "bearer.jwt-2"])
    assert.deepEqual(h.tokens.at(-1), { forceRefresh: true })
    ws.serverClose(MarketsClose.Unauthorized, "token rejected")
    t.mock.timers.tick(0)
    await flush()
    assert.deepEqual(last().protocols, [MARKETS_SUBPROTOCOL], "a second refusal drops to anonymous")
    h.client.close()
  })

  it("1001 idle with nothing subscribed stays idle until a subscription", async (t) => {
    const h = open(t)
    const off = h.client.subscribeBook("10294", () => {})
    const ws = await ready()
    off()
    ws.serverClose(MarketsClose.GoingAway, "idle: no subscriptions")
    t.mock.timers.tick(60_000)
    await flush()
    assert.equal(FakeWS.instances.length, 1)
    assert.equal(h.client.state(), "idle")
    h.client.subscribeState("10294", () => {})
    await flush()
    assert.equal(FakeWS.instances.length, 2)
    h.client.close()
  })

  it("silence for 15 s reopens the socket", async (t) => {
    const h = open(t, { silenceTimeoutMs: 15_000 })
    h.client.subscribeBook("10294", () => {})
    const ws = await ready()
    t.mock.timers.tick(14_999)
    ws.frame({ t: "hb", ts: "10001", feed: "ok" })
    t.mock.timers.tick(14_999)
    await flush()
    assert.equal(FakeWS.instances.length, 1)
    t.mock.timers.tick(1)
    await flush()
    assert.deepEqual(ws.closedWith, { code: 4000, reason: "no frames" })
    t.mock.timers.tick(15_000)
    await flush()
    assert.ok(FakeWS.instances.length >= 2)
    h.client.close()
  })
})

describe("staleness", () => {
  it("judge ages in server time: the hl layer, the pool, the book; a feed status change redelivers the view", async (t) => {
    const h = open(t)
    const feeds: string[] = []
    h.client.subscribeBook("10294", (v) => feeds.push(v.feed))
    const ws = await ready()
    // The server's clock runs 2 s behind ours: the heartbeat says 10000 at local 12000.
    h.clock.now = 12_000
    ws.frame({ t: "hb", ts: "10000", feed: "ok" })
    ws.frame(snapshot(1n, { pool: unread({ bids: [480, 40] }, { extra: "9000" }) }))
    const v = h.client.book("10294")!
    assert.equal(h.client.serverNow(), 10_000)
    assert.equal(h.client.ageMs(v, "book"), 10_000 - 1000)
    assert.equal(h.client.ageMs(v), 10_000 - 1000, "the book's age is the only one")
    assert.equal((v.pool as Record<string, unknown> | undefined)?.["extra"], undefined, "a field the client does not know is not read")
    ws.frame({ t: "feed", status: "stale", since: "10000" })
    assert.equal(h.client.feed(), "stale")
    assert.deepEqual(feeds, ["ok", "stale"])
    h.client.close()
  })
})

describe("other channels", () => {
  it("deliver tob, state and index, and retry UNKNOWN_MARKET on the next index", async (t) => {
    const h = open(t)
    const tobs: unknown[] = []
    const states: unknown[] = []
    const idx: unknown[] = []
    h.client.subscribeTob("*", (x) => tobs.push(x))
    h.client.subscribeState("10300", (x) => states.push(x))
    h.client.subscribeIndex((x) => idx.push(x))
    const ws = await ready()
    ws.frame({ t: "error", id: 2, code: "UNKNOWN_MARKET", msg: "not in the market index", m: ["10300"] })
    assert.ok(h.errors.at(-1) instanceof MarketsError)
    ws.frame({ t: "tob", market: "10294", book_seq: seq(1n), hl: { bid: 3, ask: 670 } })
    ws.frame({ t: "index", ts: "1", markets: [{ market: "10300" }] })
    assert.deepEqual(ws.ops("subscribe").at(-1), { op: "subscribe", ch: "state", m: ["10300"], id: 4 })
    ws.frame({ t: "state", market: "10300", phase: "open" })
    assert.equal(tobs.length, 1)
    assert.equal(states.length, 1)
    assert.equal(idx.length, 1)
    assert.equal(h.client.index()?.markets?.[0]?.market, "10300")
    h.client.close()
  })

  it("deliver what is known on subscribe: the book view and the index", async (t) => {
    const h = open(t)
    h.client.subscribeBook("10294", () => {})
    h.client.subscribeIndex(() => {})
    const ws = await ready()
    ws.frame(snapshot(2n))
    ws.frame({ t: "index", ts: "1", markets: [{ market: "10294", layers: ["hl"] }] })
    const got: unknown[] = []
    h.client.subscribeBook("10294", (v) => got.push(v.bookSeq))
    h.client.subscribeIndex((x) => got.push(x.markets?.length))
    assert.deepEqual(got, [E1 | 2n, 1])
    h.client.close()
  })
})
