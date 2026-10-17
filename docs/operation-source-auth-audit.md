# Transaction Operation Source and Authorization Audit

```
stellar-inspector operation-source-audit <hashOrXdr> [--horizon <url>] [--passphrase <p>] [--json]
```

Read-only. A 64-hex input is treated as a transaction hash (one Horizon `GET /transactions/{hash}`); anything else is decoded as envelope XDR.

For each operation the audit reports index, type, effective source and whether the source is explicit or inherited. Fee-bump envelopes list the fee source separately; it is never treated as an operation source.

## What is and is not concluded

- Source attribution: derived from the decoded envelope.
- Signature presence: matched via 4-byte signature hints against each source key. A hint match is not cryptographic verification.
- Cryptographic validity and threshold evaluation: not performed here; use the signature verification command with signer data.
- Horizon records without `envelope_xdr`, unsigned envelopes, malformed XDR and unsupported envelopes produce `inconclusive` or `failed`, never an authorization claim.
