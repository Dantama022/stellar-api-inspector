# Overlay batch inspection

`overlay-batch fixtures.json --compare other.json --json` inspects a local JSON array of `{ id?, xdr }` samples through the installed SDK's `StellarMessage` decoder. It reports each decode outcome and aggregate type/outcome counts without contacting a peer.

Cross-collection additions, removals, and changes are calculated only for explicit fixture IDs. Anonymous fixtures are intentionally never guessed to represent the same network message. Malformed XDR and SDKs that do not expose overlay definitions produce diagnostics in the per-item result rather than terminating the batch.

See `tests/fixtures/overlay-batch.json` for the input shape.
