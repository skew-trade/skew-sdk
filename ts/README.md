# @skew-trade/sdk

Skew RFQ's TypeScript SDK, for browsers, React Native and Node 20.19 or later (ESM).

- `@skew-trade/sdk`: the app SDK. A user's held orders (one Hyperliquid limit order planned from
  the book's terms, signed by an injected agent signer, placed, cancelled, read and followed), the
  public markets feed (`connectMarkets`) and Hyperliquid's L1 signing.
- `@skew-trade/sdk/maker`: the maker SDK. Firm held orders signed, replaced and withdrawn per
  book, listed, and the event feed followed by cursor and epoch.

It takes no key: pass a signer (a viem account, or anything with `address` and `signTypedData`).
Quick starts, the Go module and the maker specification are in the repository:
https://github.com/skew-trade/skew-sdk.

License: to be decided.
