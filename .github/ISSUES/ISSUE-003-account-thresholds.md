# ISSUE-003: Check Account Thresholds and Signer Weights

**EPIC:** 2 — Account Auditing
**Labels:** `enhancement`, `epic-account-auditing`
**Difficulty:** medium

## Description

To audit account security, we need to inspect Stellar account threshold levels (low, medium, high) and cross-reference them with the weights of all authorized signers. This helps detect misconfigured multi-sig settings where the sum of weights cannot meet thresholds, or a single key has unintended powers.

## Tasks

- [ ] Fetch signer parameters from `Horizon.Server.loadAccount`
- [ ] Render a table mapping each signer key type and weight
- [ ] Validate and flag warnings if:
  - Total combined signer weight is less than medium or high thresholds
  - An individual master key weight is 0 but thresholds are non-zero
- [ ] Display warnings clearly in CLI output

## Acceptance Criteria

- `stellar-api-inspector account <accountId>` prints threshold warnings
- Clear warning messages appear when thresholds are unreachable
- Unit tests verify threshold configuration checks
