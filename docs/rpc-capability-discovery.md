# Soroban RPC Capability Discovery

```
stellar-api-inspector rpc-capability-discovery <url...> [--timeout <ms>] [--json] [-o file]
```

Probes a registry of documented, read-only Soroban RPC methods (see `RPC_METHOD_REGISTRY` in
`src/services/rpc-capability-discovery.ts`). `sendTransaction` and `simulateTransaction` are never called.

## Classification

- **supported**: the method returned a result, or an error (e.g. `-32602` invalid params) proving it exists.
- **unsupported**: only an explicit JSON-RPC `-32601` method-not-found.
- **inconclusive**: timeouts, transport errors, HTTP 401/403, 429, 5xx, 404/405 or malformed responses.
  The reason is reported (`timeout`, `transport`, `unauthorized`, `rate-limited`, `server-error`, `unexpected-response`).

Several URLs may be passed; a differences section lists methods whose status differs between endpoints.

## Limitations

Probes use minimal parameters, so a supported method may answer with a parameter error. Retention-limited
methods (`getTransactions`, `getLedgers`, `getEvents`) may report errors that are still treated as "recognized".
