/** An exponential backoff with jitter, shared by the REST retries and the stream's reconnects. */
export interface BackoffOptions {
  /** First wait, ms (default 500). */
  readonly initialMs?: number
  /** Longest wait, ms (default 15000). */
  readonly maxMs?: number
  /** Growth per attempt (default 2). */
  readonly factor?: number
  /** Fraction of the wait that is random, 0..1 (default 0.5: the wait is uniform in [d/2, d]). */
  readonly jitter?: number
}

/** The wait before retry number `attempt` (0 is the first retry). */
export function backoffMs(attempt: number, o: BackoffOptions = {}): number {
  const initial = o.initialMs ?? 500
  const max = o.maxMs ?? 15_000
  const factor = o.factor ?? 2
  const jitter = Math.min(1, Math.max(0, o.jitter ?? 0.5))
  const d = Math.min(max, initial * factor ** attempt)
  return d * (1 - jitter) + Math.random() * d * jitter
}

/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
