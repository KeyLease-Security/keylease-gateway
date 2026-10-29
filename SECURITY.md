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

## Audit status

This software is **pre-1.0 and has not been independently audited**. Use it for
development and testnet evaluation, not for mainnet value at risk, until an
audit is announced in the repository release notes.

## Supported versions

| Version | Supported |
| --- | --- |
| latest `main` | ✅ |
| older releases | ❌ (upgrade to the latest tag) |
