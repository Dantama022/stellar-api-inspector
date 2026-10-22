# Contract Upgrade Compatibility Audit (ISSUE-156)

```bash
stellar-api-inspector contract-upgrade-compat-audit --previous old.wasm --proposed new.wasm [--json]
```

Compares two Soroban contract interfaces. Each input may be:

- a WASM artifact (detected by the `\0asm` magic), decoded with the existing
  `contractspecv0` parser (`auditContractSpec`), or
- a JSON interface spec: `{ "functions": [{ "name", "inputs": [{ "name", "type" }], "outputs": [] }], "udts": [...] }`.

## Compatibility rules

| Severity | Change |
| --- | --- |
| breaking | function removed; argument count/order/type changed; return type changed |
| warning | argument renamed (types unchanged); user-defined type removed or changed |
| info | function or type added; doc changed |
| inconclusive | interface or type metadata missing on either side |

Status: `compatible`, `potentially-breaking`, `breaking`, or `inconclusive`.

## Limitations

Interface compatibility does **not** establish storage-layout compatibility, runtime
behavior compatibility, or that an on-chain upgrade will succeed. Those always require
source review and testing. No transaction is submitted and no contract is modified.
