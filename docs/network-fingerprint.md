# Network Capability Fingerprint

```
stellar-api-inspector network-fingerprint \
  [-h <horizon-url>] [-r <rpc-url>] \
  [--compare <saved.json>] [-j] [-o <path>]
```

Read-only. Produces a deterministic fingerprint of a network's observable configuration and supported protocol capabilities.

## Two fingerprints

### Stable fingerprint

SHA-256 of normalized `{networkPassphrase, protocolVersion}` only.

- **Stable across operator upgrades.** The value does not change when Horizon, Core, or the Soroban RPC is upgraded.
- Use this to identify a network.

### Detailed fingerprint

SHA-256 of normalized `{networkPassphrase, protocolVersion, horizonVersion, coreVersion, rpcImplementation, rpcVersion, rpcRevision}`.

- **Changes when software is upgraded.** Expected to differ even on the same network.
- Use this to detect operator-side changes.

## Normalization

Values are normalized deterministically:

- Every value is cast to `string` (or kept as `number` for `protocolVersion`).
- `undefined` / `null` → `null` in the normalized form.
- Keys are sorted lexicographically before JSON serialization.
- No inference, no defaults, no undocumented fields.

## Comparison mode

`--compare <saved.json>` loads a previously captured profile (from a `--output` file or a bare `profile` object) and reports:

- Whether stable fingerprints match
- Whether detailed fingerprints match
- Per-field changes (`changes`), additions (`added`), removals (`removed`), and unavailable fields (`unavailable`)

**Matching fingerprints are never presented as proof of complete network equivalence.** `FINGERPRINT_NOT_EQUIVALENCE_PROOF` is emitted on every result.

## Limitations

- The fingerprint reflects values captured at observation time only. Ledger state, mempool contents, and deployment topology are out of scope.
- Software versions are only as complete as the endpoints report (Horizon and Soroban RPC may omit some fields).
- If an endpoint is unreachable, its fields become `null` and the audit reports a corresponding warning.
- Read-only; never submits transactions or modifies state.