# Changelog

All notable changes to this SDK. Versions follow [Semantic Versioning](https://semver.org): until
1.0.0 a minor version may change the API.

## 0.1.0 (unreleased)

The first release.

- **Go** (`github.com/skew-trade/skew-sdk`): `makerclient`, the maker API's client (book rules,
  book replacement and withdrawal, the order listing, the event feed resumed by cursor and epoch);
  `userclient`, a user's held orders (terms, place, cancel, get, list, the updates feed resumed by
  cursor); `heldsign`, the signing of a held order's two actions, pinned to
  `testdata/held_vectors.json` (`heldsigntest.Check` re-signs the vectors from your module's
  tests); `transport`, the retry schedule and the edge's error reasons; `gen/rfq/v1`, the wire
  types and gRPC clients.
- **TypeScript** (`@skew-trade/sdk`): `.`, the app SDK (a user's held orders planned, signed,
  placed, cancelled and followed; the markets feed; Hyperliquid's L1 signing) and `./maker`, the
  maker SDK.
- **Protos** (`proto/rfq/v1`): `RFQService` (a user's held orders), `HeldOrderService` (the maker
  API) and the markets feed's frames.
- **Docs**: `docs/MAKER-SPEC.md`, the maker specification (version 1.6).
