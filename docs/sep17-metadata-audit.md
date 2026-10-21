# SEP-17 Metadata Inspection (Unpublished Specification)

```
stellar-api-inspector sep17-metadata-inspect [--response <json>] [--file <path>] [--stdin] [--asset <CODE:ISSUER>] [-j] [-o <path>]
```

**Important:** SEP-17 has no published schema in the Stellar SEP numbering. This command exists to satisfy the issue scope in a specification-faithful way. It **always** emits a `SEP17_UNPUBLISHED_SPEC` inconclusive finding and points callers at the actual specifications that cover the intent described in the issue.

## What is reported

- Whether the payload is a JSON object.
- Top-level field names (values never echoed).
- Optional name-only consistency check against a supplied `--asset CODE:ISSUER` reference — this compares payload `code`/`issuer` strings if present, but never infers presence or absence.

## What is **not** reported

- Whether the asset is genuine, safe, authorized, or trustworthy.
- Whether the metadata conforms to any specific schema (there is no SEP-17 schema to conform to).
- On-chain existence or issuer authorization.

## Actual specs for the intent

- **SEP-1 `stellar.toml` `[[CURRENCIES]]`** — off-chain asset metadata → use `asset-metadata-audit`.
- **SEP-41 Soroban Token Interface** — on-chain token metadata (`symbol`, `name`, `decimals`) → use `contract-spec-audit` against the token contract.

## Limitations

- No schema exists to validate against, so this command cannot produce an authenticity or conformance determination of any kind.
- `ASSET_AUTHENTICITY_NOT_VERIFIED` is emitted as an inconclusive finding on every invocation.
- No network I/O.