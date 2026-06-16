# ISSUE-002: Inspect Horizon Rate Limit Headers

**EPIC:** 1 — Core Inspection
**Labels:** `enhancement`, `epic-core-inspection`
**Difficulty:** easy

## Description

Horizon endpoints returned by public networks enforce rate limiting and specify remaining allowances in headers:
- `X-Ratelimit-Limit`
- `X-Ratelimit-Remaining`
- `X-Ratelimit-Reset`

We should fetch, parse, and present these headers in our Horizon subcommand.

## Tasks

- [ ] Extract rate limit headers from HTTP responses
- [ ] Parse values safely (fall back to null if headers are missing)
- [ ] Add CLI coloring: format remaining calls in yellow/red when quota is low (<10%)
- [ ] Include rate limit fields in output tables and JSON reports

## Acceptance Criteria

- Output displays rate limit details when checking public endpoints
- Handles custom or private Horizon instances that omit these headers
- Unit tests verify header parsing logic
