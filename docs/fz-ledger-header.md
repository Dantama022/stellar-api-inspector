# fz-ledger-header

`stellar-inspector fz-ledger-header <file|-> [--json]`

Offline decoder for LedgerHeader XDR (base64, hex or binary; `-` reads stdin). Reports sequence, protocol version, previous/tx-set/result/bucket hashes, close time as an ISO timestamp, base fee and reserve, max tx set size, total coins, fee pool, header extension flags and upgrade count. Version-dependent fields are reported as unavailable rather than invented. No network access is used.
