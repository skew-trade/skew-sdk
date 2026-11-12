import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { Reason, RfqApiError, errorFromResponse, isRfqApiError } from "./errors"
import { createRfqClient, type RfqClientOptions, type TokenRequest } from "./rest"
import { MAKER_KEY_HEADER, bearerAuth, createCaller, makerKeyAuth, queryString } from "./http"
import { backoffMs } from "./backoff"

// The app's client (./rest) and the maker's (./maker) share one caller (./http): its retry, refresh
// and timeout rules are tested here through the app's client, and its two credentials directly.

/** A held order id. */
const ID = `0x${"ab".repeat(16)}`

interface Reply {
  status?: number
  body?: unknown
  text?: string
  headers?: Record<string, string>
  throws?: Error
  /** never resolves until the request is aborted */
  hang?: boolean
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

function fakeFetch(script: Reply[] | ((n: number, call: Call) => Reply)) {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === "string" ? init.body : undefined,
    }
    calls.push(call)
    const n = calls.length
    const r = typeof script === "function" ? script(n, call) : (script[Math.min(n, script.length) - 1] ?? {})
    if (r.hang) {
      await new Promise<never>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")), { once: true })
      })
    }
    if (r.throws) throw r.throws
    const status = r.status ?? 200
    const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body))
    return new Response(status === 204 || status === 304 ? null : text, { status, headers: r.headers })
  }) as typeof fetch
  return { fetch: impl, calls }
}

function client(script: Parameters<typeof fakeFetch>[0], extra: Partial<RfqClientOptions> = {}) {
  const f = fakeFetch(script)
  const sleeps: number[] = []
  const tokens: (TokenRequest | undefined)[] = []
  let issued = 0
  const opts: RfqClientOptions = {
    baseUrl: "https://api.example/",
    getToken: (req) => {
      tokens.push(req)
      issued += 1
      return `token-${issued}`
    },
    fetch: f.fetch,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra,
  }
  const c = createRfqClient(opts)
  return { c, calls: f.calls, sleeps, tokens }
}

const rateLimited = (retryAfterMs?: number): Reply => ({
  status: 429,
  body: {
    code: Reason.RateLimited,
    message: "too many requests",
    details: [{ "@type": "type.googleapis.com/rfq.v1.ErrorDetail", reason: Reason.RateLimited, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }],
  },
})

describe("the requests", () => {
  it("send only the headers the gateway's CORS policy allows", async () => {
    const { c, calls } = client([{ body: {} }])
    await c.getUserHeldTerms(4242)
    await c.placeUserHeldOrder({ order: { account: "0x1", signer: "0x1" } as never, deadlineMs: "1" })
    await c.getUserHeldOrder(ID)
    assert.deepEqual(
      calls.map((x) => `${x.method} ${x.url}`),
      ["GET https://api.example/api/v1/rfq/held/books/4242/terms", "POST https://api.example/api/v1/rfq/held/orders", `GET https://api.example/api/v1/rfq/held/orders/${ID}`],
    )
    for (const call of calls) {
      assert.ok(call.headers["Authorization"]?.startsWith("Bearer token-"), "no bearer")
      const names = Object.keys(call.headers).sort()
      assert.ok(names.every((n) => ["Accept", "Authorization", "Content-Type"].includes(n)), `a header outside the CORS allow-list: ${names.join(",")}`)
      assert.equal(call.headers["Accept"], "application/json")
    }
    assert.equal(calls[1]?.headers["Content-Type"], "application/json")
    assert.equal(calls[0]?.headers["Content-Type"], undefined, "a GET has no body type")
  })

  it("encode a query: absent and empty values left out, an array as one repeated key", () => {
    assert.equal(queryString({}), "")
    assert.equal(queryString({ a: undefined, b: "" }), "")
    assert.equal(queryString({ book: 7, states: ["X", "Y"], pageToken: "p 1" }), "?book=7&states=X&states=Y&pageToken=p+1")
  })
})

