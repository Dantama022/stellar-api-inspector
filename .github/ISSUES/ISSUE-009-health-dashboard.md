# ISSUE-009: Multi-Endpoint Health Dashboard

**EPIC:** 1 — Core Inspection
**Labels:** `enhancement`, `epic-core-inspection`
**Difficulty:** medium

## Description

Production applications typically need to monitor redundant Horizon endpoints. We want a command to ping multiple Horizon endpoints concurrently and display a compared scorecard of latency and latest ledger sequence synchronization.

## Tasks

- [ ] Add `health <urls...>` command accepting a list of URLs
- [ ] Ping all URLs in parallel using `Promise.all`
- [ ] Render a comparison scorecard table displaying status, latency, ledger sequence, and sync lag
- [ ] Benchmark comparison tests with mock setups

## Acceptance Criteria

- Runs cleanly against multiple servers
- Identifies and highlights out-of-sync servers (lagging by more than 3 ledgers)
- Concurrency handles up to 10 endpoints without crashing
