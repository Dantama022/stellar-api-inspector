# Liquidity Pool Consistency Audit

```
stellar-api-inspector pool-audit <poolId> [-h <horizon>] [--max-pages <n>] [--json] [-o <file>]
```

Read-only. Validates pool identity, the two assets (present, valid, distinct), reserve amounts
(non-negative decimals), the fee parameter (30 bp is the supported constant-product fee), and
compares `total_shares` with the sum of pool-share trustline balances (paginated).

Findings are split into confirmed inconsistencies and inconclusive checks (missing fee, endpoint failures,
incomplete pagination). Status: `ok`, `warning`, `failed`, `inconclusive`.

Limits: a current snapshot cannot reconstruct historical fees or trades. Supply reconciliation is only
reported when all trustline pages were retrieved (`--max-pages`, 200 accounts per page); otherwise it is
marked `incomplete` or `unavailable`. No swaps, deposits, or withdrawals are performed.
