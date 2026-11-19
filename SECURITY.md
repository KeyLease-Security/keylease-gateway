# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security-sensitive reports.

Report privately through GitHub's
[private vulnerability reporting](https://github.com/KeyLease-Security/keylease-gateway/security/advisories/new)
for this repository, or, if that is unavailable, contact the maintainers
directly via [GitHub](https://github.com/KeyLease-Security) and reference this
repository.

A good report includes:

- the affected component (`@keylease/cli`, `@keylease/proxy`)
- a description of the threat model and the preconditions required
- steps to reproduce, or a proof of concept
- the expected failure mode (what the system should have done instead)

## Scope

In scope:

- session token forgery, replay or expiry bypass (`kls1.*` bearer tokens)
- quota bypass or lease-verification bypass in the proxy
- escrow bugs in `contracts/keylease-core`: paying a provider twice, releasing
  more than `price_paid`, settling an active lease, refunding a revoked lease
- authorisation gaps: `use_call` without the gateway, `revoke` without the
  consumer, service mutation without its provider, `init` replay
- Soroban RPC response spoofing / cache poisoning
- secret leakage (Stellar secret seeds, session tokens) in CLI output, logs or files
- header injection or request smuggling through the reverse proxy

Out of scope:

- issues in third-party dependencies with an existing upstream fix
- denial of service against the Soroban RPC endpoint itself
- testnet-only operational issues (friendbot rate limits, unfunded demo keys)

## Security Architecture & Hardening Notes

- **Constant-time verification:** Session token verification in `@keylease/cli/token` executes Ed25519 signature verification via tweetnacl (constant time) and compares string payload claims (`lease_id`, `consumer`) using `node:crypto.timingSafeEqual` on equal-length UTF-8 byte buffers (`timingSafeEqualString`), preventing timing side-channel attacks during authentication.
- **Header allowlisting & stripping:** Inbound client headers matching `x-keylease-*` and `x-forwarded-*` are stripped on request arrival (`onRequest` hook) before any lease verification occurs. Proxy-to-upstream forwarding removes hop-by-hop headers and supports an optional strict header allowlist (`allowedHeaders` in `ProxyOptions`).
- **Body size limits & DoS protection:** Request payload limits (`maxBodyBytes`, defaulting to 32 MiB) are enforced by Fastify's content parser before lease verification. Payloads exceeding the configured limit are rejected with HTTP 413 (`payload_too_large`) without incurring blockchain RPC lookups or signature verification overhead.
- **Upstream streaming:** Responses are streamed via `Readable.fromWeb` directly to the client instead of buffered in memory, preventing memory exhaustion on large responses while propagating client abort signals upstream.

## Audit status

This software is **pre-1.0 and has not been independently audited**. Use it for
development and testnet evaluation, not for mainnet value at risk, until an
audit is announced in the repository release notes.

## Mainnet readiness

[`docs/mainnet-readiness.md`](./docs/mainnet-readiness.md) operationalises this
restriction. It lists the technical, operational and security gates that must
be completed, the escrow-solvency check, the mandatory testnet settlement
drill, and the role-based sign-off required before the software may handle
mainnet value.

That checklist does not relax this policy: an independent audit remains
mandatory, critical and high findings must be resolved or explicitly accepted,
and any unresolved gate keeps the decision at NO-GO. Until the audit is
announced and the checklist is signed off, the answer to "can this hold mainnet
value?" is no.

Operational procedures for running the proxy (startup checks, 5xx
diagnostics, quota reconciliation and key rotation) are in
[`docs/runbook.md`](./docs/runbook.md).

## Supported versions

| Version | Supported |
| --- | --- |
| latest `main` | ✅ |
| older releases | ❌ (upgrade to the latest tag) |
