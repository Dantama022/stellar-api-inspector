# ISSUE-015: Validate Horizon SSL/TLS configuration

**EPIC:** 1 — Core Inspection
**Labels:** `enhancement`, `epic-core-inspection`
**Difficulty:** medium

## Description

Production Horizon servers MUST enforce SSL/TLS. We need to check if the server is served over HTTPS, validate that the certificate is valid, verify expiration dates, and flag warnings if insecure cipher suites or protocol versions (like TLS 1.0 or 1.1) are enabled.

## Tasks

- [ ] Inspect connection protocol and enforce HTTPS
- [ ] Connect using `tls.connect` to retrieve peer certificate
- [ ] Parse and display certificate validity ranges and issuer
- [ ] Warn if certificate expires in < 30 days or is self-signed

## Acceptance Criteria

- Horizon inspection details include SSL certificate status and expiration warnings
- Self-signed certificates are flagged
- Integration tests verify certificate check utility mock returns
