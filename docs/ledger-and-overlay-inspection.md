# Overlay batch inspection

`overlay-batch fixtures.json --compare other.json --json` inspects a local JSON array of `{ id?, xdr }` samples through the installed SDK's `StellarMessage` decoder. It reports each decode outcome and aggregate type/outcome counts without contacting a peer.

Cross-collection additions, removals, and changes are calculated only for explicit fixture IDs. Anonymous fixtures are intentionally never guessed to represent the same network message. Malformed XDR and SDKs that do not expose overlay definitions produce diagnostics in the per-item result rather than terminating the batch.

See `tests/fixtures/overlay-batch.json` for the input shape.
# Local ledger-key and overlay XDR inspection

`ledger-key-coverage keys.json --expected expected.json --json` accepts JSON arrays of base64 `LedgerKey` XDR. It decodes with the installed SDK, canonicalizes decoded keys to base64, reports categories, duplicates, missing/extra keys, and undecodable inputs. It performs no RPC request, storage snapshot query, or transaction simulation.

`overlay-xdr <base64> --json` uses the installed SDK's `StellarMessage` definition where exposed. Malformed data and SDKs without overlay definitions return diagnostics rather than crashing. `--target-types HELLO,PEERS` performs an explicit compatibility comparison; without a target definition set, compatibility is intentionally inconclusive.

`overlay-batch fixtures.json --compare other.json --json` reports each decode outcome and counts by type. Cross-collection changes are calculated only for explicit fixture IDs; anonymous samples are deliberately not guessed to be the same message.

See `tests/fixtures/overlay-batch.json` for the batch input shape. Version context comes only from the installed SDK and explicitly supplied target types; it is never inferred from malformed or opaque payload data.
