# ISSUE-007: Decode and Inspect Stellar Transaction Envelopes (XDR)

**EPIC:** 1 — Core Inspection
**Labels:** `enhancement`, `epic-core-inspection`
**Difficulty:** medium

## Description

Stellar uses XDR (External Data Representation) for transactions. We want an inspector feature that takes a base64 TransactionEnvelope XDR, decodes it, and prints the operational payload (source account, operations type, fee details, signatures) without requiring network connectivity.

## Tasks

- [ ] Add `decode <xdrBase64>` CLI subcommand
- [ ] Parse XDR using `@stellar/stellar-sdk`'s `TransactionBuilder.fromEnvelope`
- [ ] Extract sequence, fee, network passphrase (optional CLI override), and operations array
- [ ] Format and display transaction structure in console

## Acceptance Criteria

- Works offline
- Correctly parses multi-operation envelopes
- Errors are caught and presented cleanly if XDR string is invalid
