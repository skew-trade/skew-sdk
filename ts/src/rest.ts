import type {
  CancelUserHeldOrderResponseJson,
  GetUserHeldOrderResponseJson,
  GetUserHeldTermsResponseJson,
  ListUserHeldOrdersResponseJson,
  PlaceUserHeldOrderResponseJson,
  UserHeldOrderStateJson,
  UserHeldOrderUpdateJson,
  UserHeldOrderViewJson,
} from "./gen/rfq/v1/held_pb"
import { RfqApiError } from "./errors"
import { bearerAuth, createCaller, type CallOptions, type RfqClientOptions } from "./http"
import { followStream } from "./stream"
import type { CancelUserHeldOrderWire, PlaceUserHeldOrderWire } from "./helduser"

export type { CallOptions, RfqClientOptions, TokenRequest, TransportOptions } from "./http"

/**
 * A fetch client for the edge's REST paths (grpc-gateway, protobuf JSON): a USER's held orders (./helduser plans and signs them):
 *
 *   GET  /api/v1/rfq/held/books/{book}/terms         -> GetUserHeldTermsResponseJson
 *   POST /api/v1/rfq/held/orders                     -> PlaceUserHeldOrderResponseJson
 *   POST /api/v1/rfq/held/orders/{orderId}/cancel    -> CancelUserHeldOrderResponseJson
 *   GET  /api/v1/rfq/held/orders/{orderId}           -> GetUserHeldOrderResponseJson
 *   GET  /api/v1/rfq/held/orders                     -> ListUserHeldOrdersResponseJson
 *   GET  /api/v1/rfq/held/updates                    -> a stream of UserHeldOrderUpdateJson
 *
 * A HELD ORDER is ONE Hyperliquid limit order (Gtc) and the cancel of
 * its cloid, both signed by the agent key the client holds and NOT sent: the
 * client reads the book's terms (`getUserHeldTerms`), plans and signs
 * (`planUserHeldOrder`, `signUserHeldOrder`, ./helduser) and hands both to
 * `placeUserHeldOrder` with a deadline. Skew pairs the order with makers' held
 * post-only orders and relays the signed bytes to Hyperliquid: what does not
 * fill rests on Hyperliquid's book in the user's own account until the deadline,
 * when Skew relays the cancel. To cancel sooner the client signs a cancel at that
 * moment (`signUserHeldCancel`) and hands it to `cancelUserHeldOrder`. Follow an
 * order with `watchUserHeldOrders`.
 *
 * Every call carries the session JWT as a Bearer token. Only the generated
 * `*Json` types are imported, with `import type`, so nothing from the protobuf
 * runtime reaches the bundle. The JSON is the gateway's wire format: 64-bit
 * integers (shares, deadlines, cursors) arrive as decimal STRINGS.
 * Never round-trip them through a `number`; use BigInt for arithmetic.
 *
 * HEADERS. The client sends only Accept, Authorization and Content-Type: the
 * gateway's CORS policy allows no others, so a browser would block a request
 * with, say, an Idempotency-Key.
 *
 * RETRIES (./http, shared with the maker client), by what is safe to repeat:
 *  - 401: the token is refreshed once (`getToken({ forceRefresh: true })`) and
 *    the call repeated, whatever it is: the edge refused it before doing work;
 *  - 429: the call is repeated after the wait the edge asked for (`retryAfterMs`),
 *    whatever it is, for the same reason, unless the wait exceeds `maxRetryWaitMs`;
 *  - network errors, timeouts, 502/503/504: repeated with backoff for the reads,
 *    `placeUserHeldOrder` and `cancelUserHeldOrder` (keyed by the order id, which
 *    the signed bytes fix).
 * Attempts are bounded by `maxAttempts`, and an AbortSignal stops everything.
 */

export interface ListUserHeldOrdersQuery {
  /** Only this book (the outcome id). */
  readonly book?: number
  /** Empty: every state. */
  readonly states?: readonly UserHeldOrderStateJson[]
  readonly limit?: number
  readonly pageToken?: string
}

