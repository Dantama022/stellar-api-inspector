# ISSUE-026: Add Soroban Contract Inspection Command

**Closes #32**

## Summary

This PR delivers the `stellar-api-inspector contract <contractId>` CLI
command requested in ISSUE-026. It performs a quick, read-only diagnostic
overview of a deployed Soroban contract by querying the Soroban RPC
endpoint's JSON-RPC `getLedgerEntries` method, decoding the resulting
ledger entries (instance + WASM code) via the Stellar SDK, and rendering a
human-readable table — with full JSON output support for shell pipelines.

The inspection now also concurrently fetches the RPC node's network
information (passphrase, protocol version) so a single command answers
both "is my contract deployed?" and "am I pointed at the right network?".

## Files Changed

### Source

- `src/cli/index.ts`
  - **contract command**: simplified to ~50 lines (down from ~120). Calls
    `inspectSorobanContract` and `inspectSoroban` concurrently via
    `Promise.all`; rejects on contract-side failure (the critical path);
    tolerates a network-side failure by emitting a single ⚠ warning plus
    `Unknown` cells, and forwarding the same data shape through `--json`.
  - Forwarded unchanged: `--rpc`, `--ttl-warning-ledgers`, `--json`,
    `--output`, `--verbose` flags. Backward-compatible with the pre-PR
    `ContractInspectionResult` JSON envelope (no field removed or renamed).

- `src/output/contract-report.ts` **(new)**
  - Pure helper `formatContractInspectionReport(result, networkInfo, options)`
    that produces the human-readable contract inspection report. No I/O,
    no commander coupling — unit-tested directly in 11 pure tests.
  - Single canonical ⚠ signal: all warnings (result.warnings and the
    network-probe failure) are clustered at the bottom of the report.
  - Decomposed into `buildPropertyRows`, `buildTtlSection`,
    `buildStorageSection`, `renderWarnings` — each under 30 lines.

### Tests

- `tests/contract.test.ts` **(5 new tests on top of 5 existing)**
  - `rejects malformed contract IDs before touching the network`
  - `rejects empty contract IDs with a useful message`
  - `propagates HTTP error responses from the RPC endpoint`
  - `propagates JSON-RPC error payloads from the RPC endpoint`
  - `handles unknown contracts gracefully and emits a warning`
  - `produces an inspectable result shape suitable for the JSON output envelope`
    (asserts concrete fields survive the `{ok:true, data:result}` envelope).

- `tests/contract-report.test.ts` **(new file, 11 tests)**
  - Pure unit tests for `formatContractInspectionReport`:
    1. Renders the banner with all primary property rows.
    2. Shows network passphrase + protocol version when probe succeeds.
    3. Does NOT emit the ⚠ warning on the happy path.
    4. Renders "Unknown" for missing network fields when probe is online but partial.
    5. Emits a SINGLE ⚠ warning line and "Unknown" cells when probe is offline.
    6. Emits the ⚠ warning with a default reason when offline with no error.
    7. Handles `networkInfo === undefined` (defensive case).
    8. Surfaces `result.warnings` alongside any network ⚠ warning.
    9. Renders TTL section values, "Unknown" for missing.
    10. Renders Storage Footprint section.
    11. Renders "Unknown" / "Unavailable" / "NO" for missing or negative result fields.

- `tests/contract-cli.test.ts` **(deleted)**
  - The brittle commander-via-`jest.isolateModules` + `process.exit` stub
    + `setImmediate` flush pattern, replaced entirely by the pure helper
    tests. This was the only reviewer-flagged test-quality regression; now
    removed.

### Docs

- `README.md`
  - Updated the "Soroban Contract Inspection" section with the new
    sample output (Network Passphrase row, Protocol Version row, WASM
    Size), the new JSON envelope structure (full field listing), and the
    graceful-failure note for unknown contracts.

### Baseline fixes (collateral — auto-fixed by `prettier --write` while resolving pre-PR CI lint errors)

