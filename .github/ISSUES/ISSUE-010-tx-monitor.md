# ISSUE-010: Monitor Horizon Transaction Submissions

**EPIC:** 1 — Core Inspection
**Labels:** `enhancement`, `epic-core-inspection`
**Difficulty:** medium

## Description

Horizon endpoints can experience transaction submission delays or timeouts. We need a diagnostic command `tx-test` that submits an empty transaction (or simple transaction using test accounts) and measures the submission latency, network latency, and Horizon ingestion delay.

## Tasks

- [ ] Add `tx-test` subcommand
- [ ] Incorporate keypair generation or load secret key from environment
- [ ] Connect to testnet, fetch account details, and construct a basic payment or bump transaction
- [ ] Track submission latency and report detailed timing info

## Acceptance Criteria

- CLI command is available
- Latency breakdown is presented in CLI output
- Does not proceed if secret key environment variable is missing (outputs clear guide)
