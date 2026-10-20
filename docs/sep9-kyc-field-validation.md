# SEP-9 Customer Information Field Validation

Read-only validation of SEP-9 customer-information payloads against the field set and documented formats defined by the SEP-9 specification.

## Usage

```bash
# Validate a saved JSON payload
stellar-api-inspector sep9-kyc-validate --file customer.json --customer-type individual

# Inline payload
stellar-api-inspector sep9-kyc-validate \
  --response '{"email_address":"a@b.co","first_name":"Ada"}' \
  --customer-type individual

# Strict mode + caller-supplied required fields
stellar-api-inspector sep9-kyc-validate --file customer.json \
  --customer-type organization \
  --required "organization.name,email_address" \
  --strict

# Read from stdin (useful in pipes)
cat customer.json | stellar-api-inspector sep9-kyc-validate --stdin --customer-type individual
```

## What is validated

- Payload is a JSON object
- Field names are on the SEP-9 specification field set
- Email addresses use RFC-5322-compatible format
- Phone numbers use E.164 format (`+14155552671`)
- Dates (`birth_date`, `id_issue_date`, `id_expiration_date`) use `YYYY-MM-DD`
- Country codes use ISO 3166-1 alpha-2
- `organization.website` uses `https://`
- Caller-supplied `--required` fields are present

## What is **not** validated

- Whether the customer's identity is real or verified
- Whether the anchor's KYC policy is satisfied
- Whether a specific anchor would accept the payload

The tool's `scopeNote` field is included in every result and in the JSON output to make this explicit.

## Privacy

Raw field values are **never** echoed in findings. Only the field name and reason category appear in output. This is enforced by a unit test.

## Exit codes

- `0` — no errors (warnings/info/inconclusive may still be present)
- `1` — one or more `error` severity findings

## Known limitations

- Only fields defined by the SEP-9 specification are validated. Custom anchor extensions require `--strict` handling or a future feature.
- The tool does not fetch anything from the network in this release.