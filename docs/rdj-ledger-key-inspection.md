# Ledger Key XDR Inspection

`stellar-inspector rdj-inspect-ledger-key <xdr|-> [--json]` decodes a base64 `LedgerKey` and reports the
entry type, identifying fields (account IDs, assets, offer IDs, data names, pool IDs, contract
address/durability/key, code hash), and whether it is classic or Soroban. Unknown variants return the raw
XDR. It does not fetch entry contents. Offline and read-only.