export interface WatchUserHeldOrdersOptions {
  /** Resume after this cursor (the last one processed). 0 or absent: the changes from now on. */
  readonly cursor?: bigint | number | string
  /** Ends the stream. */
  readonly signal?: AbortSignal
  /**
   * Reopen the stream when it ends or fails, resuming after the last cursor seen (default true).
   * False: the generator ends with the first stream.
   */
  readonly reconnect?: boolean
  /**
   * Called each time a stream opens, with the cursor it resumes after. `resumed` false means it
   * had none and starts from NOW: whatever changed before is not replayed, so list the orders
   * then (`listUserHeldOrders`). With a cursor nothing is missed.
   */
  readonly onOpen?: (info: { readonly cursor: string; readonly resumed: boolean }) => void
  /** A stream silent this long is taken for dead and reopened (default 45 s; the edge beats every 15 s). */
  readonly idleTimeoutMs?: number
}

const HELD_ID = /^0x[0-9a-fA-F]{32}$/u

export function createRfqClient(opts: RfqClientOptions) {
  const caller = createCaller({ ...opts, auth: bearerAuth(opts.getToken) })
  const { call } = caller

  function checkHeldId(orderId: string) {
    if (!HELD_ID.test(orderId)) throw new RfqApiError(400, `not a held order id: ${orderId}`, "INVALID_ARGUMENT")
  }

  function heldOrdersPath(query: ListUserHeldOrdersQuery): string {
    const params = new URLSearchParams()
    if (query.book !== undefined) params.append("book", String(query.book))
    for (const s of query.states ?? []) params.append("states", s)
    if (query.limit !== undefined) params.append("limit", String(query.limit))
    if (query.pageToken !== undefined) params.append("pageToken", query.pageToken)
    const qs = params.toString()
    return qs === "" ? "/api/v1/rfq/held/orders" : `/api/v1/rfq/held/orders?${qs}`
  }

  return {
    // ---- held orders: the user's signed limit order, matched and relayed by Skew ----

    /**
     * What a held order on this book must be signed to: the assets, the network the signatures
     * are checked for, the bounds of the place's life and of the deadline, the cancel's grace,
     * the nonce window, the size cap, whether the book takes orders, and the SERVER's clock
     * (`userHeldClock`, ./helduser). UNAVAILABLE when this edge does not match held orders.
     */
    getUserHeldTerms(book: number, o?: CallOptions) {
      if (!Number.isSafeInteger(book) || book <= 0) throw new RfqApiError(400, `not a book: ${book}`, "INVALID_ARGUMENT")
      return call<GetUserHeldTermsResponseJson>("GET", `/api/v1/rfq/held/books/${book}/terms`, undefined, true, o)
    },

    /**
     * Place a held order: `signUserHeldOrder`'s answer (./helduser), sent as it is. Nothing is
     * sent to Hyperliquid by this call. The answer is the order as recorded, or a refusal (HTTP
     * 200) with a stable code (`isUserHeldRefusal`; TAKER_MISMATCH and BETA_REQUIRED are not
     * refusals but HTTP 403 errors, thrown as RfqApiError): the per-order codes (BAD_SIGNATURE, SIGNER_MISMATCH,
     * SIGNER_NOT_AUTHORIZED, NONCE_USED, CLOID_REUSED, MIN_VALUE, SIZE_CAP, EXPIRES_TOO_SOON, ...),
     * DEADLINE_TOO_SOON, DEADLINE_TOO_LATE, CLEAR_NONCE_TOO_LOW, OPEN_ORDERS_CAP,
     * SIGNER_NONCES_AHEAD, BOOK_NOT_OPEN, GEOFENCED, SCREENED, HALTED. Keyed by the order id
     * (`userHeldOrderId`): repeating the same signed bytes answers the order as it stands. On any
     * error place the SAME bytes again, never a re-signed order: that would be a second order.
     */
    placeUserHeldOrder(req: PlaceUserHeldOrderWire, o?: CallOptions) {
      return call<PlaceUserHeldOrderResponseJson>("POST", "/api/v1/rfq/held/orders", req, true, o)
    },

    /**
     * Cancel a held order now, with the cancel the user's agent signs AT THAT MOMENT
     * (`signUserHeldCancel(planUserHeldCancel(...), agent)`, ./helduser): an order Skew has not
     * sent ends CANCELLED at once; one that may be on Hyperliquid has the cancel recorded
     * (`cancelRequested`) and relayed as soon as it rests, then ends CANCELLED (or FILLED, if it
     * filled first). The answer is the order as it stands, or a refusal with a stable code when
     * the cancel itself is declined (`isUserHeldRefusal`: CANCEL_NOT_SIGNED, EXPIRES_TOO_SOON,
     * NONCE_USED, SIGNER_NOT_AUTHORIZED, ...): nothing changed, sign a new one and ask again.
     * Without `cancel` only an order nothing was sent for is cancelled. Repeating the same bytes
     * is safe.
     */
    async cancelUserHeldOrder(orderId: string, cancel?: CancelUserHeldOrderWire, o?: CallOptions) {
      checkHeldId(orderId)
      return call<CancelUserHeldOrderResponseJson>("POST", `/api/v1/rfq/held/orders/${orderId}/cancel`, cancel ?? {}, true, o)
    },

    async getUserHeldOrder(orderId: string, o?: CallOptions) {
      checkHeldId(orderId)
      return call<GetUserHeldOrderResponseJson>("GET", `/api/v1/rfq/held/orders/${orderId}`, undefined, true, o)
    },

    /** The caller's held orders, newest first (`userHeldOrder`, ./helduser, reads a view in full). */
    listUserHeldOrders(query: ListUserHeldOrdersQuery = {}, o?: CallOptions) {
      return call<ListUserHeldOrdersResponseJson>("GET", heldOrdersPath(query), undefined, true, o)
    },

    /** Every held order matching the query, page after page, newest first. */
    async *listAllUserHeldOrders(query: Omit<ListUserHeldOrdersQuery, "pageToken"> = {}, o?: CallOptions): AsyncGenerator<UserHeldOrderViewJson> {
      let pageToken: string | undefined
      do {
        const page: ListUserHeldOrdersResponseJson = await call<ListUserHeldOrdersResponseJson>(
          "GET",
          heldOrdersPath(pageToken === undefined ? query : { ...query, pageToken }),
          undefined,
          true,
          o,
        )
        yield* page.orders ?? []
        pageToken = page.nextPageToken === undefined || page.nextPageToken === "" ? undefined : page.nextPageToken
      } while (pageToken !== undefined)
    },

    /**
     * The caller's held orders as they change: one update at a time, heartbeats included (type
     * "heartbeat", no order; an update of type "order" carries the order as it now stands).
     * Every update carries the `cursor` to resume after. The stream is a long GET of JSON lines;
     * when it ends, stalls or the network fails, it is reopened after the last cursor seen, with
     * backoff, so nothing is missed (see `onOpen` for the one case that needs a list: a stream
     * with no cursor yet). A 401 refreshes the token once. It ends when `signal` aborts, and
     * throws RfqApiError on what a retry cannot mend (FORBIDDEN, INVALID_ARGUMENT, ...).
     *
     *     for await (const u of client.watchUserHeldOrders({ cursor: saved, signal }))
     *       if (u.order !== undefined) show(userHeldOrder(u.order)); save(u.cursor)
     */
    watchUserHeldOrders(w: WatchUserHeldOrdersOptions = {}): AsyncGenerator<UserHeldOrderUpdateJson, void, void> {
      const start = w.cursor === undefined || String(w.cursor) === "0" ? undefined : String(w.cursor)
      return followStream<UserHeldOrderUpdateJson, string>(caller, {
        ...(start === undefined ? {} : { start }),
        path: (cursor) => `/api/v1/rfq/held/updates${cursor === undefined ? "" : `?cursor=${cursor}`}`,
        advance: (cursor, u) => (u.cursor !== undefined && u.cursor !== "0" ? u.cursor : cursor),
        ...(w.signal === undefined ? {} : { signal: w.signal }),
        ...(w.reconnect === undefined ? {} : { reconnect: w.reconnect }),
        ...(w.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: w.idleTimeoutMs }),
        ...(w.onOpen === undefined ? {} : { onOpen: (cursor: string | undefined) => w.onOpen?.({ cursor: cursor ?? "0", resumed: cursor !== undefined }) }),
      })
    },
  }
}

export type RfqClient = ReturnType<typeof createRfqClient>
