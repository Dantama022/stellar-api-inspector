# Ledger entry XDR inspector

`ledger-entry-xdr <file|-> [--json]` decodes a base64 LedgerEntry offline (file path or stdin via `-`), reports entry type, last-modified ledger, sponsor and type-specific fields, and runs structural checks.
Supports account, trustline, offer, data, claimable balance, liquidity pool, contract data/code and TTL; other variants are reported as unsupported with raw XDR preserved. No network access; findings are structural, not network-state verification.
