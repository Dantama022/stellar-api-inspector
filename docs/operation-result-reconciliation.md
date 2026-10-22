# Operation Result and Expected-Effect Reconciliation

```
stellar-api-inspector operation-result-reconciliation --hash <tx-hash> [--horizon <url>] | --file <path> [-j] [-o <path>]
```

Read-only. Correlates envelope operations with operation results and Horizon operation/effect records. Offline input: `{ "envelopeXdr", "resultXdr"?, "operations"?, "effects"? }`.

## Correlation rules

- Envelope operation N ↔ result entry N (XDR order). Result codes are decoded with `decodeTransactionResult`.
- Envelope operation N ↔ Horizon operation record N after sorting by `paging_token`/`id`.
- Effect → operation via the operation-ID prefix of the effect `paging_token` (`<operation id>-<n>`).

## Findings

| Code | Severity |
|------|----------|
| `MALFORMED_ENVELOPE`, `OPERATION_FAILED`, `RESULT_COUNT_MISMATCH`, `OPERATION_TYPE_MISMATCH`, `TRANSACTION_NOT_APPLIED` | error |
| `OPERATION_RECORD_TYPE_MISMATCH`, `MALFORMED_OPERATION_RECORD`, `UNRESOLVED_EFFECTS` | warning |
| `RESULT_UNAVAILABLE`, `MALFORMED_RESULT`, `OPERATION_RECORDS_INCOMPLETE`, `EFFECTS_UNAVAILABLE`, `EXPECTED_EFFECT_NOT_OBSERVED` | inconclusive |

## Limitations

- Expected effects are typical effects for the operation type, not guarantees. A missing effect is never treated as an execution failure.
- Per-operation codes of fee-bump inner failures are not decoded by the shared result decoder; outcomes stay `unknown`.
- Live mode fetches at most 200 effects.
