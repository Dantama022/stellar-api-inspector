# Payment Destination Readiness Audit

```
stellar-inspector payment-destination-readiness <destination> [--asset native|CODE:ISSUER] [--amount <n>] [--horizon <url>] [--json]
```

Read-only. Only `GET /accounts/{id}` is requested (destination, plus the issuer when a trustline is missing).

- Native XLM: reports whether the destination exists; no trustline is needed.
- Issued asset: checks trustline presence, authorization (`is_authorized`, maintain-liabilities), and receiving capacity (`limit - balance - buying_liabilities`, decimal-safe in stroops).
- Missing trustlines require a separate trustline-creation transaction; reserve notes consider sponsorship.
- Missing or malformed data yields an `inconclusive` result.

## Limitations

A snapshot cannot predict success. Source balance, fees, sequence numbers, trustline changes before submission, and offers/liabilities created later are out of scope. Readiness does not guarantee transaction success.
