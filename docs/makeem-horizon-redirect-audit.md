# Horizon redirect audit

`horizon-redirect-audit <url> [--no-follow] [--max-redirects n] [--allow-cross-host] [--timeout ms] [--json]` records each redirect hop (301/302/303/307/308), validates Location, detects loops, depth overruns, host/scheme/port changes and HTTPS downgrades. Cross-host redirects are not followed unless explicitly allowed.
