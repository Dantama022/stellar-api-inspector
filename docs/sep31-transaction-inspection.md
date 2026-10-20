# SEP-31 Cross-Border Payment Transaction Inspection

Read-only inspection of a SEP-31 anchor `/transactions/:id` GET response. Validates the fields and statuses documented by the SEP-31 specification and reports internal inconsistencies as warnings (never as authoritative failures).

## Usage

```bash
# Offline: saved JSON response
stellar-api-inspector sep31-tx-inspect --file tx.json

# Inline
stellar-api-inspector sep31-tx-inspect --response '{"id":"tx-1","status":"completed","amount_in":"10","amount_in_asset":"iso4217:USD"}'

# Live: fetch from a configured anchor
stellar-api-inspector sep31-tx-inspect \
  --anchor https://anchor.example.com \
  --transaction-id tx-123 \
  --jwt eyJhbGci...
```

## What is validated

- `id` present
- `status` is a documented SEP-31 value:
  `pending_sender`, `pending_stellar`, `pending_transaction_info_update`, `pending_customer_info_update`, `pending_external`, `pending_anchor`, `pending_user`, `pending_user_transfer_start`, `pending_user_transfer_complete`, `pending_trust`, `completed`, `refunded`, `expired`, `error`
- `amount_in` and `amount_out` (if present) are decimal strings with ≤7 decimal places
- `stellar_memo_type` (if present) is one of `text`, `id`, `hash`, `return`

## What is reported as warnings (never authoritative)

- `status: "completed"` but no `amount_out`
- `status: "completed"` but no `stellar_account_id`
- `amount_in == amount_out` in the same asset

## What is reported as **inconclusive**

- Whether the anchor actually settled, refunded, or failed the payment. The tool only reports what the anchor returned.

## What is **not** done

- No transaction is submitted, updated, approved, or mutated
- No customer information is echoed back in findings
- No inference is made about fields not present in the response

## Privacy

Raw `fields`, `required_info_updates`, and `refunds` values are not echoed in findings. Only field names appear. This is enforced by a unit test.

## Exit codes

- `0` — no errors (warnings/info/inconclusive may still be present)
- `1` — one or more `error` severity findings