# ISSUE-001: Implement Horizon Endpoint Verification & Latency Test

**EPIC:** 1 — Core Inspection
**Labels:** `enhancement`, `good first issue`, `epic-core-inspection`
**Difficulty:** easy

## Description

We need a basic Horizon node validation utility. The tool should connect to any user-provided Horizon URL and verify that the endpoint is online, respond in a timely manner, and expose standard Horizon network details.

## Tasks

- [ ] Add CLI validation for Horizon server URLs
- [ ] Implement a response time (latency) benchmark
- [ ] Parse general metadata: network passphrase, protocol version, and core/horizon version
- [ ] Display connection error details gracefully when offline
- [ ] Write Jest tests verifying successful ping and offline handling

## Acceptance Criteria

- Running `stellar-api-inspector horizon <url>` executes the checker
- Latency is calculated in milliseconds
- If the endpoint is offline, output an error message and exit with code 1
- Jest test suite tests both scenarios successfully
