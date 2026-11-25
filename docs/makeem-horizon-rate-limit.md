# Horizon rate-limit analysis

`horizon-rate-limit [endpoint] [--requests n] [--delay ms] [--json]` classifies HTTP 429 separately from 401/403, 5xx and network errors, parses Retry-After and provider rate-limit headers, and gives retry guidance.
Defaults to a single request; max 10 requests, minimum 500ms delay. No automatic retries.
