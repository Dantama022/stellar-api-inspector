# Memo and Operation Context Audit (ISSUE-165)

Validates a transaction against optional, user-defined memo and operation-context rules. Every rule is optional; with no rules, only protocol-level checks run.

```bash
stellar-api-inspector memo-context-audit --tx <base64-xdr> --require-memo --memo-types text,id --memo-pattern '^INV-\d+$' --destinations GABC...,GDEF... --min-ops 1 --max-ops 5 [--json]
stellar-api-inspector memo-context-audit --file tx.xdr --rules rules.json
```

`rules.json` (CLI flags override file values):

```json
{
  "memoRequired": true,
  "allowedMemoTypes": ["text", "id"],
  "memoExact": "INV-123",
  "memoPattern": "^INV-\\d+$",
  "expectedDestinations": ["GABC..."],
  "minOperations": 1,
  "maxOperations": 5
}
```

## Findings

- **protocol**: `MALFORMED_ENVELOPE`, `NO_OPERATIONS`, `TOO_MANY_OPERATIONS` (> 100).
- **policy**: `MEMO_MISSING`, `MEMO_TYPE_NOT_ALLOWED`, `MEMO_VALUE_MISMATCH`, `MEMO_PATTERN_MISMATCH`, `OPERATION_COUNT_BELOW_MIN`, `OPERATION_COUNT_ABOVE_MAX`, `UNEXPECTED_DESTINATION`.
- **info**: `DESTINATION_NOT_APPLICABLE` (operation has no single reliable destination), `MEMO_VALUE_NOT_EVALUATED`.

Destinations are checked for `payment`, `pathPaymentStrictSend`, `pathPaymentStrictReceive`, `createAccount` and `accountMerge`. Muxed addresses also match their base account. Hash and return memos are compared as hex.

Status: `pass`, `policy-violation`, `protocol-invalid` or `invalid-config`. Invalid rules exit with every error listed; no rule is silently skipped.
