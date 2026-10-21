# XDR Round-Trip Integrity Audit

```
stellar-api-inspector xdr-roundtrip-audit \
  --xdr <base64> | --file <path> | --stdin \
  [--type <name>] [-j] [-o <path>]
```

Read-only. Decodes and re-encodes a Stellar XDR artifact using the repository's `@stellar/stellar-sdk` utilities and reports round-trip integrity.

## Supported types

- `TransactionEnvelope`
- `Transaction`
- `Operation`
- `LedgerEntry`
- `ScVal`
- `ScSpecEntry`
- `AccountId`
- `MuxedAccount`

When `--type` is not supplied, the audit tries each type in the order above and uses the first one that decodes.

## Comparison strategy (documented)

1. Hash the original bytes with SHA-256.
2. Decode → re-encode using the SDK.
3. Hash the re-encoded bytes.
4. If hashes match: **`IDENTICAL`** (info).
5. If hashes differ, re-decode the re-encoded bytes and compare structural JSON to the original's structural JSON.
   - Structures match: **`DIFFERS_BUT_SEMANTICALLY_EQUAL`** (warning — representation difference only).
   - Structures differ: **`SEMANTIC_DRIFT`** (error — confirmed failure).
6. Decode failure: **`DECODE_FAILED`** (error).
7. Encode failure after successful decode: **`ENCODE_FAILED`** (error).
8. No type matched: **`UNSUPPORTED`** (error).

## What is NOT a finding

- A byte-level difference **alone** is not reported as "corruption".
- A `DIFFERS_BUT_SEMANTICALLY_EQUAL` result is a **warning**, not an error, because representation differences (e.g. signed vs unsigned envelope form, optional field padding) are legitimate.

## Limitations

- Only XDR types exposed by `@stellar/stellar-sdk`'s `.fromXDR()` / `.toXDR()` are supported.
- Protocol-version-specific representation quirks are not exhaustively enumerated; a `DIFFERS_BUT_SEMANTICALLY_EQUAL` result may simply indicate that the SDK's canonical encoding differs from the input's encoding for a legitimate reason.
- Never signs, submits, or mutates the artifact.
- No network I/O.