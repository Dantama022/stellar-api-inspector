# Network Passphrase and Signature Hash Audit

`stellar-inspector network-passphrase-audit <envelopeXdr> --network testnet --network public`

A Stellar transaction signature covers a hash derived from the network passphrase and the
transaction body, so the same envelope hashes differently on each network. The audit decodes the
envelope, derives the hash for every `--network` value (aliases `testnet`, `public`, `futurenet`,
`standalone`, or a raw passphrase), and verifies signatures with `--signer` public keys through the
existing signature verifier. Passphrases are never switched silently.

Limitations: cryptographic validity is not authorization. Thresholds, signer weights, sequence
numbers, time bounds, fees and operation validity are not evaluated. Missing signatures or signer
keys yield an `inconclusive` status. Nothing is signed, submitted, or modified.
