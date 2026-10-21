# SEP-8 Regulated Asset Approval Inspection

```
stellar-api-inspector sep8-approve-inspect [--request <json>] [--request-file <path>] \
  [--response <json>] [--response-file <path>] [--stdin request|response] \
  [--tx <envelope-xdr>] [-j] [-o <path>]
```

Read-only. Validates SEP-8 approve-request and approve-response structures against the fields documented in the SEP-8 specification.

## What is validated

- **Approve request**: `tx` (base64), `asset_code` (1–12 alphanumeric), `asset_issuer` (Stellar Ed25519 public key), `amount` (decimal ≤7 places), `operation`.
- **Approve response**: `status` (`success`, `revised`, `pending`, `action_required`, `rejected`); `revised` requires a new `tx`; `pending` / `action_required` require `action_url`; `rejected` should include `message`.

## What is **not** validated

- Whether the transaction will actually be approved by the issuer.
- Whether the asset is "regulated" beyond what the approve request declares.
- Whether the response `success` claim is truthful (always reported as inconclusive).
- Whether the revised transaction (for `revised` status) is valid — use `decode` on it separately.

## Limitations

- A valid approve request is **not** proof of approval — the issuer's decision requires a live call that this inspector never makes.
- A `success` response is what the caller supplied; it is not independently verified.
- Envelope XDR cross-check is limited: this inspector does not decode the envelope; use `decode` for that and compare manually.
- The inspector never submits, signs, or modifies transactions. Only offline files, inline JSON, or stdin are accepted.