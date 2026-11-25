# Offline Stellar overlay-message analysis

The overlay commands operate only on an ordered JSON array of already-decoded fixtures. They do not contact a Stellar peer, change a fixture, or replace peer-connectivity and SCP diagnostics.

## Commands and reports

- `overlay-sequence fixtures.json --json` reports supported request/response relationships. `GET_PEERS → PEERS`, `GET_TX_SET → TX_SET`, and `GET_SCP_QUORUMSET → SCP_QUORUMSET` are confirmed only when their available correlation values match. Without correlation values, a same-peer supported pair is explicitly marked **inferred**. An identified request with a correlation value and no response is **incomplete**. Decreasing adjacent valid timestamps are reported as out of order.
- `overlay-size-audit fixtures.json --threshold 65536 --json` uses supplied `encodedSize` or base64 `encodedXdr` bytes. It reports a protocol violation only when a caller supplies a documented `type → protocolVersion → byte limit` mapping through the API. The CLI otherwise makes no unsafe claim that a universal Core limit applies; its threshold is advisory.
- `overlay-privacy fixtures.json --categories account,transaction --json` produces a cloned report with `[REDACTED:CATEGORY]` markers. `--preview` identifies fields without changing report values. Supported categories are `account`, `transaction`, and `authentication`; detection is field-aware, including nested arrays and objects, rather than generic string matching.
- `overlay-schema fixtures.json --type PEERS --sdk-version <version> --json` exports `stellar-api-inspector/overlay-schema@1`, a structural description inferred from an SDK-decoded fixture. This avoids a separate hand-maintained XDR schema. Fields or union arms absent from the fixture remain unavailable and are called out in `limitations`.

## Fixture shape

Each fixture requires `type`; optional fields include `id`, `timestamp`, `peerId`, `direction`, `correlationId`, `references`, `payload`, `encodedXdr`, `encodedSize`, and `protocolVersion`. See `tests/fixtures/overlay-messages.json` for complete and incomplete exchange examples.

## Limitations and privacy

Sequence analysis never creates a confirmed conversation link from missing fields. Repetition is reported only when a message has an available correlation value. An unavailable encoded size or protocol-specific limit is reported as unknown rather than a pass. Redaction is for report generation only: callers retain their original fixture values and must still decide whether unrecognized message fields contain material that should not be shared.
