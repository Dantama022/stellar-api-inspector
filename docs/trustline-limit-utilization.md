# Trustline Limit Utilization and Capacity Report

`stellar-inspector trustline-utilization <accountId> [--warn <pct>] [--high <pct>] [-h <horizon>] [--json] [-o <path>]`

Reads an account from Horizon (one GET request) and reports, for each trustline, the balance,
limit, remaining capacity and utilization. Horizon returns all balance entries of an account in a
single response, so no pagination is required.

Calculation rules:
- Remaining capacity = limit - balance, and utilization = balance / limit, using integer stroop
  arithmetic (7 decimal places); percentages are shown with two decimals.
- Both values must be valid decimal strings. Missing or malformed values produce a `data` finding
  and no calculation; they are never replaced with zero.
- A zero limit has no utilization percentage. The maximum int64 limit is treated as unlimited and
  has no utilization percentage.
- `--warn` (default 80) and `--high` (default 95) set utilization thresholds; warn must be lower
  than high and both must be within (0, 100].
- Authorization restrictions are reported as separate `authorization` findings. Reserve
  requirements are not evaluated and are unrelated to trustline limits.

Status: `clean`, `warning` (elevated utilization or authorization findings), `inconclusive`
(data problems) or `failed` (the account could not be retrieved).

Limitations: remaining capacity does not guarantee a payment will succeed; issuer settings,
authorization, account state and transaction conditions still apply. The report never creates or
modifies trustlines and never moves assets.
