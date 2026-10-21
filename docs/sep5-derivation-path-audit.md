# SEP-5 Derivation Path Audit

```
stellar-api-inspector sep5-derivation-audit <path> [--wallet-profile stellar-default|ledger|trezor] [-j] [-o <path>]
```

Read-only. Validates a derivation path against the SEP-5 BIP-44-style scheme for Stellar keys. **Never** derives, requests, or echoes any private key, seed phrase, or mnemonic.

## SEP-5 path format

```
m / 44' / 148' / account' / change / address_index
```

- `44'` — BIP-44 purpose (hardened, required)
- `148'` — Stellar SLIP-0044 coin type (hardened, required)
- `account'` — account index (hardened)
- `change` — 0 (external) or 1 (internal), non-hardened (optional)
- `address_index` — address index within account, non-hardened (optional)

## What is validated

- Leading `m/` prefix (warning only if absent — some tools accept both forms)
- Component syntax: non-negative integer optionally followed by `'` or `h`
- Purpose component == `44'` (hardened)
- Coin type component == `148'` (hardened)
- Account component is hardened
- Change component (if present) is 0 or 1, non-hardened
- Address index (if present) is non-hardened
- Component values within BIP-32 maximum (`2^31 - 1`)

## Wallet profile comparison

When `--wallet-profile` is supplied, deviations from that profile's documented conventions are reported as warnings, not as universal errors:

| Profile | Convention |
|---|---|
| `stellar-default` | 3-component `m/44'/148'/account'` (extended paths reported as info) |
| `ledger` | 3-component `m/44'/148'/account'` (extended paths warned) |
| `trezor` | 3-component `m/44'/148'/account'` (extended paths warned) |

## Always inconclusive

- `WALLET_COMPATIBILITY_NOT_VERIFIED` — a syntactically valid path is not proof that a specific wallet can derive or access a specific account. Verifying that requires the wallet to derive the key pair and prove control.

## Limitations

- Does not generate, request, derive, store, or echo any private key, seed phrase, or mnemonic.
- Different wallets may interpret nominally identical paths differently (SLIP-0010 Ed25519 vs BIP-32 secp256k1, different defaults).
- Extended paths (5 components) are valid SEP-5 but non-default for many Stellar wallets.
- No network I/O.