describe("the two credentials", () => {
  const okFetch = () => fakeFetch([{ body: {} }])

  it("a session JWT travels as a Bearer token and is refreshed once after a 401", async () => {
    const tokens: (TokenRequest | undefined)[] = []
    const auth = bearerAuth((r) => (tokens.push(r), r?.forceRefresh ? "fresh" : "jwt"))
    assert.equal(auth.refreshes, true)
    assert.deepEqual(await auth.headers(), { Authorization: "Bearer jwt" })
    assert.deepEqual(await auth.headers({ forceRefresh: true }), { Authorization: "Bearer fresh" })
    assert.deepEqual(tokens, [undefined, { forceRefresh: true }])
  })

  it("a maker's key travels in its own header, asked for on every call, and a 401 is final", async () => {
    let asked = 0
    const f = okFetch()
    const caller = createCaller({ baseUrl: "https://api.example", auth: makerKeyAuth(() => (asked += 1, "skm_k")), fetch: f.fetch })
    await caller.call("GET", "/api/v1/held/orders", undefined, true)
    await caller.call("POST", "/api/v1/held/withdraw", { allBooks: true }, true)
    assert.equal(asked, 2)
    assert.equal(MAKER_KEY_HEADER, "X-Skew-Maker-Key")
    for (const call of f.calls) {
      assert.equal(call.headers[MAKER_KEY_HEADER], "skm_k")
      assert.equal(call.headers["Authorization"], undefined, "no bearer beside the key")
    }
    assert.deepEqual(Object.keys(f.calls[1]?.headers ?? {}).sort(), ["Accept", "Content-Type", MAKER_KEY_HEADER])

    const denied = fakeFetch([{ status: 401, body: { code: Reason.Unauthenticated, message: "no" } }])
    const refused = createCaller({ baseUrl: "https://api.example", auth: makerKeyAuth("skm_bad"), fetch: denied.fetch })
    await assert.rejects(refused.call("GET", "/api/v1/held/orders", undefined, true), (e: unknown) => isRfqApiError(e) && e.status === 401)
    assert.equal(denied.calls.length, 1, "a key the edge does not know is never sent again")
  })

  it("a call may ask for more attempts than maxAttempts (a maker's withdraw)", async () => {
    const f = fakeFetch([{ status: 503, body: { code: Reason.Unavailable, message: "down" } }])
    const caller = createCaller({ baseUrl: "https://api.example", auth: makerKeyAuth("skm_k"), fetch: f.fetch, maxAttempts: 2, sleep: async () => undefined })
    let sent = 0
    await assert.rejects(caller.call("POST", "/api/v1/held/withdraw", {}, true, { attempts: 5, onSend: () => void (sent += 1) }))
    assert.equal(f.calls.length, 5)
    assert.equal(sent, 5)
  })
})

describe("errors", () => {
  it("carry the stable code, the field violations and the retry hint", async () => {
    const { c } = client([
      {
        status: 400,
        body: {
          code: Reason.InvalidArgument,
          message: "invalid request: shares: value must be at least 1",
          details: [{ "@type": "type.googleapis.com/rfq.v1.ErrorDetail", reason: Reason.InvalidArgument, violations: [{ field: "shares", description: "value must be at least 1" }] }],
        },
      },
    ])
    await assert.rejects(c.getUserHeldTerms(4242), (e: unknown) => {
      assert.ok(e instanceof RfqApiError)
      assert.equal(e.status, 400)
      assert.equal(e.code, "INVALID_ARGUMENT")
      assert.equal(e.violations[0]?.field, "shares")
      assert.equal(e.retryable, false)
      assert.match(e.message, /shares/u)
      return true
    })
  })

  it("read a body that is not the gateway's", () => {
    const e = errorFromResponse(502, null, "<html>Bad Gateway</html>")
    assert.equal(e.status, 502)
    assert.equal(e.code, undefined)
    assert.match(e.message, /Bad Gateway/u)
    assert.equal(e.retryable, true)
    const h = errorFromResponse(429, {}, "", "7")
    assert.equal(h.retryAfterMs, 7000, "the Retry-After header is the fallback")
    assert.equal(errorFromResponse(500, null, "").message, "request failed with 500")
  })

  it("a 200 that is not JSON is an error, not a silent null", async () => {
    const { c } = client([{ text: "<html>" }])
    await assert.rejects(c.getUserHeldOrder(ID), (e: unknown) => isRfqApiError(e) && /not JSON/u.test(e.message))
  })

  it("name the reasons the server documents", () => {
    for (const r of ["UNAUTHENTICATED", "BETA_REQUIRED", "TAKER_MISMATCH", "GEOFENCED", "SCREENED", "INVALID_ARGUMENT", "BAD_SIGNATURE", "NOT_FOUND",
      "ORDER_NOT_CANCELLABLE", "RATE_LIMITED", "OPEN_ORDERS_CAP", "TOO_MANY_STREAMS", "CURSOR_TOO_OLD", "UNAVAILABLE", "INTERNAL"]) {
      assert.ok(Object.values(Reason).includes(r as never), r)
    }
    assert.ok(!Object.values(Reason).includes("IDEMPOTENCY_KEY_REUSED" as never), "IDEMPOTENCY_KEY_REUSED is not a reason")
  })
})