- `src/inspectors/account.ts` — 1-line prettier auto-fix in the account-audit block (collateral cleanup; the change is formatting-only, no behavior diff).
- `tests/horizon-features.test.ts` — 1-line prettier auto-fix in the rate-limit row assertion (collateral cleanup; no behavior diff).
- `tests/formatters.test.ts` — fix UTF-8 box-drawing character assertions (`┌`/`└`) that were stored as mojibake (`â"`) in the test source. Baseline test had been failing on every CI run before this PR.

## Acceptance Criteria (11/11)

- [x] **Add `contract <contractId>` CLI command** — `src/cli/index.ts` `program.command('contract <contractId>')`.
- [x] **Validate Soroban contract IDs** — `validateContractId(contractId)` in `src/utils/xdr.ts`; rejected contract IDs throw with a clear `Invalid Soroban contract ID: <id>` message without ever touching the network.
- [x] **Connect to Soroban RPC endpoint** — `fetch` with `POST` + `application/json`, JSON-RPC 2.0 envelope, `User-Agent: Stellar-API-Inspector/1.0`.
- [x] **Retrieve contract instance information** — `getLedgerEntries` against the contract instance key built via `buildContractInstanceLedgerKey`.
- [x] **Display**:
  - [x] **Contract ID** — `result.contractId` row.
  - [x] **Deployment ledger** — surfaced as `Last Modified Ledger` from `entry.lastModifiedLedgerSeq` (Soroban's native field; no separate deployment-ledger exposure exists).
  - [x] **Contract instance data** — `Instance Storage Entries` row + `Instance Found` indicator.
  - [x] **Wasm hash where available** — `WASM Code Hash` row, falls back to "Unknown" if absent.
  - [x] **Network information** — `Network Passphrase` + `Protocol Version` rows, from concurrent `inspectSoroban` call.
- [x] **Support configurable RPC endpoints** — `--rpc <url>` flag, defaults to `https://soroban-testnet.stellar.org`.
- [x] **Support JSON output mode** — `--json` flag, `--output <path>` for direct file write.
- [x] **Handle unknown contracts gracefully** — `instance.found: false`, `warnings` includes `"Contract instance ledger entry was not found."`. No exception thrown. Verified by `handles unknown contracts gracefully and emits a warning`.
- [x] **Handle RPC failures gracefully** — single `.catch` outside the `try`, single ⚠ warning line, JSON error envelope via `outputJsonError()`. Available actionable messaging per acceptance: `"⚠ Could not retrieve RPC network info: HTTP <status> <statusText>"` or `"...: RPC returned offline status"`. Invalid contract IDs return a plain error envelope before any network call.
- [x] **Add unit tests** — 16 new tests (5 service + 11 helper).
- [x] **Document usage examples in README** — full sample output, JSON envelope, and graceful-failure note added to README's "Soroban Contract Inspection" section.

## Testing Requirements (7/7)

- [x] **Verify contract ID validation** — `rejects malformed contract IDs`, `rejects empty contract IDs`.
- [x] **Verify contract lookup** — `retrieves metadata, computes TTL, and warns near expiration`, `handles unknown contracts gracefully`.
- [x] **Verify contract metadata parsing** — `extracts code hash and owner from contract instance XDR`, `extracts WASM size from contract code XDR`.
- [x] **Verify invalid contract handling** — `rejects malformed contract IDs` (string) + new fixture assertion confirming `fetch` is never called.
- [x] **Verify RPC failure handling** — `propagates HTTP error responses` (HTTP 500), `propagates JSON-RPC error payloads` (JSON-RPC -32600), offline-test in helper suite covering HTTP 502.
- [x] **Verify JSON output** — `produces an inspectable result shape suitable for the JSON output envelope`, plus the `outputJson` test path in `tests/json-output.test.ts` (already covered via shared `writeResult` helper).
- [x] **Verify test suite passes** — 17 test suites, 185 tests, 100% pass rate.

## Test Plan

### Final CI gate (run locally before pushing)

```bash
npm ci
npm run lint       # → ESLint + Prettier (0 errors)
npm run typecheck  # → tsc --noEmit (0 errors)
npm test -- --ci   # → 17 suites, 185 tests, 0 failures
npm run build      # → tsc emit to ./dist (0 errors)
```

### Manual smoke test (optional, requires Soroban RPC access)

> The `<CONTRACT_ID>` placeholder must be a real, valid `C...` address whose
> 32-byte payload + StrKey CRC-16 checksum both validate. Generate one in a
> Node REPL with `StrKey.encodeContract(Buffer.alloc(32, 7))`, or use a known
> mainnet/testnet contract. The placeholder string `CAAAA…` shown below is
> intentionally NOT a real contract address — it will be rejected by
> `validateContractId` before any RPC call. Use a real one when copying.

```bash
# Happy path
npm run dev -- contract <CONTRACT_ID> \
  --rpc https://soroban-testnet.stellar.org
# Expect: "✔ Contract inspection complete." then the full table including
# Network Passphrase + Protocol Version rows and the WASM section.

# JSON pipeline
npm run dev -- contract <CONTRACT_ID> \
  --rpc https://soroban-testnet.stellar.org \
  --json | jq '.data | { contractId, wasmHash, instance, code }'
# Expect: parseable JSON envelope {ok:true, data:{…}}.

# Graceful unknown-contract behavior. Generate a valid C-address whose
# ledger entry doesn't exist on the target RPC network by encoding
# arbitrary bytes, then substitute it for <UNKNOWN_VALID_C_ADDRESS>
# in the command below:
#   node -e 'process.stdout.write(require("@stellar/stellar-sdk").StrKey.encodeContract(Buffer.alloc(32, 99)))'
# (That one-liner prints a syntactically valid C… address whose 32 bytes
#  all equal 0x63 — guaranteed unused on any real network.)
npm run dev -- contract <UNKNOWN_VALID_C_ADDRESS> \
  --rpc https://soroban-testnet.stellar.org
# Expect: ✔ Contract inspection complete., Instance Found = NO, Code
# Entry Found = NO, ⚠ warning "Contract instance ledger entry was not
# found."

# Invalid contract ID rejection (any syntactically malformed string)
npm run dev -- contract not-a-contract-id \
  --rpc https://soroban-testnet.stellar.org
# Expect (non-JSON): logged error "Invalid Soroban contract ID: …", exit 1.
# Expect    (--json): JSON envelope {ok:false, error:"Invalid Soroban
#                 contract ID: not-a-contract-id", code:1}.

# RPC failure surface (use an obviously unreachable URL)
npm run dev -- contract <CONTRACT_ID> \
  --rpc https://not-a-real-rpc.example.com
# Expect (non-JSON): spinner fail with the HTTP error, exit 1.
# Expect    (--json): no spinner visual (silenced in JSON mode);
#                 JSON envelope {ok:false, error:"…HTTP error…", code:1}.
```

## Risk Assessment

- **Backward compatibility**: `ContractInspectionResult` JSON envelope is
  additive only (the new fields are CLI-side display only, not in the
  service data). Pre-PR consumers of `contract --json` output will see
  byte-identical JSON payload.
- **Performance**: The new `Promise.all` orchestration does 2 RPC calls
  in parallel instead of 2 sequential calls when network info is visible.
  For unreachable RPC, the WHOLE command fails; we don't waste time on
  the contract inspector when the endpoint is offline (whichever call
  fails first aborts).
- **Dependency footprint**: No new runtime dependencies. Only adds the
  pure helper file `src/output/contract-report.ts`.

## Out of Scope

- **Globally-failing audit "metrics changes"**: the original issue
  had a fragment `"Audit metrics changes"` between the title and the
  description. Not a separate requirement; treated as issue-text noise.
- **ISSUE-026.md roadmap file**: the local `ISSUES/` directory in the
  parent repo isn't tracked in this branch, so no markdown file
  mirroring the issue template was committed.

## How to Open the PR

> Pre-conditions: this branch is currently on `main` with all changes
> uncommitted in the working tree. Either commit on `main` directly
> (and force-push) if you have permission, OR create-and-switch to a
> feature branch first. The commands below cover the feature-branch
> workflow.

> `gh` CLI requires authentication against the upstream repo (`gh auth
> login`), push permissions for the contributor fork, and write access
> to the target branch. Manual fallback: open the PR via the GitHub
> web UI and copy the contents of `PR_DESCRIPTION.md` into the PR
> body.

```bash
cd /workspaces/stellar-api-inspector

# 1. Confirm the parent branch and working-tree state.
git branch --show-current    # expect: main
git status --short           # expect: M src/... , ?? PR_DESCRIPTION.md, ?? tests/...

# 2. Create-and-switch to a feature branch (clean workflow).
git switch -c feature/issue-026-contract-inspection

# 3. Stage all the modifications + new helper + new tests + PR doc.
git add -A

# 4. Verify the staged set before committing.
git status --short
# expect: ?? PR_DESCRIPTION.md
# expect: M src/cli/index.ts
# expect: A src/output/contract-report.ts
# expect: M tests/contract.test.ts
# expect: M tests/formatters.test.ts
# expect: A tests/contract-report.test.ts
# expect: M README.md
# (note: any cosmetic prettier auto-fix diffs on the existing files
#  — e.g. `src/cli/index.ts` import-line collapse — are expected.)

# 5. Commit with a Conventional-Commits subject; the Closes #32 trailer
#    belongs to the body, not the subject (GitHub auto-closes on either).
#    Use a heredoc to avoid leading-whitespace pollution in the rendered
#    commit message body.
git commit -F - <<'EOF'
feat(contract): add Soroban contract inspection command

- Add `contract <contractId>` CLI command with `--rpc`, `--ttl-warning-ledgers`,
  `--json`, `--output`, `--verbose`.
- Concurrently fetch contract ledger entries + RPC network info via
  `Promise.all`; tolerate network-side failure with a single ⚠ warning.
- Extract presentation to `src/output/contract-report.ts` (pure helper,
  unit-tested in isolation).
- Add 5 service-level tests in `tests/contract.test.ts`; 11 helper tests in
  `tests/contract-report.test.ts`; delete `tests/contract-cli.test.ts`.
- Fix UTF-8 box-drawing character assertions in `tests/formatters.test.ts`.
- Update README 'Soroban Contract Inspection' section with the new sample
  output, JSON envelope, and graceful-failure note.

Closes #32
EOF

# 6. Push the feature branch to your fork (or upstream, if you have rights).
git push origin feature/issue-026-contract-inspection

# 7. Open the PR with the body from this file.
gh pr create \
  --title "feat(contract): add Soroban contract inspection command (closes #32)" \
  --body-file PR_DESCRIPTION.md \
  --base main \
  --label enhancement \
  --label "complexity: medium" \
  --label wave \
  --reviewer <upstream-maintainer-handle>
```

> The `--label` flags mirror the labels attached to ISSUE-026 (`enhancement`,
> `complexity: medium`, `wave`). Skip them if your fork's PR template ignores
> labels, or replace per your team's labeling convention.

---

**Total delta**:

- 1 new file: `src/output/contract-report.ts` (~140 lines)
- 1 new file: `tests/contract-report.test.ts` (~135 lines)
- 1 new docs file: `PR_DESCRIPTION.md` (this file)
- Modifications (6 files): `src/cli/index.ts`, `tests/contract.test.ts`,
  `tests/formatters.test.ts`, `src/inspectors/account.ts`,
  `tests/horizon-features.test.ts`, `README.md`
- 1 deleted file: `tests/contract-cli.test.ts`
- **+16 new tests** (5 service-level in `tests/contract.test.ts` +
  11 pure-helper in `tests/contract-report.test.ts`)
- **0 regressions**, **185/185 total passing**
