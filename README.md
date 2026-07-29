# 🔍 Stellar API Inspector

[![CI Status](https://github.com/your-org/stellar-api-inspector/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/stellar-api-inspector/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A command-line inspection and health-checking tool for Stellar Horizon and Soroban RPC endpoints. Validate network synchronization, track rate limits, audit account signers/balances, and diagnose performance bottlenecks.

## Features

- **🌐 Horizon Inspection**: Connect to any Horizon endpoint and retrieve synchronization status, fee statistics, network protocol, and ledger ranges.
- **⚡ Soroban RPC Health**: Retrieve health details, transaction submission state, latest ledger information, and network parameters.
- **🧬 Soroban Contract Inspection**: Retrieve contract instance metadata, WASM code hash, ledger footprint, storage counts, and TTL expiration warnings.
- **🛡️ Account Auditor**: Detailed structural audits of accounts: analyze thresholds, verify signer weights (multi-sig checks), inspect asset balances, and detect trustline authorization/limit risks.
- **📜 Operations History**: Fetch Horizon operations, filter by account/type/limit, and normalize common operation details.
- **🧭 Interactive Mode**: Launch a guided menu when the CLI is run without arguments.
- **⏱️ Rate Limit Tracker**: Read and analyze HTTP headers (`X-Ratelimit-Limit`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`) to help avoid rate limits in production.
- **📋 Health Dashboard**: Benchmark latency, check synchronization, and compare performance across multiple endpoints concurrently.
- **� Network Passphrase Inspection**: Validate known Stellar networks, inspect custom passphrases, and identify whether a passphrase matches Mainnet, Testnet, or Futurenet.
- **�💾 Multiple Output Formats**: Supports clean, human-readable CLI tables, raw JSON for automated scripting, or markdown exports.

## Installation

Ensure you have [Node.js](https://nodejs.org/) (>= 18.0.0) installed.

Clone the repository and install dependencies:

```bash
git clone https://github.com/your-org/stellar-api-inspector.git
cd stellar-api-inspector
npm install
```

Build the project:

```bash
npm run build
```

## Usage

Use the CLI driver via `npm run dev` or run the compiled output using `node dist/cli/index.js`.

### Interactive Mode

Run the CLI without arguments to launch a guided prompt workflow:

```bash
npm run dev
```

The interactive menu can collect inputs for Horizon inspection, Soroban inspection, account audit, health dashboard, transaction XDR decoding, operations history, and contract inspection. Before execution it prints a command summary and asks for confirmation.

### Network Passphrase Inspection
Inspect Stellar network passphrases and determine whether a supplied value matches a built-in network or represents a custom configuration:

```bash
npm run dev -- network
npm run dev -- network --passphrase testnet
npm run dev -- network --passphrase "Custom Network ; Local" --json
```

The command lists the built-in networks (Public Network, Testnet, and Futurenet) and reports whether the supplied value is known or custom. Empty input is rejected with a clear error.

### Horizon Endpoint Check
Verify that a Horizon endpoint is reachable, measure response latency, and display network metadata (passphrase, protocol version, Horizon/Core versions):

```bash
npm run dev -- horizon https://horizon-testnet.stellar.org
```

Example output includes response latency in milliseconds, network passphrase, protocol version, and software versions. Invalid URLs are rejected before connecting. Offline endpoints exit with code `1`.

#### Rate Limit Headers

When a Horizon server exposes rate limit headers (`X-Ratelimit-Limit`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`), they are automatically parsed and displayed in the inspection table:

| Field | Description |
|---|---|
| Rate Limit (Max) | Total requests allowed per window |
| Rate Limit (Remaining) | Remaining requests, shown as `count (percent%)` |
| Rate Limit (Resets In) | Time until the window resets, formatted as `45s` or `1m 30s` |

The remaining quota is color-coded for quick scanning:
- **Green** — plenty of quota remaining (≥ 50%)
- **Yellow** — moderately used (10–49%)
- **Red ⚠ LOW** — below 10% — at risk of throttling

Horizon deployments that do not emit these headers show no rate limit rows — there are no errors or placeholder values.

```bash
# JSON output — rate limit fields included alongside all other metadata
npm run dev -- horizon https://horizon-testnet.stellar.org --json
```

**JSON output structure (rate limit fields):**
```json
{
  "ok": true,
  "data": {
    "info": {
      "url": "https://horizon-testnet.stellar.org",
      "status": "online",
      "latencyMs": 58,
      "rateLimit": {
        "limit": 3600,
        "remaining": 3540,
        "resetSeconds": 42,
        "usedPercent": 2,
        "remainingPercent": 98,
        "isLow": false,
        "hasRateLimitInfo": true
      }
    }
  }
}
```

When rate limit headers are absent, `rateLimit` fields are all `null`:
```json
"rateLimit": {
  "limit": null,
  "remaining": null,
  "resetSeconds": null,
  "usedPercent": null,
  "remainingPercent": null,
  "isLow": false,
  "hasRateLimitInfo": false
}
```

### Soroban RPC Inspection
Verify a Soroban RPC node's health, network configuration, protocol version, and ledger synchronization status:

```bash
npm run dev -- soroban https://soroban-testnet.stellar.org
```

The command runs three JSON-RPC calls concurrently to the endpoint:

| Call | What it returns |
|---|---|
| `getHealth` | Health status (`healthy` / degraded string) |
| `getNetwork` | Network passphrase and protocol version |
| `getLatestLedger` | Latest ledger sequence and close timestamp |

`getNetwork` and `getLatestLedger` are treated as **optional** — if the node doesn't support them the inspection still succeeds and those fields are shown as `Unknown`.

Unreachable endpoints or HTTP errors exit with code `1` and display a clear error message.

```bash
# JSON output — all fields serialized, ideal for monitoring pipelines
npm run dev -- soroban https://soroban-testnet.stellar.org --json

# Save to file
npm run dev -- soroban https://soroban-testnet.stellar.org --json --output soroban-report.json

# Verbose mode (shows debug-level RPC call traces)
npm run dev -- soroban https://soroban-testnet.stellar.org --verbose
```

**JSON output structure:**
```json
{
  "ok": true,
  "data": {
    "url": "https://soroban-testnet.stellar.org",
    "status": "online",
    "latencyMs": 112,
    "health": "healthy",
    "networkPassphrase": "Test SDF Network ; September 2015",
    "protocolVersion": 21,
    "latestLedgerSequence": 4500000,
    "latestLedgerCloseTime": 1700000000,
    "latestLedgerCloseTimeIso": "2023-11-14T22:13:20.000Z"
  }
}
```

### Account Audit
Audit a Stellar account's balances, subentries, thresholds, and signing weights:
```bash
npm run dev -- account G...
```
*(Optionally provide a custom Horizon URL with `-h` / `--horizon`)*

Account audits include a trustline health section for non-native assets:

- issuer flags: `auth_required`, `auth_revocable`, `auth_immutable`, and clawback status
- authorization state and liabilities-only/revoked trustlines
- balance utilization as a percentage of trustline limit
- warnings when utilization is at or above 99%

```bash
npm run dev -- account G... --horizon https://horizon-testnet.stellar.org --json
```

### Soroban Contract Inspection

Inspect contract ledger entries exposed by Soroban RPC:

```bash
npm run dev -- contract C... --rpc https://soroban-testnet.stellar.org
```

The command concurrently queries the Soroban RPC endpoint for two things: the target contract's ledger entries (instance + WASM code) and the RPC node's network configuration (passphrase + protocol version). It extracts the WASM code hash, queries the referenced contract code entry, calculates remaining ledger lifetime when expiration metadata is available, and reports the storage footprint it inspected.

Configure TTL warning sensitivity:

```bash
npm run dev -- contract C... \
  --rpc https://soroban-testnet.stellar.org \
  --ttl-warning-ledgers 5000
```

Example output:

```text
=== Soroban Contract Inspection ===

Contract ID:        C...
RPC URL:           https://soroban-testnet.stellar.org
Network Passphrase: Test SDF Network ; September 2015
Protocol Version:   21
WASM Code Hash:     0202020202020202020202020202020202020202020202020202020202020202
Contract Owner:     C...
Current Ledger:     100
Instance Found:     YES
Code Entry Found:   YES
WASM Size:          4 Bytes

--- TTL & Expiration ---
Current TTL / Live Until Ledger: 105
Last Modified Ledger:            10
Remaining Ledger Lifetime:       5
Warning Threshold:               10 ledgers

--- Storage Footprint ---
Queried Ledger Entries:     2
Found Ledger Entries:       2
Instance Storage Entries:   1

⚠ Contract TTL is below warning threshold (5 ledgers remaining; threshold 10).
```

JSON output is available:

```bash
npm run dev -- contract C... --rpc https://soroban-testnet.stellar.org --json
```

**JSON output structure:**
```json
{
  "ok": true,
  "data": {
    "contractId": "C...",
    "rpcUrl": "https://soroban-testnet.stellar.org",
    "currentLedger": 100,
    "wasmHash": "0202...",
    "owner": "C...",
    "instance": {
      "found": true,
      "lastModifiedLedger": 10,
      "liveUntilLedger": 105,
      "currentTtl": 105,
      "remainingLedgers": 5
    },
    "code": {
      "found": true,
      "wasmSizeBytes": 4
    },
    "storage": {
      "footprint": ["...", "..."],
      "queriedEntryCount": 2,
      "foundEntryCount": 2,
      "instanceStorageEntryCount": 1
    },
    "warnings": ["Contract TTL is below warning threshold (5 ledgers remaining; threshold 10)."]
  }
}
```

If the RPC node cannot be reached, malformed contract IDs are rejected up-front with a clear error, and unknown contracts return a graceful `instance.found = false` result with an explanatory warning rather than an exception.

### Operations History

Fetch and normalize recent Horizon operations:

```bash
npm run dev -- operations --limit 10 --type payment
```

Filter by account:

```bash
npm run dev -- operations \
  --horizon https://horizon-testnet.stellar.org \
  --account G... \
  --type change_trust \
  --limit 25
```

Supported normalized operation families include payments, create account, account merge, change trust, manage buy/sell offer, and path payment operations. Use `--json` for machine-readable output:

```bash
npm run dev -- operations --account G... --limit 10 --json
```

### Order Book Inspection
Query DEX order book depth, spread, and volume for a trading pair:

```bash
npm run dev -- orderbook XLM USDC:GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H
```

Native XLM can be specified as `XLM`, `native`, or `XLM:native`. JSON output is available with `--json`.
### Decode Transaction XDR
Decode a base64 TransactionEnvelope offline without network access:

```bash
npm run dev -- decode <xdrBase64>
npm run dev -- decode <xdrBase64> --network testnet --json
```

Supports multi-operation transactions, memo fields, time bounds, and signature inspection.

### Ledger Header Inspection
Retrieve and summarize information about a specific Stellar ledger using Horizon (`GET /ledgers/{sequence}`):

```bash
npm run dev -- ledger 57000000
```

The command prints a human-readable table containing the ledger's metadata and consensus activity:

- **Sequence & identifiers** — sequence number, ledger hash, previous ledger hash
- **Activity** — transaction count, successful transaction count, operation count, close timestamp
- **Protocol** — Stellar protocol version in effect at close time
- **Network economics** — base fee, base reserve, network totals (`total_coins`, `fee_pool`, `max_tx_set_size`) when the Horizon version exposes them

```bash
# Target a custom Horizon endpoint
npm run dev -- ledger 57000000 --horizon https://horizon.stellar.org

# Surface Horizon-provided links to related transactions/operations
npm run dev -- ledger 57000000 --show-links

# JSON output for monitoring pipelines or shell scripting
npm run dev -- ledger 57000000 --json
npm run dev -- ledger 57000000 --json --output ledger-57000000.json
```

**JSON output structure:**
```json
{
  "ok": true,
  "data": {
    "horizonUrl": "https://horizon-testnet.stellar.org",
    "ledger": {
      "id": "...",
      "sequence": 57000000,
      "hash": "...",
      "prev_hash": "...",
      "transaction_count": 12,
      "successful_transaction_count": 12,
      "operation_count": 38,
      "closed_at": "2024-01-15T12:00:00Z",
      "total_coins": "105000000.0000000",
      "fee_pool": "100.5",
      "base_fee": 100,
      "base_reserve": "5000000",
      "max_tx_set_size": 1000,
      "protocol_version": 21,
      "_links": { "self": { "href": "..." }, "transactions": { "href": "..." } }
    }
  }
}
```

When the ledger is unknown to the Horizon node (commonly a future or
not-yet-finalized sequence number), the CLI prints a clear error,
emits an `ok: false` JSON envelope with code `1`, and exits without
silently hanging. Input validation rejects non-numeric or non-positive
sequences before any network call is made.

### Transaction Submission Test
Measure Horizon transaction submission latency with a lightweight self-payment:

```bash
export STELLAR_SECRET_KEY=S...
npm run dev -- tx-test
```

Requires a funded testnet account. Optionally set `HORIZON_URL` to target a different endpoint. JSON output available with `--json`.

### Multi-Endpoint Health Dashboard
Concurrently inspect up to 10 Horizon endpoints and generate a comparison scorecard showing availability, latency, ledger sequence, and sync lag:

```bash
npm run dev -- health https://horizon.stellar.org https://horizon-testnet.stellar.org
```

Example with three endpoints:

```bash
npm run dev -- health \
  https://horizon.stellar.org \
  https://horizon-testnet.stellar.org \
  https://horizon-futurenet.stellar.org
```

The dashboard displays a summary banner followed by a per-endpoint scorecard:

- **Status** — ONLINE / OFFLINE
- **Latency** — round-trip time in milliseconds
- **Latest Ledger** — the most recent ledger sequence reported by each node
- **Lag** — how many ledgers behind the most-synced peer; endpoints lagging by more than 3 ledgers are highlighted in red with a ⚠ warning
- **Protocol** — protocol version

Endpoints are queried **concurrently**, so the total wall-clock time equals roughly the slowest single endpoint response.

```bash
# JSON output — ideal for CI pipelines, monitoring, and jq queries
npm run dev -- health https://horizon.stellar.org https://horizon-testnet.stellar.org --json

# Parse with jq
npm run dev -- health https://horizon.stellar.org --json | jq '.data.summary'
npm run dev -- health https://horizon.stellar.org --json | jq '.data.endpoints[] | {endpoint, status, ledgerLag}'

# Save to file
npm run dev -- health https://horizon.stellar.org https://horizon-testnet.stellar.org --json --output health-report.json
```

**JSON output structure:**
```json
{
  "ok": true,
  "data": {
    "checkedAt": "2024-01-15T12:00:00.000Z",
    "summary": {
      "total": 2,
      "online": 2,
      "offline": 0,
      "lagging": 0,
      "maxLedger": 50000000
    },
    "endpoints": [
      {
        "endpoint": "https://horizon.stellar.org",
        "status": "online",
        "latencyMs": 45,
        "latestLedger": 50000000,
        "ledgerLag": 0,
        "lagging": false,
        "protocolVersion": 21,
        "horizonVersion": "2.28.0"
      }
    ]
  }
}
```

### Options
- `-j, --json`: Return raw JSON instead of formatted CLI tables (great for shell pipelines).
- `-o, --output <path>`: Save inspection output directly to a file (JSON or Markdown).
- `-v, --verbose`: Turn on debug logging.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for details on code style, testing, and how to pick up open issues from our roadmap.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
