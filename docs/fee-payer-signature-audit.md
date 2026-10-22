# Fee-Payer and Signature Responsibility Audit (ISSUE-157)

```bash
stellar-api-inspector fee-payer-signature-audit --tx <xdr> [--network testnet] [--accounts accounts.json] [--json]
```

Supported envelopes: v0, v1, and fee-bump.

- **Fee responsibility**: the transaction source for standard envelopes; the outer fee
  source for fee-bump envelopes (reported separately from the inner source).
- **Authorization**: the transaction source needs LOW; each operation source needs its
  operation's threshold (LOW / MEDIUM / HIGH); a fee-bump fee source needs LOW on the
  outer envelope only. Paying the fee never authorizes inner operations.

Signatures are verified with the existing `verifyTransactionSignatures` utility.
Thresholds are evaluated only for accounts listed in `--accounts`:

```json
{ "G...": { "thresholds": { "low": 1, "med": 2, "high": 3 }, "signers": [{ "key": "G...", "weight": 1 }] } }
```

Accounts without supplied configuration are reported `inconclusive`. Signature presence
alone never yields an authorization-success result.

## Limitations

Only ed25519 signers are evaluated (not pre-auth-tx, hash-x, or signed-payload). Soroban
authorization entries are not evaluated. Nothing is signed, submitted, or modified.
