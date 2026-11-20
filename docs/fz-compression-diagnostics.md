# fz-compression

`stellar-inspector fz-compression <url> [--encodings gzip,br] [--timeout ms] [--max-bytes n] [--json]`

Sends a small number of read-only GET requests (identity baseline plus each requested encoding), inspects `Content-Encoding`, and computes a compression ratio only when `Content-Length` is available for both responses. Otherwise the comparison is reported as inconclusive; sizes are never estimated. Downloads are capped by `--max-bytes`.
