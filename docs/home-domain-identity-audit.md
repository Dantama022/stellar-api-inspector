# Home-Domain Identity Consistency Audit (ISSUE-123)

```bash
stellar-api-inspector home-domain-identity-audit <accountId> [--horizon <url>] [--timeout 10000] [--json]
```

Loads the account's `home_domain` from Horizon, fetches
`https://<home_domain>/.well-known/stellar.toml`, and checks whether the account ID
appears in the published `ACCOUNTS` list. `[DOCUMENTATION]` `ORG_*` metadata is
included for context.

- `listing`: `listed`, `omitted`, or `unavailable`.
- `status`: `consistent`, `warning`, `failed`, or `inconclusive`.
- Findings: `NO_HOME_DOMAIN`, `ACCOUNT_UNAVAILABLE`, `TOML_HTTP_ERROR`, `TOML_TIMEOUT`,
  `TOML_UNREACHABLE`, `TOML_MALFORMED`, `ACCOUNTS_MISSING`, `ACCOUNTS_INVALID`,
  `ACCOUNT_ID_MALFORMED`, `ACCOUNT_DUPLICATE`, `ACCOUNT_LISTED`, `ACCOUNT_NOT_LISTED`,
  `ORG_METADATA_MISSING`.

## Limitations

- A matching `ACCOUNTS` entry is a consistency signal. It does **not** prove domain
  ownership or cryptographically verify identity.
- Organization names are descriptive only and never treated as proof.
- Missing `ACCOUNTS` is unavailable evidence, not a violation.
- Federation lookups and full `stellar.toml` validation are out of scope.
- Read-only: no transactions are submitted.
