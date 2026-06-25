# 🔍 Stellar API Inspector

[![CI Status](https://github.com/your-org/stellar-api-inspector/actions/workflows/ci.yml/badge.svg)](https://github.com/your-org/stellar-api-inspector/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A command-line inspection and health-checking tool for Stellar Horizon and Soroban RPC endpoints. Validate network synchronization, track rate limits, audit account signers/balances, and diagnose performance bottlenecks.

## Features

- **🌐 Horizon Inspection**: Connect to any Horizon endpoint and retrieve synchronization status, fee statistics, network protocol, and ledger ranges.
- **⚡ Soroban RPC Health**: Retrieve health details, transaction submission state, latest ledger information, and network parameters.
- **🛡️ Account Auditor**: Detailed structural audits of accounts: analyze thresholds, verify signer weights (multi-sig checks), inspect asset balances, and detect trustlines.
- **⏱️ Rate Limit Tracker**: Read and analyze HTTP headers (`X-Ratelimit-Limit`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset`) to help avoid rate limits in production.
- **📋 Health Dashboard**: Benchmark latency, check synchronization, and compare performance across multiple endpoints concurrently.
- **💾 Multiple Output Formats**: Supports clean, human-readable CLI tables, raw JSON for automated scripting, or markdown exports.

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

### Horizon Endpoint Check
Analyze a Horizon API endpoint's details, protocol version, and network state:
```bash
npm run dev -- horizon https://horizon-testnet.stellar.org
```

### Soroban RPC Check
Verify a Soroban RPC node's health and connection details:
```bash
npm run dev -- soroban https://soroban-testnet.stellar.org
```

### Account Audit
Audit a Stellar account's balances, subentries, thresholds, and signing weights:
```bash
npm run dev -- account G...
```
*(Optionally provide a custom Horizon URL with `-h` / `--horizon`)*

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

### Multi-Endpoint Health Check
Run a latency and synchronization check on multiple Horizon endpoints:
```bash
npm run dev -- health https://horizon.stellar.org https://horizon-testnet.stellar.org
```

### Options
- `-j, --json`: Return raw JSON instead of formatted CLI tables (great for shell pipelines).
- `-o, --output <path>`: Save inspection output directly to a file (JSON or Markdown).
- `-v, --verbose`: Turn on debug logging.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for details on code style, testing, and how to pick up open issues from our roadmap.

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.
