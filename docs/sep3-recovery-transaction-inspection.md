# SEP-3 stellar.toml Anchor Metadata Inspection

**Important specification note:** In the current Stellar SEP numbering, **SEP-3 is "Toml Files"** — the `stellar.toml` anchor-metadata specification. SEP-3 does **not** define a distinct recovery-transaction flow. Recovery transaction signers are defined by **SEP-30**, which is implemented separately by the `sep30-recovery-inspect` command.

This command therefore inspects the SEP-3 data structure that actually exists — the `stellar.toml` file — with a focus on anchor-discovery fields relevant to recovery-adjacent flows (`KYC_SERVER`, `WEB_AUTH_ENDPOINT`, `TRANSFER_SERVER`, `SIGNING_KEY`, `ACCOUNTS[]`).

## Usage

```bash
# Inspect a local toml file
stellar-api-inspector sep3-toml-inspect --file stellar.toml

# Inspect a live anchor
stellar-api-inspector sep3-toml-inspect --anchor https://anchor.example.com

# Inspect inline content
stellar-api-inspector sep3-toml-inspect --toml 'TRANSFER_SERVER = "https://a.example.com"
WEB_AUTH_ENDPOINT = "https://a.example.com/auth"'
```

## What is validated

- `TRANSFER_SERVER`, `WEB_AUTH_ENDPOINT` — required, must be `https://`
- `TRANSFER_SERVER_SEP0024`, `KYC_SERVER`, `DIRECT_PAYMENT_SERVER`, `ANCHOR_QUOTE_SERVER`, `HORIZON_URL`, `TOML_URL` — optional, must be `https://` if present
- `SIGNING_KEY` — must be a valid Stellar Ed25519 public key
- `ACCOUNTS[]` — entries must be either valid Stellar public keys or tables with a valid `ADDRESS` field

## What is **not** validated

- Whether any recovery transaction can be authorized
- Whether the anchor has a working recovery service
- Whether the reported `SIGNING_KEY` or `ACCOUNTS[]` have any relationship to SEP-30 signers

These are out of scope for SEP-3. The `scopeNote` and `sep30Disambiguation` fields in every result make the distinction explicit.

## SEP-3 vs SEP-30 vs SEP-10

| Spec | Purpose | Command |
|------|---------|---------|
| **SEP-3** | `stellar.toml` anchor discovery metadata | `sep3-toml-inspect` |
| **SEP-10** | Web authentication challenge | (existing command) |
| **SEP-30** | Account recovery signers | `sep30-recovery-inspect` |

## Exit codes

- `0` — no errors
- `1` — one or more `error` severity findings