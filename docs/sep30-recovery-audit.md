# SEP-30 Recovery Audit (`--audit` mode)

```
stellar-api-inspector sep30-recovery-audit <accountId> [--response <json>] [--file <path>] [--stdin] \
  [--horizon <url>] [-j] [-o <path>]
```

Read-only. Extends the existing `sep30-recovery-inspect` command with a schema audit of the SEP-30 recovery response. The existing `sep30-recovery-inspect` command and its tests remain unchanged — the audit extension is exposed as a **separate command** so existing users are not affected.

## What is validated (audit mode adds)

- Recovery response is a JSON object.
- `signers` field, if present, is an array.
- Each signer entry has a `key` field that is a valid Stellar Ed25519 public key.
- Each signer's `weight`, if present, is a non-negative integer.
- Unknown top-level fields are reported as `info` findings (forward-compatible).
- Potentially sensitive top-level fields (`token`, `secret`, `password`, `jwt`, `auth`, etc.) are redacted — their names may appear in `redactedFields`, but their values are never echoed.

## Always reported as inconclusive (in audit mode)

- `ACCOUNT_OWNERSHIP_NOT_VERIFIED` — a structurally valid SEP-30 response does not prove account ownership.
- `RECOVERY_OUTCOME_NOT_VERIFIED` — a valid response does not prove recovery has succeeded or will succeed.
- `RECOVERY_AUTHORIZATION_NOT_VERIFIED` — a valid signer list does not prove any specific recovery operation is authorized.

## What is **not** validated

- Whether the anchor actually processed a recovery request.
- Whether the returned signers are sufficient for a particular recovery operation.
- Whether the account holder consented to recovery.

## Limitations

- The audit is static. All conclusions about ownership, authorization, and recovery outcome are reported as inconclusive.
- The Horizon call (GET /accounts/:address) is only used to compare against on-chain signers. It is not a proof of anything on its own.
- The inspector never modifies account state and never requests signatures.