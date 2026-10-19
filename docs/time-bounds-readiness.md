# Transaction Time-Bounds and Ledger-Window Readiness Audit

`stellar-inspector time-bounds-readiness <envelopeXdr|txHash> [--passphrase <p>] [-h <horizon>] [--json] [-o <path>]`

Decodes a transaction envelope (base64 XDR, fee-bump envelopes use the inner transaction), or
fetches the envelope for a 64-character transaction hash from Horizon, and compares its time bounds
with the close time of the latest ledger (`GET /ledgers?order=desc&limit=1`). Nothing is signed,
submitted or modified.

Rules (all times Unix seconds, reported in UTC ISO-8601):
- A time bound of 0 means "not set". A transaction without bounds is reported as having none, not
  as expired.
- `maxTime` earlier than the observed ledger close time: `warning` (may be outside its window).
- `minTime` later than the observed close time: `warning` (not yet time-eligible).
- Equal values are inside the window (minTime <= close time <= maxTime).
- minTime later than maxTime, or an undecodable envelope: `failed`.
- Unavailable ledger information: `inconclusive`; a close time is never guessed.
- Otherwise `ready`.

Limitations: this is a snapshot against the latest observed ledger, not a prediction of the
inclusion ledger and not a guarantee of inclusion or rejection. Network conditions, sequence
numbers, fees, signatures and other preconditions also determine eligibility. For hash input the
transaction is already on the ledger, so the result is informational. Decoding uses the testnet
passphrase unless `--passphrase` is given; time bounds do not depend on it.