describe("401", () => {
  it("refreshes the token once and repeats the call, whatever it is", async () => {
    const { c, calls, tokens } = client((n) => (n === 1 ? { status: 401, body: { code: Reason.Unauthenticated, message: "authentication required" } } : { body: { order: {} } }))
    await c.cancelUserHeldOrder(ID)
    assert.equal(calls.length, 2)
    assert.deepEqual(tokens, [undefined, { forceRefresh: true }])
    assert.equal(calls[0]?.headers["Authorization"], "Bearer token-1")
    assert.equal(calls[1]?.headers["Authorization"], "Bearer token-2")
  })

  it("gives up after one refresh", async () => {
    const { c, calls } = client([{ status: 401, body: { code: Reason.Unauthenticated, message: "no" } }])
    await assert.rejects(c.getUserHeldOrder(ID), (e: unknown) => isRfqApiError(e) && e.status === 401 && e.code === "UNAUTHENTICATED")
    assert.equal(calls.length, 2)
  })
})

describe("429", () => {
  it("waits the retryAfterMs the edge asked for, then repeats ANY call (the edge refused before doing work)", async () => {
    const { c, calls, sleeps } = client((n) => (n === 1 ? rateLimited(1500) : { body: { order: { orderId: ID } } }))
    const r = await c.cancelUserHeldOrder(ID)
    assert.equal(r.order?.orderId, ID)
    assert.equal(calls.length, 2)
    assert.equal(sleeps.length, 1)
    assert.ok((sleeps[0] ?? 0) >= 1500, `waited ${sleeps[0]} ms`)
  })

  it("takes the Retry-After header when there is no detail", async () => {
    const { c, sleeps } = client((n) => (n === 1 ? { status: 429, headers: { "Retry-After": "2" }, body: { code: Reason.RateLimited, message: "x" } } : { body: {} }))
    await c.getUserHeldOrder(ID)
    assert.ok((sleeps[0] ?? 0) >= 2000)
  })

  it("does not wait beyond maxRetryWaitMs: the error is returned", async () => {
    const { c, calls, sleeps } = client([rateLimited(60_000)], { maxRetryWaitMs: 5_000 })
    await assert.rejects(c.cancelUserHeldOrder(ID), (e: unknown) => isRfqApiError(e) && e.code === Reason.RateLimited && e.retryAfterMs === 60_000)
    assert.equal(calls.length, 1)
    assert.equal(sleeps.length, 0)
  })

  it("is bounded by maxAttempts", async () => {
    const { c, calls } = client([rateLimited(10)], { maxAttempts: 3 })
    await assert.rejects(c.getUserHeldOrder(ID))
    assert.equal(calls.length, 3)
  })
})

