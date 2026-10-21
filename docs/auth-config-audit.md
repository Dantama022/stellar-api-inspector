# Horizon & Soroban RPC Authentication Configuration Audit

```
stellar-api-inspector auth-config-audit [--horizon <url>] [--rpc <url>] \
  [--horizon-api-key <key>] [--rpc-api-key <key>] \
  [--policy production|development] [-j] [-o <path>]
```

Read-only. Inspects the CLI's effective connection configuration for Horizon and Soroban RPC. **Never makes a network request** and **never echoes credential values**.

## What is checked

- **URL syntax** — must be a valid `http://` or `https://` URL.
- **Scheme** — HTTPS required under `--policy production`; HTTP allowed under `--policy development` but warned.
- **Embedded credentials** — a URL with `user:pass@host` is flagged (error under production, warning under development). The userinfo portion is redacted from all output; only its presence is reported.
- **Conflicting sources** — when both env vars and CLI overrides are set to different values, the CLI override wins and the conflict is reported as a warning.
- **API key presence** — reports whether an API key is configured, but never echoes its value.
- **Unknown env vars** — env vars with `STELLAR_*`, `HORIZON_*`, `SOROBAN_*`, or `TX_TEST_*` prefixes that are not recognized by this audit are reported as `info`.

## What is **not** checked

- Whether the configured endpoint actually requires authentication. This is deployment-specific and always reported as `AUTH_REQUIREMENT_UNKNOWN` (inconclusive).
- Whether the configured endpoint is reachable.
- Whether the configured API key is valid.

## Environment variables inspected

| Name | Endpoint |
|---|---|
| `HORIZON_URL` / `STELLAR_HORIZON_URL` | Horizon |
| `SOROBAN_RPC_URL` / `STELLAR_SOROBAN_RPC_URL` | Soroban RPC |
| `HORIZON_API_KEY` / `STELLAR_HORIZON_API_KEY` / `STELLAR_API_KEY` | Horizon |
| `SOROBAN_RPC_API_KEY` / `STELLAR_SOROBAN_RPC_API_KEY` / `STELLAR_API_KEY` | Soroban RPC |

## Policies

- **`production` (default)** — HTTP endpoints and embedded URL credentials are **errors**.
- **`development`** — HTTP endpoints and embedded URL credentials are **warnings**.

A missing credential is **never** treated as a misconfiguration, because many Horizon and Soroban RPC deployments are public and require no authentication.

## Limitations

- Never makes a network request.
- `AUTH_REQUIREMENT_UNKNOWN` is always emitted — the audit cannot determine whether authentication is actually required by the deployment.
- Credential values are never echoed.