import { backoffMs, sleep as defaultSleep, type BackoffOptions } from "./backoff"
import { RfqApiError, errorFromResponse } from "./errors"

/**
 * One call to the edge's REST paths (grpc-gateway, protobuf JSON), with the retries and typed
 * errors both clients of this package share: the app's (`createRfqClient`, ./rest: a user's session
 * JWT) and a maker's (`createMakerClient`, ./maker: the maker's API key). Each client says which of
 * its calls are safe to repeat; the reconnecting stream (./stream) uses the same caller.
 *
 * AUTH, one of two strategies:
 *  - `bearerAuth(getToken)`: the session JWT as `Authorization: Bearer <jwt>`. A 401 asks for a
 *    fresh token once (`getToken({ forceRefresh: true })`) and repeats the call, whatever it is:
 *    the edge refused it before doing any work;
 *  - `makerKeyAuth(key)`: the maker's API key in `X-Skew-Maker-Key`, read on every call (a
 *    function may hand a rotated key). A 401 is final: a key the edge does not know costs the
 *    caller's address a token of the edge's bad-key bucket, and the same key would fail again.
 *
 * HEADERS. Accept, Content-Type when there is a body, and the strategy's one header: nothing else.
 * The gateway's CORS policy allows no other custom header, so a browser would block a request
 * with, say, an Idempotency-Key.
 *
 * RETRIES, by what is safe to repeat:
 *  - 429 (RATE_LIMITED, TOO_MANY_STREAMS): repeated after the wait the edge asked for
 *    (`retryAfterMs`), whatever the call is, since the edge refuses those before it reads the
 *    request; unless the wait exceeds `maxRetryWaitMs`;
 *  - network errors, an attempt's timeout and 502/503/504, where the first attempt may have run:
 *    repeated with backoff only for a call its client marks safe to repeat;
 *  - anything else (400, 403, 404, 409, 500, ...) is thrown as it is.
 * Attempts are bounded by `maxAttempts` (a call may ask for more), and an AbortSignal stops
 * everything, a wait between attempts included.
 */

export interface TokenRequest {
  /** Set after the server rejected the previous token: mint or fetch a fresh one. */
  readonly forceRefresh?: boolean
}

/** How a client proves who it is: the headers each request carries. */
export interface Auth {
  /** The credential's headers. `forceRefresh` is set after the edge refused the last one. */
  headers(request?: TokenRequest): Promise<Record<string, string>>
  /** Whether a refused credential (401) is worth one more attempt with a fresh one. */
  readonly refreshes: boolean
}

/** A user's session JWT as a Bearer token. `getToken` is called on every call, and again with `forceRefresh` after a 401. */
export function bearerAuth(getToken: (request?: TokenRequest) => string | Promise<string>): Auth {
  return {
    refreshes: true,
    headers: async (request) => ({ Authorization: `Bearer ${await getToken(request)}` }),
  }
}

/** The header a maker's API key travels in. */
export const MAKER_KEY_HEADER = "X-Skew-Maker-Key"

/** A maker's API key (skm_...), or a function that returns it (read on every call). A 401 is not retried. */
export function makerKeyAuth(key: string | (() => string | Promise<string>)): Auth {
  return {
    refreshes: false,
    headers: async () => ({ [MAKER_KEY_HEADER]: typeof key === "function" ? await key() : key }),
  }
}

