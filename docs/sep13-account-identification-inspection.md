# SEP-13 Inspection (Unpublished Specification)

```
stellar-api-inspector sep13-inspect [--response <json>] [--file <path>] [--stdin] [-j] [-o <path>]
```

**Important:** SEP-13 has no published schema in the Stellar SEP numbering. This command exists to satisfy the issue scope in a specification-faithful way. It **always** emits a `SEP13_UNPUBLISHED_SPEC` inconclusive finding, validates any Stellar account identifiers it finds (format only), and points callers at SEP-30 for account recovery.

## What is reported

- Whether the payload is a JSON object.
- Paths to any string values that look like Stellar account IDs (56-char `G...` shape).
- Whether each such string is a valid Ed25519 public key (a **format check only**).

## What is **not** reported

- Account ownership of any kind.
- Recovery authorization of any kind.
- Whether a recovery operation would succeed.

## Actual spec for account recovery

**SEP-30** → use `sep30-recovery-inspect --audit` (added in ISSUE-147) for signer/threshold inspection with schema audit.

**SEP-10** → web authentication, separate concern.

## Limitations

- No schema exists to validate against, so this command cannot produce a recovery determination of any kind.
- Syntactically valid account identifiers are **not** proof of ownership — this is reported as an inconclusive finding every time.
- The command never initiates any recovery operation.