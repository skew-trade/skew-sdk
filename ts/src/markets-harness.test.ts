import assert from "node:assert/strict"
import type { TestContext } from "node:test"

import type { BookDeltaJson, BookSnapshotJson } from "./gen/rfq/v1/book_pb"
import type { MarketsState } from "./markets-core"

// The markets tests' fake socket and helpers (markets.test.ts). No tests here.

/** The part of the browser WebSocket the client uses, driven by the test. */
export class FakeWS {
  static instances: FakeWS[] = []
  readonly url: string
  readonly protocols: string[]
  readyState = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  sent: Record<string, unknown>[] = []
  closedWith: { code?: number; reason?: string } | undefined
  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url)
    this.protocols = protocols === undefined ? [] : Array.isArray(protocols) ? protocols : [protocols]
    FakeWS.instances.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>)
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason }
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.({} as Event)
  }
  frame(f: unknown) {
    this.onmessage?.({ data: typeof f === "string" ? f : JSON.stringify(f) } as MessageEvent)
  }
  serverClose(code: number, reason = "") {
    this.readyState = 3
    this.onclose?.({ code, reason } as CloseEvent)
  }
  ops(op?: string) {
    return this.sent.filter((s) => op === undefined || s.op === op)
  }
}

export const WS = FakeWS as unknown as typeof WebSocket
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
export const last = () => {
  const ws = FakeWS.instances.at(-1)
  assert.ok(ws, "no socket was opened")
  return ws
}

export const E1 = 1n << 40n
export const seq = (n: bigint, epoch = 1n) => ((epoch << 40n) | n).toString()

export function delta(n: bigint, prev: bigint, levels: BookDeltaJson["levels"] = [], epoch = 1n): BookDeltaJson {
  return { t: "delta", market: "10294", book_seq: seq(n, epoch), prev_seq: seq(prev, epoch), ts: "1100", levels }
}

export interface Recorder {
  states: MarketsState[]
  errors: unknown[]
  gaps: [string, string][]
  tokens: unknown[]
  clock: { now: number }
}

const prepared = new WeakSet<TestContext>()

/** Fresh sockets, fake timers once per test, and the callbacks' recorder. */
export function prepare(t: TestContext): Recorder {
  FakeWS.instances = []
  if (!prepared.has(t)) {
    prepared.add(t)
    t.mock.timers.enable({ apis: ["setTimeout"] })
  }
  return { states: [], errors: [], gaps: [], tokens: [], clock: { now: 10_000 } }
}

/** The options every test client takes: the fake socket, the recorder, no silence timer, a fixed clock. */
export function baseOptions(r: Recorder) {
  return {
    url: "wss://markets.example/v1/ws",
    WebSocketImpl: WS,
    onState: (s: MarketsState) => r.states.push(s),
    onError: (e: unknown) => r.errors.push(e),
    onGap: (m: string, why: string) => r.gaps.push([m, why]),
    silenceTimeoutMs: 0,
    pauseWhenHidden: false,
    now: () => r.clock.now,
    random: () => 0.5,
  }
}

/** Opens the socket and says hello with a first heartbeat (server time 10000, feed ok). */
export async function ready(): Promise<FakeWS> {
  await flush()
  const ws = last()
  ws.open()
  ws.frame({ t: "hello", v: 1, server_id: "p0", hb_ms: 5000, tier: "anon" })
  ws.frame({ t: "hb", ts: "10000", feed: "ok" })
  return ws
}

/** Drops the fields a delta never carries (t) for comparison, and orders keys. */
export function normalize(s: BookSnapshotJson): unknown {
  const { t: _t, ...rest } = s
  return JSON.parse(JSON.stringify(rest, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort()) : v)))
}

/**
 * Frames the real markets feed served: a snapshot and the delta after it, verbatim (captured
 * 2026-11-12).
 */
export const REAL_PUBLIC_SNAPSHOT =
  '{"t":"snapshot","market":"10294","book_seq":"1099511627777","ts":"1794459343227","phase":"open","expiry":"1794462943","hl":{"stale":false,"reason":"","bids":[3,1505,0],"asks":[670,22,0,690,35,0,710,43,0,730,66,0,997,1505,0]},"pool":{"stale":false,"reason":"","bids":[480,55,475,30],"asks":[672,30,677,35]}}'
export const REAL_PUBLIC_DELTA =
  '{"t":"delta","market":"10294","book_seq":"1099511627778","prev_seq":"1099511627777","ts":"1794459344133","levels":[{"layer":"pool","side":"bid","px":480,"sz":40}]}'
