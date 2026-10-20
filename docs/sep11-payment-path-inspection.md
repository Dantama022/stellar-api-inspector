# SEP-11 Txrep Payment-Path Inspection

**Important specification note:** In the current Stellar SEP numbering, **SEP-11 is "Txrep — Transaction Representation"**, a human-readable text representation of a transaction envelope. SEP-11 does **not** define a standalone payment-path API. This command therefore inspects SEP-11 txrep files and validates the fields the specification actually documents for `payment`, `path_payment_strict_send`, and `path_payment_strict_receive` operations.

## Usage

```bash
# Inspect a .txrep file
stellar-api-inspector sep11-txrep-inspect --file tx.txrep

# Inline content
stellar-api-inspector sep11-txrep-inspect --txrep 'sourceAccount: G...
seq: 1
fee: 100
ops[0].type: PAYMENT
ops[0].destination: G...
ops[0].asset: XLM
ops[0].amount: 10'

# stdin
cat tx.txrep | stellar-api-inspector sep11-txrep-inspect --stdin
```

## What is validated

- `sourceAccount` present
- `seq` present and integer string
- `fee` integer string (if present)
- `operations[i].type` present
- `PAYMENT` operations: `destination`, `asset` (XLM or `CODE:ISSUER`), `amount` (decimal, ≤7 places)
- `PATH_PAYMENT_STRICT_SEND` / `_RECEIVE`: `sendAsset`, `sendMax`, `destAsset`, `destAmount`, `path[]` (each intermediate asset valid)
- All asset identifiers are validated through the repository's existing `parseAsset()` utility

## What is **not** validated

- Whether a payment path is available on Horizon at execution time
- Whether the transaction would succeed on the network
- Anchor-specific availability of the destination asset

These are surfaced as an `inconclusive` finding (`HORIZON_PATH_FINDING_NOT_CHECKED`). Use `path-routes` for Horizon path-finding; use `sep31-tx-inspect` for anchor payment status.

## Exit codes

- `0` — no errors
- `1` — one or more `error` severity findings