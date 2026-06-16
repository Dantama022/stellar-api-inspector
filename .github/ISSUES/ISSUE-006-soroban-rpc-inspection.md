# ISSUE-006: Inspect Soroban RPC Network Settings & Health

**EPIC:** 4 — Soroban Support
**Labels:** `enhancement`, `epic-soroban`
**Difficulty:** easy

## Description

Soroban RPC servers utilize JSON-RPC. We need to implement a subcommand dedicated to inspecting Soroban node configurations, health, protocol parameters, and matching ledger sequences.

## Tasks

- [ ] Add `soroban <url>` CLI command
- [ ] Query RPC health using JSON-RPC `getHealth`
- [ ] Query network passphrase and protocol version via `getNetwork`
- [ ] Query latest ledger status via `getLatestLedger`
- [ ] Print detailed parameters in a structured table

## Acceptance Criteria

- Command `stellar-api-inspector soroban <url>` runs and connects to Soroban testnet
- Health and sync statuses are explicitly displayed
- Handles offline Soroban endpoints safely
