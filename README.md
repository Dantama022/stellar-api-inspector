# 🔍 Stellar API Inspector

[![CI Status](https://github.com/your-org/stellar-api-inspector/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/stellar-api-inspector/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A command-line inspection and health-checking tool for Stellar Horizon and Soroban RPC endpoints. Validate network synchronization, track rate limits, audit account signers/balances, and diagnose performance bottlenecks.

## Features

- **🌐 Horizon Inspection**: Connect to any Horizon endpoint and retrieve synchronization status, fee statistics, network protocol, and ledger ranges.
- **⚡ Soroban RPC Health**: Retrieve health details, transaction submission state, latest ledger information, and network parameters.
- **🔎 Soroban Transaction Inspection**: Inspect execution status, contract events, diagnostic events, resource usage, and fee breakdown for any submitted Soroban transaction.
- **🧬 Soroban Contract Inspection**: Retrieve contract instance metadata, WASM code hash, ledger footprint, storage counts, and TTL expiration warnings.
- **🛡️ Account Auditor**: Detailed structural audits of accounts: analyze thresholds, verify signer weights (multi-sig checks), inspect asset balances, and detect trustline authorization/limit risks.
- **📈 Market Trade History**: Retrieve recent trades for any Stellar asset pair, display per-trade details, and compute summary statistics (volume, average/high/low price).
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

### Market Trade History

Retrieve and summarize recent trades for a Stellar asset pair from Horizon:

```bash
npm run dev -- trades XLM USDC:GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H
```

Native XLM can be specified as `XLM`, `native`, or `XLM:native`. Non-native assets use `CODE:ISSUER` format.

Control how many trades are returned with `--limit` (default: 20, max: 200):

```bash
npm run dev -- trades XLM USDC:GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H \
  --limit 50
```

Point at a different Horizon endpoint with `--horizon`:

```bash
npm run dev -- trades XLM USDC:GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H \
  --horizon https://horizon.stellar.org \
  --limit 100
```

The output shows a trade table followed by summary statistics:

```text
=== Market Trade History ===

Pair:    XLM / USDC:GBBD47IF...
Horizon: https://horizon-testnet.stellar.org
Latency: 62ms

┌──────────────────────┬──────────────────────┬───────────┬──────────────┬─────────────┬─────────────────┬───────────────────┐
│ Trade ID             │ Timestamp            │ Base      │ Counter      │ Price       │ Base Amount     │ Counter Amount    │
├──────────────────────┼──────────────────────┼───────────┼──────────────┼─────────────┼─────────────────┼───────────────────┤
│ 2163...              │ 2026-07-28T10:01:00Z │ XLM       │ USDC:GBBD... │ 0.1100000   │ 500.0000000     │ 55.0000000        │
│ 2162...              │ 2026-07-28T09:58:00Z │ XLM       │ USDC:GBBD... │ 0.1095000   │ 1200.0000000    │ 131.4000000       │
└──────────────────────┴──────────────────────┴───────────┴──────────────┴─────────────┴─────────────────┴───────────────────┘

--- Summary Statistics ---
┌──────────────────────┬─────────────────┐
│ Metric               │ Value           │
├──────────────────────┼─────────────────┤
│ Number of Trades     │ 2               │
│ Total Base Volume    │ 1700.0000000    │
│ Total Counter Volume │ 186.4000000     │
│ Average Price        │ 0.1097500       │
│ Highest Price        │ 0.1100000       │
│ Lowest Price         │ 0.1095000       │
└──────────────────────┴─────────────────┘
```

When no trades exist for the pair, the command exits cleanly with a `No recent trades found` message — no error or non-zero exit.

**JSON output** — ideal for analytics pipelines and dashboards:

```bash
npm run dev -- trades XLM USDC:GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H --json
```

```json
{
  "ok": true,
  "data": {
    "horizonUrl": "https://horizon-testnet.stellar.org",
    "baseLabel": "XLM",
    "counterLabel": "USDC:GBBD47IF...",
    "limit": 20,
    "latencyMs": 62,
    "trades": [
      {
        "id": "216334...",
        "ledgerCloseTime": "2026-07-28T10:01:00Z",
        "baseAsset": "XLM",
        "counterAsset": "USDC:GBBD47IF...",
        "baseAmount": "500.0000000",
        "counterAmount": "55.0000000",
        "price": 0.11
      }
    ],
    "stats": {
      "tradeCount": 1,
      "totalBaseVolume": 500,
      "totalCounterVolume": 55,
      "averagePrice": 0.11,
      "highestPrice": 0.11,
      "lowestPrice": 0.11
    }
  }
}
```

When the market has no recent trades the `trades` array is empty and all `stats` numeric fields are `null`:

```json
"stats": {
  "tradeCount": 0,
  "totalBaseVolume": 0,
  "totalCounterVolume": 0,
  "averagePrice": null,
  "highestPrice": null,
  "lowestPrice": null
}
```

Save output to a file:

```bash
npm run dev -- trades XLM USDC:GBBD47IF6LWK7P7MDEVSCWR7D6WV3FYVHQRFFTL6PQGP54YPM7K32T6H \
  --json --output trades-report.json
```
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

### Ledger Range Analysis

Analyze a range of consecutive Stellar ledgers to understand network performance, transaction throughput, and protocol behavior:

```bash
npm run dev -- ledgers 57000000 57000100
```

The command retrieves ledger information across the specified range and displays aggregate metrics:

- **Total Ledgers Analyzed** — count of ledgers successfully retrieved
- **Total Transactions** — sum of all transactions in the range
- **Total Operations** — sum of all operations in the range
- **Avg Transactions / Ledger** — mean transactions per ledger
- **Avg Operations / Ledger** — mean operations per ledger
- **Avg Close Interval** — average time between consecutive ledger closes

Ledgers with unusually high transaction counts (exceeding the mean + 2σ threshold) are highlighted in a separate table.

Use a custom Horizon endpoint with `-h`:

```bash
npm run dev -- ledgers 57000000 57000100 -h https://horizon.stellar.org
```

Control the maximum range size with `--max-range` (default: 200):

```bash
npm run dev -- ledgers 57000000 57000500 --max-range 500
```

Invalid ranges (start > end, non-positive integers, ranges exceeding the max) return clear error messages:

```bash
$ npm run dev -- ledgers 100 50
# End sequence must be greater than or equal to start sequence

$ npm run dev -- ledgers -1 100
# Start sequence must be a positive integer
```

Missing or unavailable ledgers within the range are reported:

```bash
npm run dev -- ledgers 57000000 57000010 --json
```

**Example JSON output:**
### Soroban Transaction Inspection

Inspect execution details of a Soroban transaction after submission — including execution status, ledger, return value, resource consumption, fee breakdown, contract events, and diagnostic events:

```bash
npm run dev -- soroban-tx <transactionHash>
```

Specify a custom RPC endpoint with `--rpc`:

```bash
npm run dev -- soroban-tx <transactionHash> \
  --rpc https://soroban-testnet.stellar.org
```

The transaction hash must be a 64-character hexadecimal string. Invalid hashes are rejected before any network call is made.

**Status values:**

| Status | Meaning |
|--------|---------|
| `SUCCESS` | Contract invocation completed successfully |
| `FAILED` | Transaction was included in a ledger but the contract execution failed |
| `PENDING` | Transaction has been submitted but not yet included in a ledger |
| `NOT_FOUND` | Transaction hash is unknown to the node (expired or never submitted) |

**Handling failed executions:**

When a contract invocation fails, `soroban-tx` still displays all available information — ledger sequence, resource usage, and any diagnostic events emitted before the failure — making it straightforward to diagnose what went wrong:

```bash
npm run dev -- soroban-tx <failedTxHash> --rpc https://soroban-testnet.stellar.org
```

A `⚠ Contract invocation failed` warning is shown at the bottom of the output, and the exit code is non-zero.

**JSON output:**

```bash
npm run dev -- soroban-tx <transactionHash> --json
```

JSON output structure:
### Multi-Endpoint Compatibility Comparison

Compare configuration, compatibility, and health across multiple Stellar endpoints (both Horizon and Soroban RPC). The command automatically detects the endpoint type, gathers metadata, and highlights configuration differences.

```bash
npm run dev -- compare-endpoints https://horizon.stellar.org https://rpc.example.com
```

Compare endpoints from different Stellar networks:

```bash
npm run dev -- compare-endpoints \
  https://horizon.stellar.org \
  https://horizon-testnet.stellar.org \
  https://soroban-testnet.stellar.org
```

The comparison table shows the following for each endpoint:

| Column | Description |
|--------|-------------|
| Endpoint URL | The normalized URL of the endpoint |
| Type | Detected service type: `Horizon`, `Soroban RPC`, or `Unknown` |
| Status | `ONLINE` or `OFFLINE` |
| Latency | Round-trip response time in milliseconds |
| Network Passphrase | The Stellar network passphrase (e.g. "Public Global Stellar Network ; September 2015") |
| Protocol | Stellar protocol version number |
| Latest Ledger | The most recent ledger sequence reported by the endpoint |
| Health | Health status (HTTP status for Horizon, "healthy" for Soroban, or error message for offline) |

Differences between endpoints are highlighted:

- **Network mismatches** are shown in red — endpoints may be on different Stellar networks
- **Protocol version mismatches** are highlighted in yellow
- **Offline endpoints** are reported as warnings

#### Configurable timeout

Set a custom request timeout in milliseconds:

```bash
npm run dev -- compare-endpoints https://horizon.stellar.org https://horizon-testnet.stellar.org --timeout 15000
```

#### JSON output

```bash
npm run dev -- compare-endpoints https://horizon.stellar.org https://horizon-testnet.stellar.org --json
```

**JSON output structure:**

```json
{
  "ok": true,
  "data": {
    "horizonUrl": "https://horizon-testnet.stellar.org",
    "range": {
      "start": 57000000,
      "end": 57000100,
      "requestedSize": 101,
      "maxRange": 200
    },
    "summary": {
      "totalLedgers": 101,
      "totalTransactions": 452,
      "totalOperations": 1080,
      "avgTransactionsPerLedger": 4.48,
      "avgOperationsPerLedger": 10.69,
      "avgLedgerCloseIntervalSeconds": 5.0,
      "missingLedgers": 0,
      "missingSequences": []
    },
    "highActivityLedgers": [
      {
        "sequence": 57000050,
        "transactionCount": 85,
        "operationCount": 200,
        "threshold": 32
      }
    ]
  }
}
```

    "hash": "aabbcc...",
    "rpcUrl": "https://soroban-testnet.stellar.org",
    "latencyMs": 84,
    "status": "SUCCESS",
    "ledger": 5000000,
    "ledgerCloseTime": 1700000000,
    "ledgerCloseTimeIso": "2023-11-14T22:13:20.000Z",
    "returnValue": "AAAAAQAAAA==",
    "events": [
      {
        "type": "contract",
        "contractId": "C...",
        "topics": ["AAAAA=", "BBBBB="],
        "data": "CCCCC="
      }
    ],
    "diagnosticEvents": [],
    "resources": {
      "instructions": 1000000,
      "readBytes": 512,
      "writeBytes": 256,
      "readLedgerEntries": 3,
      "writeLedgerEntries": 1
    },
    "fee": {
      "totalFee": 1500,
      "inclusionFee": 100,
      "resourceFeeCharged": 1400,
      "refundableFee": 200
    },
    "contractFailed": false
    "endpoints": [
      {
        "url": "https://horizon.stellar.org",
        "type": "horizon",
        "status": "online",
        "latencyMs": 120,
        "networkPassphrase": "Public Global Stellar Network ; September 2015",
        "protocolVersion": 21,
        "latestLedger": 50000000,
        "healthStatus": "HTTP 200"
      },
      {
        "url": "https://horizon-testnet.stellar.org",
        "type": "horizon",
        "status": "online",
        "latencyMs": 85,
        "networkPassphrase": "Test SDF Network ; September 2015",
        "protocolVersion": 21,
        "latestLedger": 45000000,
        "healthStatus": "HTTP 200"
      }
    ],
    "differences": {
      "networkMismatch": true,
      "protocolMismatch": false,
      "hasOfflineEndpoints": false
    },
    "checkedAt": "2024-01-15T12:00:00.000Z"
  }
}
```

Save to file:

```bash
npm run dev -- soroban-tx <transactionHash> --json --output tx-report.json
npm run dev -- compare-endpoints https://horizon.stellar.org https://horizon-testnet.stellar.org --json --output comparison.json
```

### Options
- `-j, --json`: Return raw JSON instead of formatted CLI tables (great for shell pipelines).
- `-o, --output <path>`: Save inspection output directly to a file (JSON or Markdown).
- `-v, --verbose`: Turn on debug logging.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for details on code style, testing, and how to pick up open issues from our roadmap.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
