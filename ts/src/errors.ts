import type { FieldViolationJson } from "./gen/rfq/v1/rfq_pb"

/**
 * The stable reasons the edge puts on its errors (rfq.proto, "ERRORS"). Branch
 * on these, never on the message text.
 */
export const Reason = {
  Unauthenticated: "UNAUTHENTICATED",
  BetaRequired: "BETA_REQUIRED",
  TakerMismatch: "TAKER_MISMATCH",
  Geofenced: "GEOFENCED",
  Screened: "SCREENED",
  InvalidArgument: "INVALID_ARGUMENT",
  BadSignature: "BAD_SIGNATURE",
  NotFound: "NOT_FOUND",
  OrderNotCancellable: "ORDER_NOT_CANCELLABLE",
  RateLimited: "RATE_LIMITED",
  OpenOrdersCap: "OPEN_ORDERS_CAP",
  TooManyStreams: "TOO_MANY_STREAMS",
  CursorTooOld: "CURSOR_TOO_OLD",
  Unavailable: "UNAVAILABLE",
  Internal: "INTERNAL",
} as const

export type ReasonCode = (typeof Reason)[keyof typeof Reason]

/**
 * A failed call. `status` is the HTTP status (0 when the request never got an
 * answer: a network error or a timeout), `code` the edge's stable reason when it
 * sent one, `retryAfterMs` the wait it asked for.
 */
export class RfqApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly body?: unknown,
    readonly retryAfterMs?: number,
    readonly violations: readonly FieldViolationJson[] = [],
  ) {
    super(message)
    this.name = "RfqApiError"
  }

  /** True when the same request may succeed later without a change. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status === 502 || this.status === 503 || this.status === 504
  }
}

/** True for the error a call throws. */
export function isRfqApiError(e: unknown): e is RfqApiError {
  return e instanceof RfqApiError
}

interface ErrorBody {
  code?: unknown
  message?: unknown
  details?: unknown
}

/** Builds the error for a non-2xx response from the gateway's body, {"code","message","details":[ErrorDetail]}. */
export function errorFromResponse(status: number, body: unknown, text: string, retryAfterHeader?: string | null): RfqApiError {
  const b = (typeof body === "object" && body !== null ? body : {}) as ErrorBody
  const details = Array.isArray(b.details) ? (b.details as Record<string, unknown>[]) : []
  const detail = details.find((d) => typeof d["@type"] === "string" && String(d["@type"]).endsWith("rfq.v1.ErrorDetail")) ?? {}
  const code = typeof b.code === "string" ? b.code : typeof detail["reason"] === "string" ? detail["reason"] : undefined
  let retryAfterMs = typeof detail["retryAfterMs"] === "number" ? detail["retryAfterMs"] : undefined
  if (retryAfterMs === undefined && retryAfterHeader) {
    const secs = Number(retryAfterHeader)
    if (Number.isFinite(secs) && secs >= 0) retryAfterMs = secs * 1000
  }
  const violations = Array.isArray(detail["violations"]) ? (detail["violations"] as FieldViolationJson[]) : []
  return new RfqApiError(
    status,
    typeof b.message === "string" ? b.message : text !== "" ? text.slice(0, 200) : `request failed with ${status}`,
    code,
    body ?? text,
    retryAfterMs,
    violations,
  )
}