describe("transient failures", () => {
  it("are retried with backoff for the reads, the place and the cancel (both keyed by the order id)", async () => {
    for (const fn of [
      (c: ReturnType<typeof client>["c"]) => c.getUserHeldOrder(ID),
      (c: ReturnType<typeof client>["c"]) => c.listUserHeldOrders(),
      (c: ReturnType<typeof client>["c"]) => c.getUserHeldTerms(4242),
      (c: ReturnType<typeof client>["c"]) => c.placeUserHeldOrder({ order: {} as never, deadlineMs: "1" }),
      (c: ReturnType<typeof client>["c"]) => c.cancelUserHeldOrder(ID),
    ]) {
      const { c, calls, sleeps } = client((n) => (n < 3 ? { status: 503, body: { code: Reason.Unavailable, message: "down" } } : { body: {} }))
      await fn(c)
      assert.equal(calls.length, 3)
      assert.equal(sleeps.length, 2)
      assert.ok((sleeps[1] ?? 0) >= (sleeps[0] ?? 0) * 0.5, "backoff does not shrink")
    }
  })

  it("include network errors and 502/504", async () => {
    const { c, calls } = client((n) => (n === 1 ? { throws: new TypeError("fetch failed") } : n === 2 ? { status: 504, text: "gateway timeout" } : { body: {} }))
    await c.getUserHeldOrder(ID)
    assert.equal(calls.length, 3)
  })

  it("never repeat a call its client did not mark safe to repeat: the first attempt may have run", async () => {
    for (const reply of [{ status: 503, body: { code: Reason.Unavailable, message: "down" } }, { throws: new TypeError("fetch failed") }] as Reply[]) {
      const f = fakeFetch([reply, { body: {} }])
      const caller = createCaller({ baseUrl: "https://api.example", auth: bearerAuth(() => "t"), fetch: f.fetch, sleep: async () => undefined })
      await assert.rejects(caller.call("POST", "/x", {}, false), (e: unknown) => isRfqApiError(e) && (e.status === 503 || e.status === 0))
      assert.equal(f.calls.length, 1)
    }
  })

  it("do not repeat a client error", async () => {
    for (const status of [400, 403, 404, 409, 500]) {
      const { c, calls } = client([{ status, body: { code: "X", message: "no" } }])
      await assert.rejects(c.getUserHeldOrder(ID))
      assert.equal(calls.length, 1, `status ${status}`)
    }
  })

  it("maxAttempts: 1 turns retries off", async () => {
    const { c, calls } = client([{ status: 503, body: {} }], { maxAttempts: 1 })
    await assert.rejects(c.getUserHeldOrder(ID))
    assert.equal(calls.length, 1)
  })

  it("time out an attempt and report it as such", async () => {
    const { c } = client([{ hang: true }], { timeoutMs: 20, maxAttempts: 1 })
    await assert.rejects(c.getUserHeldOrder(ID), (e: unknown) => isRfqApiError(e) && e.status === 0 && e.code === "TIMEOUT" && e.retryable)
  })

  it("a timed-out read is repeated", async () => {
    const { c, calls } = client((n) => (n === 1 ? { hang: true } : { body: {} }), { timeoutMs: 20 })
    await c.getUserHeldOrder(ID)
    assert.equal(calls.length, 2)
  })

  it("stop at once when the caller aborts", async () => {
    const ac = new AbortController()
    const { c, calls } = client([{ hang: true }], { timeoutMs: 5_000 })
    const p = c.getUserHeldOrder(ID, { signal: ac.signal })
    setTimeout(() => ac.abort(new Error("navigated away")), 10)
    await assert.rejects(p, /navigated away/u)
    assert.equal(calls.length, 1, "an aborted call must not be retried")
  })

  it("stop waiting between attempts when the caller aborts", async () => {
    const ac = new AbortController()
    const f = fakeFetch([{ status: 503, body: { code: "UNAVAILABLE", message: "x" } }])
    const c = createRfqClient({
      baseUrl: "https://api.example",
      getToken: () => "t",
      fetch: f.fetch,
      backoff: { initialMs: 60_000, maxMs: 60_000 },
    })
    const p = c.getUserHeldOrder(ID, { signal: ac.signal })
    setTimeout(() => ac.abort(new Error("stop")), 20)
    await assert.rejects(p, /stop/u)
    assert.equal(f.calls.length, 1)
  })
})

describe("backoffMs", () => {
  it("grows, is capped, and jitters inside its band", () => {
    for (let i = 0; i < 100; i++) {
      const d0 = backoffMs(0, { initialMs: 100, maxMs: 1_000, jitter: 0.5 })
      assert.ok(d0 >= 50 && d0 <= 100, String(d0))
      const d9 = backoffMs(9, { initialMs: 100, maxMs: 1_000, jitter: 0.5 })
      assert.ok(d9 >= 500 && d9 <= 1_000, String(d9))
    }
    assert.equal(backoffMs(3, { initialMs: 100, maxMs: 10_000, jitter: 0 }), 800)
  })
})
