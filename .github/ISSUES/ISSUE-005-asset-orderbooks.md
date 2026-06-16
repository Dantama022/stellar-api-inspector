# ISSUE-005: Query and Detail Asset Orderbooks

**EPIC:** 1 — Core Inspection
**Labels:** `enhancement`, `epic-core-inspection`
**Difficulty:** medium

## Description

Add a command to inspect liquidity and trade depth for custom assets on the Stellar Decentralized Exchange (DEX). The CLI should allow looking up order books for given selling/buying assets.

## Tasks

- [ ] Add `orderbook` subcommand taking base and counter asset codes/issuers
- [ ] Connect to Horizon's `/order_book` endpoint
- [ ] Render bids and asks lists in side-by-side or stacked CLI tables
- [ ] Show total bid/ask volume and spread percentage

## Acceptance Criteria

- CLI command: `stellar-api-inspector orderbook <baseAssetCode>:<baseIssuer> <counterAssetCode>:<counterIssuer>`
- Displays price spread, top bids, and top asks
- Unit tests verify formatting and parameter matching
