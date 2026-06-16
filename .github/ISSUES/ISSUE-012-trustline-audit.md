# ISSUE-012: Detect Trustline Inconsistencies for Accounts

**EPIC:** 2 — Account Auditing
**Labels:** `enhancement`, `epic-account-auditing`
**Difficulty:** medium

## Description

Accounts on Stellar require a "trustline" to hold non-native assets. We need to audit whether an account's trustlines are valid, check if they are authorized by the asset issuer (if auth_required flag is set on issuer), and detect any close-to-limit balances or disabled trustlines.

## Tasks

- [ ] Fetch asset trustlines using `loadAccount`
- [ ] For each non-native asset, query issuer's flags (`auth_required`, `auth_revocable`)
- [ ] Crosscheck if the trustline is authorized (`is_authorized` or `is_authorized_to_maintain_liabilities` flags)
- [ ] Output list of trustlines along with authorization status and warnings

## Acceptance Criteria

- `stellar-api-inspector account <accountId>` reports trustline authorization issues
- Reports warnings if balance is within 1% of the trustline limit
- Unit tests verify trustline status detection
