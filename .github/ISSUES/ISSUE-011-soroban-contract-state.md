# ISSUE-011: Check Soroban Smart Contract Code Hash & Footprint

**EPIC:** 4 — Soroban Support
**Labels:** `enhancement`, `epic-soroban`
**Difficulty:** hard

## Description

To inspect Soroban contracts, we need to inspect a contract's ledger state, including its binary code hash, footprint storage, and live TTL (time to live). This is key to ensuring smart contract code is active and has not expired due to insufficient state rent.

## Tasks

- [ ] Add `contract <contractId>` subcommand under `soroban` or core CLI
- [ ] Query RPC using `getLedgerEntries` with contract code keys
- [ ] Parse contract metadata: TTL, owner, Wasm code hash, and storage size
- [ ] Write integration test mocks for Soroban contract state returns

## Acceptance Criteria

- CLI command fetches and prints Soroban contract code metadata
- Displays warnings if TTL is close to expiration (< 10,000 ledgers)
- Gracefully handles unknown contract IDs