/** What both clients take besides their credential: the transport and the retry schedule. */
export interface TransportOptions {
  /** The edge's base URL, e.g. "https://rfq.skew.trade" (a trailing slash is dropped). */
  readonly baseUrl: string
  /** Injectable for tests and for runtimes without a global fetch. */
  readonly fetch?: typeof fetch
  /** Attempts per call, the first included (1 turns retries off). */
  readonly maxAttempts?: number
  /** Backoff between attempts. */
  readonly backoff?: BackoffOptions
  /** The longest single wait, including one the server asked for (default 10 s). */
  readonly maxRetryWaitMs?: number
  /** One attempt's timeout. */
  readonly timeoutMs?: number
  /** Replaces the timer between attempts (tests). */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** The app's client: the transport and the user's session JWT. Defaults: 3 attempts, 300 ms doubling to 4 s, a 15 s attempt. */
export interface RfqClientOptions extends TransportOptions {
  /** Returns the current session JWT. Called on every call, and again with `forceRefresh` after a 401. */
  readonly getToken: (request?: TokenRequest) => string | Promise<string>
}

/** Per-call options. */
export interface CallOptions {
  /** Cancels the call and its retries. */
  readonly signal?: AbortSignal
}

/** What a client adds to a call's options: a bound of its own, and a count of the attempts sent. */
export interface CallControl extends CallOptions {
  /** This call's attempts, when above `maxAttempts` (a maker's withdraw). */
  readonly attempts?: number
  /** Told of every attempt as it is sent. */
  readonly onSend?: () => void
}

/** The defaults a client gives its caller where its options say nothing. */
export interface CallerDefaults {
  readonly maxAttempts: number
  readonly backoff: BackoffOptions
  readonly timeoutMs: number
}

/** The app's defaults. */
export const USER_DEFAULTS: CallerDefaults = { maxAttempts: 3, backoff: { initialMs: 300, maxMs: 4_000 }, timeoutMs: 15_000 }

export interface Caller {
  /**
   * One call with its retries; `safeToRepeat` allows repeating it after a failure where the first
   * attempt may have run.
   */
  call<T>(method: "GET" | "POST", path: string, payload: unknown, safeToRepeat: boolean, o?: CallControl): Promise<T>
  /** The base URL without a trailing slash. */
  readonly base: string
  readonly fetch: typeof fetch
  readonly auth: Auth
  readonly backoff: BackoffOptions
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
}

export function createCaller(opts: TransportOptions & { readonly auth: Auth }, defaults: CallerDefaults = USER_DEFAULTS): Caller {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const maxAttempts = Math.max(1, opts.maxAttempts ?? defaults.maxAttempts)
  const backoff: BackoffOptions = opts.backoff ?? defaults.backoff
  const maxRetryWaitMs = opts.maxRetryWaitMs ?? 10_000
  const timeoutMs = opts.timeoutMs ?? defaults.timeoutMs
  const wait = opts.sleep ?? defaultSleep
  const base = opts.baseUrl.replace(/\/+$/u, "")
  const auth = opts.auth

  /** One attempt. Throws RfqApiError (or the caller's abort reason). */
  async function once<T>(method: string, path: string, body: string | undefined, credential: Record<string, string>, callerSignal?: AbortSignal): Promise<T> {
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeoutMs)
    const onCaller = () => ctrl.abort(callerSignal?.reason)
    if (callerSignal?.aborted) ctrl.abort(callerSignal.reason)
    callerSignal?.addEventListener("abort", onCaller, { once: true })
    try {
      let response: Response
      try {
        response = await doFetch(`${base}${path}`, {
          method,
          signal: ctrl.signal,
          headers: {
            Accept: "application/json",
            ...credential,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body }),
        })
      } catch (error) {
        if (callerSignal?.aborted) throw error
        throw new RfqApiError(
          0,
          timedOut ? `request timed out after ${timeoutMs} ms` : `network error: ${String((error as Error | undefined)?.message ?? error)}`,
          timedOut ? "TIMEOUT" : "NETWORK",
        )
      }
      const text = await response.text().catch(() => "")
      let parsed: unknown = null
      if (text !== "") {
        try {
          parsed = JSON.parse(text)
        } catch {
          if (response.ok) throw new RfqApiError(response.status, "response was not JSON", undefined, text)
        }
      }
      if (!response.ok) throw errorFromResponse(response.status, parsed, text, response.headers.get("Retry-After"))
      return parsed as T
    } finally {
      clearTimeout(timer)
      callerSignal?.removeEventListener("abort", onCaller)
    }
  }

  async function call<T>(method: "GET" | "POST", path: string, payload: unknown, safeToRepeat: boolean, o: CallControl = {}): Promise<T> {
    const body = payload === undefined ? undefined : JSON.stringify(payload)
    const bound = Math.max(maxAttempts, o.attempts ?? 0)
    let refreshed = false
    let credential = await auth.headers()
    for (let attempt = 1; ; attempt += 1) {
      try {
        o.onSend?.()
        return await once<T>(method, path, body, credential, o.signal)
      } catch (error) {
        if (o.signal?.aborted || !(error instanceof RfqApiError)) throw error
        if (attempt >= bound) throw error
        let delay: number
        if (error.status === 401) {
          if (!auth.refreshes || refreshed) throw error
          refreshed = true
          credential = await auth.headers({ forceRefresh: true })
          delay = 0
        } else if (error.status === 429) {
          delay = Math.max(error.retryAfterMs ?? 0, backoffMs(attempt - 1, backoff))
          if (delay > maxRetryWaitMs) throw error
        } else if (safeToRepeat && error.retryable) {
          delay = backoffMs(attempt - 1, backoff)
        } else {
          throw error
        }
        if (delay > 0) await wait(delay, o.signal)
      }
    }
  }

  return { call, base, fetch: doFetch, auth, backoff, sleep: wait }
}

/** A query string from its parameters: absent and empty values left out, an array as one repeated key. */
export function queryString(q: Record<string, string | number | readonly string[] | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === "") continue
    if (Array.isArray(v)) for (const x of v as readonly string[]) p.append(k, x)
    else p.set(k, String(v))
  }
  const s = p.toString()
  return s === "" ? "" : `?${s}`
}
