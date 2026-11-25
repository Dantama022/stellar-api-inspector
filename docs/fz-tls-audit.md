# fz-tls-audit

`stellar-inspector fz-tls-audit <url> [--timeout ms] [--ca-file pem] [--warn-days n] [--json]`

Audits the TLS certificate of a Horizon endpoint: subject, issuer, validity, hostname match, chain trust, expiry warnings, negotiated protocol and cipher. Certificate failures are reported separately from connectivity failures. A custom CA bundle (`--ca-file`) is used as the trust store for the probe; certificate verification is never disabled in the reported result. No private material is output and nothing is submitted to the network.
