# Account Data Entry Audit (ISSUE-164)

Compares two account data snapshots and validates key/value encoding.

```bash
stellar-api-inspector account-data-entry-audit --before before.json --after after.json [--keys a,b] [--categories added,modified] [--include-unchanged] [--json]
stellar-api-inspector account-data-entry-audit --before before.json --after horizon --account GABC... --horizon <url>
```

## Inputs

A snapshot file uses the format of the existing `account-data-snapshot-diff` command:

```json
{ "schemaVersion": 1, "accountId": "GABC...", "network": null, "capturedAt": "2026-01-01T00:00:00Z", "entries": { "key": "dmFsdWU=" } }
```

Pass `horizon` instead of a file to fetch the account's current data entries.

## Behavior

- Keys are sorted, so output is deterministic. Entries are `added`, `removed`, `modified` or `unchanged`; unchanged entries are hidden unless `--include-unchanged` is passed.
- Each side shows the raw base64, decoded hex, and UTF-8 text when the bytes are valid text. `rawChanged` and `decodedChanged` are reported separately. `decodedChanged` is `null` when a side cannot be decoded.
- Protocol checks: key 1-64 bytes (`KEY_EMPTY`, `KEY_TOO_LONG`), value valid base64 (`INVALID_BASE64`), decoded value ≤ 64 bytes (`VALUE_TOO_LONG`). Non-UTF-8 values are valid binary, not errors.
- Snapshots for different accounts produce `ACCOUNT_MISMATCH` and status `failed`.
- Unreadable or invalid snapshot inputs exit with a clear error.
