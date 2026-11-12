import { backoffMs } from "./backoff"
import { RfqApiError, errorFromResponse } from "./errors"
import type { Caller } from "./http"

/**
 * A server stream of the edge, followed across broken connections: a long GET of JSON lines,
 * grpc-gateway's form of a server-streaming RPC (`{"result": T}` per line, or `{"error": {...}}`
 * when the stream fails on its own path). Both clients of this package use it, each with its own
 * idea of where a stream stands: the app's order updates (a cursor) and a maker's event feed (a
 * cursor and its epoch).
 *
 *  - RESUME. After every item the stream's position moves on (`advance`); when the stream ends,
 *    stalls or fails it is reopened from there (`path(position)`), so nothing is missed and nothing
 *    is delivered twice. A stream with no position yet starts from NOW: `onOpen` says so.
 *  - SILENCE. A stream that sends nothing, not even a heartbeat, for `idleTimeoutMs` (default 45 s;
 *    the edge beats every 15 s) is taken for dead and reopened.
 *  - FAILURES. A 401 asks the caller's credential for a fresh one once, when it can refresh
 *    (`bearerAuth`), and is thrown otherwise. What is retryable (a network error, 429, 502, 503,
 *    504, a stall, the edge's UNAVAILABLE written on the stream) is reopened with backoff, after at
 *    least the wait the edge asked for. Anything else (FORBIDDEN, INVALID_ARGUMENT, ...) is thrown.
 *  - A stream that ended cleanly (the edge restarts, a proxy's limit) is reopened after a first wait.
 *  - `reconnect: false` ends the generator with the first stream and throws its failure.
 *  - It ends when `signal` aborts.
 */
export interface FollowOptions<T, P> {
  /** The path to open (base URL excluded), given where the stream stands; undefined: from now on. */
  readonly path: (at: P | undefined) => string
  /** Where the stream stands after an item. */
  readonly advance: (at: P | undefined, item: T) => P | undefined
  /** Where to start; absent: from now on. */
  readonly start?: P
  readonly signal?: AbortSignal
  /** Reopen the stream when it ends or fails (default true). */
  readonly reconnect?: boolean
  /** A stream silent this long is reopened (default 45 s). */
  readonly idleTimeoutMs?: number
  /** Called each time a stream opens, with the position it resumes from. */
  readonly onOpen?: (at: P | undefined) => void
}

/** The longest wait between two streams, whatever the edge asked for. */
const MAX_REOPEN_WAIT_MS = 60_000

/**
 * The error a stream writes on its own path, {"error": {"message": "[CODE] ...", "details":
 * [ErrorDetail]}}, under the status its code would have had as a response.
 */
function inStreamError(line: unknown, text: string): RfqApiError {
  const e = errorFromResponse(500, errorBody(line), text)
  const status =
    e.code === "UNAUTHENTICATED" ? 401 : e.code === "RATE_LIMITED" || e.code === "TOO_MANY_STREAMS" ? 429 : e.code === "UNAVAILABLE" ? 503 : 500
  return new RfqApiError(status, e.message, e.code, e.body, e.retryAfterMs, e.violations)
}

/** A stream refused at its opening may write its error in the stream's shape, {"error": {...}}. */
function errorBody(body: unknown): unknown {
  return typeof body === "object" && body !== null && "error" in body ? (body as { error: unknown }).error : body
}

export async function* followStream<T, P>(caller: Caller, o: FollowOptions<T, P>): AsyncGenerator<T, void, void> {
  let at = o.start
  const reconnect = o.reconnect ?? true
  const idleMs = o.idleTimeoutMs ?? 45_000
  let failures = 0
  let refresh = false
  let refreshed = false
  for (;;) {
    if (o.signal?.aborted) return
    const credential = await caller.auth.headers(refresh ? { forceRefresh: true } : undefined)
    refresh = false
    const ctrl = new AbortController()
    let stalled = false
    let idle: ReturnType<typeof setTimeout> | undefined
    const arm = () => {
      clearTimeout(idle)
      idle = setTimeout(() => {
        stalled = true
        ctrl.abort()
      }, idleMs)
    }
    const onCaller = () => ctrl.abort(o.signal?.reason)
    o.signal?.addEventListener("abort", onCaller, { once: true })
    let failure: RfqApiError | undefined
    try {
      arm()
      const response = await caller.fetch(`${caller.base}${o.path(at)}`, {
        method: "GET",
        signal: ctrl.signal,
        headers: { Accept: "application/json", ...credential },
      })
      if (!response.ok || response.body === null) {
        const text = await response.text().catch(() => "")
        let parsed: unknown = null
        try {
          parsed = JSON.parse(text)
        } catch {
          // not JSON: the text is the message
        }
        throw errorFromResponse(response.status, errorBody(parsed), text, response.headers.get("Retry-After"))
      }
      o.onOpen?.(at)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ""
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          arm()
          buffered += decoder.decode(value, { stream: true })
          for (let nl = buffered.indexOf("\n"); nl >= 0; nl = buffered.indexOf("\n")) {
            const line = buffered.slice(0, nl).trim()
            buffered = buffered.slice(nl + 1)
            if (line === "") continue
            const msg = JSON.parse(line) as { result?: T; error?: unknown }
            if (msg.error !== undefined) throw inStreamError(msg, line)
            if (msg.result === undefined) continue
            // The stream is alive and in order: what failed before is behind it.
            failures = 0
            refreshed = false
            at = o.advance(at, msg.result)
            yield msg.result
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined)
      }
    } catch (error) {
      if (o.signal?.aborted) return
      failure =
        error instanceof RfqApiError
          ? error
          : new RfqApiError(
              0,
              stalled ? `the stream was silent for ${idleMs} ms` : `network error: ${String((error as Error | undefined)?.message ?? error)}`,
              stalled ? "TIMEOUT" : "NETWORK",
            )
    } finally {
      clearTimeout(idle)
      o.signal?.removeEventListener("abort", onCaller)
      ctrl.abort()
    }
    if (o.signal?.aborted) return
    if (failure !== undefined) {
      if (failure.status === 401 && caller.auth.refreshes && !refreshed) {
        refreshed = true
        refresh = true
        continue
      }
      if (!reconnect || !failure.retryable) throw failure
      failures += 1
    } else if (!reconnect) {
      return
    }
    const delay = Math.max(failure?.retryAfterMs ?? 0, backoffMs(Math.max(0, failures - 1), caller.backoff))
    try {
      await caller.sleep(Math.min(delay, MAX_REOPEN_WAIT_MS), o.signal)
    } catch {
      return
    }
  }
}
