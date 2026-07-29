# 🔍 Stellar API Inspector

[![CI Status](https://github.com/your-org/stellar-api-inspector/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/stellar-api-inspector/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A command-line inspection and health-checking tool for Stellar Horizon and Soroban RPC endpoints. Validate network synchronization, track rate limits, audit account signers/balances, and diagnose performance bottlenecks.

## Features

- **🌐 Horizon Inspection**: Connect to any Horizon endpoint and retrieve synchronization status, fee statistics, network protocol, and ledger ranges.
- **⚡ Soroban RPC Health**: Retrieve health details, transaction submission state, latest ledger information, and network parameters.
- **🔧 Soroban RPC Capabilities**: Inspect supported RPC methods, endpoint capabilities, and compatibility information.
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

### Soroban RPC Capabilities Inspection

Inspect a Soroban RPC endpoint to discover supported methods, server information, and full capability details:

```bash
npm run dev -- rpc-capabilities https://soroban-testnet.stellar.org
```

The command inspects the RPC endpoint and displays:

- **Health Status** — Overall endpoint health (`healthy`, `degraded`, etc.)
- **Network Information** — Network passphrase and protocol version
- **Ledger Information** — Latest ledger sequence and close timestamp
- **Server Information** — Server name and version (when available)
- **Supported Methods** — Complete list of RPC methods the endpoint implements
- **Unsupported Methods** — Methods that are not available on this endpoint
- **Capability Summary** — Quick overview of total methods probed and support statistics

```bash
# Human-readable output
npm run dev -- rpc-capabilities https://soroban-testnet.stellar.org

# JSON output — ideal for automation and compatibility checking
npm run dev -- rpc-capabilities https://soroban-testnet.stellar.org --json

# Save to file
npm run dev -- rpc-capabilities https://soroban-testnet.stellar.org --output rpc-report.json

# Verbose mode (shows debug traces)
npm run dev -- rpc-capabilities https://soroban-testnet.stellar.org --verbose
```

**Example human-readable output:**

```text
=== Soroban RPC Capabilities Inspection ===

Property                 Value
─────────────────────────────────────────────────────────
Status                   ONLINE
Response Latency         145ms
Health Status            HEALTHY
Network Passphrase       Test SDF Network ; September 2015
Protocol Version         21
Latest Ledger Sequence   4500000

--- Server Information ---
Property                 Value
─────────────────────────────────────────────────────────
Name                     SorobanRPC
Version                  21.0.0

--- Ledger Information ---
Property                 Value
─────────────────────────────────────────────────────────
Latest Ledger Close Time 2023-11-14T22:13:20.000Z

--- Supported Methods (11) ---
Method
──────────────────────
getAccount
getContractData
getEvents
getHealth
getLatestLedger
getLedgerEntries
getNetwork
getSendTransaction
getServerInfo
getTransaction
simulateTransaction

--- Capability Summary ---
Metric                   Value
─────────────────────────────────────────────────────────
Total Methods Probed     12
Supported Methods        11
Unsupported Methods      1
```

**JSON output structure:**

```json
{
  "ok": true,
  "data": {
    "url": "https://soroban-testnet.stellar.org",
    "status": "online",
    "latencyMs": 145,
    "health": "healthy",
    "networkPassphrase": "Test SDF Network ; September 2015",
    "protocolVersion": 21,
    "latestLedgerSequence": 4500000,
    "latestLedgerCloseTimeIso": "2023-11-14T22:13:20.000Z",
    "serverInfo": {
      "name": "SorobanRPC",
      "version": "21.0.0"
    },
    "supportedMethods": [
      "getAccount",
      "getContractData",
      "getEvents",
      "getHealth",
      "getLatestLedger",
      "getLedgerEntries",
      "getNetwork",
      "sendTransaction",
      "simulateTransaction",
      "getTransaction"
    ],
    "unsupportedMethods": [
      "getServerInfo"
    ]
  }
}
```

**Use cases:**

- **Pre-deployment validation** — Verify an RPC endpoint supports all methods your application needs before deploying.
- **Endpoint compatibility checking** — Quickly compare capabilities across multiple RPC providers.
- **Monitoring and alerting** — Track when endpoints lose support for critical methods.
- **CI/CD integration** — Automate RPC readiness checks using JSON output and `jq` queries.

Example jq query to extract supported methods:

```bash
npm run dev -- rpc-capabilities https://soroban-testnet.stellar.org --json | jq '.data.supportedMethods[]'
```

Example to check if specific methods are supported:

```bash
npm run dev -- rpc-capabilities https://soroban-testnet.stellar.org --json | jq '.data | {health, supportedMethodCount: (.supportedMethods | length)}'
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

The command queries the contract instance ledger entry, extracts the WASM code hash, queries the referenced contract code entry, calculates remaining ledger lifetime when expiration metadata is available, and reports the storage footprint it inspected.

Configure TTL warning sensitivity:

```bash
npm run dev -- contract C... \
  --rpc https://soroban-testnet.stellar.org \
  --ttl-warning-ledgers 5000
```

Example output:

```text
=== Soroban Contract Inspection ===

Contract ID:      C...
WASM Code Hash:   0202020202020202020202020202020202020202020202020202020202020202
Current Ledger:   100
Instance Found:   YES
Code Entry Found: YES

--- TTL & Expiration ---
Current TTL / Live Until Ledger: 105
Remaining Ledger Lifetime:      5

⚠ Contract TTL is below warning threshold (5 ledgers remaining; threshold 10).
```

JSON output is available:

```bash
npm run dev -- contract C... --rpc https://soroban-testnet.stellar.org --json
```

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
