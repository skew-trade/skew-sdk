/**
 * @skew-trade/sdk: the app SDK, for a browser, React Native or Node app trading on Skew RFQ for its
 * user. A market maker's SDK is the separate entry point `@skew-trade/sdk/maker`, which this one
 * never imports.
 *
 *  - the user's HELD ORDERS: one Hyperliquid limit order (Gtc) and the cancel of its cloid,
 *    planned from the book's terms (`planUserHeldOrder`: the server's clock, the bounds, the nonce
 *    rules) and signed with an injected signer (`signUserHeldOrder`: the app's agent wallet, never a
 *    raw key); the cancel on request (`planUserHeldCancel`, `signUserHeldCancel`); the order's id
 *    before the answer (`userHeldOrderId`); an order view read in full (`userHeldOrder`). Pinned to
 *    testdata/held_user_vectors.json;
 *  - `createRfqClient`: the edge's REST paths for those orders (getUserHeldTerms, placeUserHeldOrder,
 *    cancelUserHeldOrder, getUserHeldOrder, listUserHeldOrders and watchUserHeldOrders, the updates
 *    stream reopened and resumed by cursor by itself), with the session JWT as a Bearer token,
 *    retries by what is safe to repeat and typed errors (RfqApiError, Reason);
 *  - `connectMarkets`: the public markets feed: each market's book on Hyperliquid, in the held orders
 *    pool and in Skew RFQ, with book_seq resync, staleness in server time, state, top of book and
 *    the index, reconnect by close code;
 *  - Hyperliquid: the L1 action an agent key signs, byte for byte as Hyperliquid hashes it:
 *    canonical number strings, the msgpack of an order action, the action hash with its nonce and
 *    expiresAfter, the phantom agent's typed data; the HIP-4 rules (ids, tick, whole shares, the
 *    1 USDC minimum);
 *  - what a held order's two actions share with a maker's: the cancelByCloid (`heldClearAction`),
 *    `randomCloid`, the signed action's JSON;
 *  - the wire types: generated `*Json` types, re-exported with `export type`.
 *
 * Everything under ./gen is generated from proto/rfq/v1; do not edit it. NOTHING RUNTIME is
 * re-exported from ./gen: the generated modules execute a descriptor at import time that would
 * pull the protobuf runtime into the bundle, which a client gains nothing from. `export type` is
 * erased.
 *
 * The one runtime dependency is @noble/hashes (keccak256), tree-shaken to that single function.
 */

export * from "./rest"
export * from "./helduser"
export * from "./markets"
export * from "./errors"
export * from "./hl"
export { heldClearAction, randomCloid, type CancelByCloidAction, type HeldSignedWire, type SignedHeldOrder } from "./heldwire"
export { backoffMs, type BackoffOptions } from "./backoff"

export type { ErrorDetailJson, FieldViolationJson } from "./gen/rfq/v1/rfq_pb"

export type {
  AckFrameJson,
  BookDeltaJson,
  BookLevelJson,
  BookSnapshotJson,
  ClientOpJson,
  ErrorFrameJson,
  FeedFrameJson,
  HeartbeatFrameJson,
  HelloFrameJson,
  HelloLimitsJson,
  HlLayerJson,
  IndexEntryJson,
  IndexFrameJson,
  MarketsFrameJson,
  PongFrameJson,
  PoolLayerJson,
  RfqLayerJson,
  StateFrameJson,
  TobFrameJson,
  TobHlJson,
} from "./gen/rfq/v1/book_pb"

export type {
  CancelUserHeldOrderResponseJson,
  GetUserHeldOrderResponseJson,
  GetUserHeldTermsResponseJson,
  ListUserHeldOrdersResponseJson,
  PlaceUserHeldOrderResponseJson,
  UserHeldFillJson,
  UserHeldOrderStateJson,
  UserHeldOrderUpdateJson,
  UserHeldOrderViewJson,
  UserHeldRefusalJson,
} from "./gen/rfq/v1/held_pb"
