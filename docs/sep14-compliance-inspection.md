# SEP-14 Inspection (Unpublished Specification)

```
stellar-api-inspector sep14-inspect [--response <json>] [--file <path>] [--stdin] [-j] [-o <path>]
```

**Important:** SEP-14 has no published schema in the Stellar SEP numbering. This command exists to satisfy the issue scope in a specification-faithful way. It **always** emits a `SEP14_UNPUBLISHED_SPEC` inconclusive finding, and it points callers at the actual specifications that cover the intent described in the issue.

## What is reported

- Whether the payload is a JSON object.
- The names of top-level fields present (values are **never** echoed).
- Whether any field names look like SEP-9 customer-information fields or SEP-8 approve-response fields, with a redirect note.

## What is **not** reported

- Regulatory compliance status of any kind.
- Customer approval or KYC verification.
- Whether the payload would be accepted by an anchor.

## Actual specs for the intent

- **Regulatory asset transactions** → SEP-8 → use `sep8-approve-inspect`.
- **Customer information fields** → SEP-9 → use `sep9-kyc-validate`.
- **Customer KYC status** → SEP-12 → use `sep12-kyc-audit`.

## Limitations

- No schema exists to validate against, so this command cannot produce a compliance determination of any kind.
- It is a structural sanity check plus a redirect, nothing more.
- It never sends the payload to an external service.