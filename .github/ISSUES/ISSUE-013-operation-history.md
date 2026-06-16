# ISSUE-013: Parse and Filter Horizon Operations History

**EPIC:** 1 — Core Inspection
**Labels:** `enhancement`, `epic-core-inspection`
**Difficulty:** medium

## Description

To audit recent transactions, we need to inspect recent ledger operations. We want a command to query Horizon's recent operations list, filter by type (e.g., payments, create_account, manage_buy_offer), and format the results.

## Tasks

- [ ] Add `operations` subcommand taking optional filter options (`--type`, `--limit`, `--account`)
- [ ] Connect to `server.operations()` and apply filters
- [ ] Parse various operational models (Payment, CreateAccount, etc.) into unified console objects
- [ ] Print operation details in a structured table

## Acceptance Criteria

- CLI command: `stellar-api-inspector operations --limit 10 --type payment`
- Successfully lists filtered ledger operations
- Unit tests verify filtering parameters and operation mappings
