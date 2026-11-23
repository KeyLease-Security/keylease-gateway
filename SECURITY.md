# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security-sensitive reports.

Report privately through GitHub's
[private vulnerability reporting](https://github.com/KeyLease-Security/keylease-gateway/security/advisories/new)
for this repository, or, if that is unavailable, contact the maintainers
directly via [GitHub](https://github.com/KeyLease-Security) and reference this
repository.

A good report includes:

- the affected component (`@keylease/cli`, `@keylease/proxy`, the contract)
- a description of the threat model and the preconditions required
- steps to reproduce, or a proof of concept
- the expected failure mode (what the system should have done instead)

## Scope

The system architecture, assets, trust boundaries and attacker model are
documented in [docs/architecture.md](./docs/architecture.md); use it to frame a
report.

In scope:

- session token forgery, replay or expiry bypass (`kls1.*` bearer tokens)
- quota bypass or lease-verification bypass in the proxy
- escrow bugs in `contracts/keylease-core`: paying a provider twice, releasing
  more than `price_paid`, settling an active lease, refunding a revoked lease
- authorisation gaps: `use_call` without the gateway, `revoke` without the
  consumer, service mutation or takeover without its provider, `init` replay,
  `upgrade` without the admin
- Soroban RPC response spoofing / cache poisoning
- secret leakage (Stellar secret seeds, session tokens) in CLI output, logs or files
- header injection or request smuggling through the reverse proxy
- a release artifact that does not verify against its published attestation

Out of scope:

- issues in third-party dependencies with an existing upstream fix
- denial of service against the Soroban RPC endpoint itself
- testnet-only operational issues (friendbot rate limits, unfunded demo keys)

## Contract upgrades

`keylease-core` (0.3.0 and later) can replace its own wasm through
`upgrade(new_wasm_hash)`. This is the most powerful entry point in the contract,
so its risk model is spelled out here.

**Who can upgrade.** Only the current admin (`Config.admin`), whose
authorisation the host checks on every call. Nobody else, including the
gateway, providers and consumers, can call it successfully. Admin rotation is
two-step (`propose_admin` / `accept_admin`), and the admin key should be a
multisig or hardware-backed account, never a hot key on a server.

**What an upgrade can change.** Everything about behaviour. The new wasm runs at
the same address, with full access to the escrowed token balance and to all
storage (config, services, leases, consumer indexes). A malicious or buggy
wasm can therefore drain escrow, rewrite leases, change the admin or remove
`upgrade` (freezing the contract for good). Treat an admin-key compromise as a
compromise of all escrowed funds.

**What it cannot change.** The contract address, and any stored data the new
code does not touch. Only a plain wasm hash is accepted: executable references,
which would let another account control the code later, are rejected by the
entry point's type. The hash must already be uploaded, otherwise the call traps
and nothing changes. The `contract_updated` event (admin topic, new wasm hash)
is only published for an upgrade that took effect.

**Storage compatibility.** The new wasm must read the existing layout:
`DataKey` variants and the stored `Config`, `Service` and `Lease` types may
gain new keys or entries, but must not be removed, renamed, reordered or
retyped without a migration that runs as part of the upgrade. Incompatible wasm
fails to decode existing entries, which can strand leases and the escrow behind
them.

**Operational safeguards before every upgrade.**

1. Build reproducibly from a reviewed, tagged commit and check that the wasm
   hash you install is the one you built and reviewed.
2. Diff the storage types against the deployed version (see the migration note
   under *Contract reference → Upgrades* in the README).
3. Rehearse on testnet over a copy of real state: upgrade, then read config,
   services, leases and consumer indexes, and run a full
   `create_lease → use_call → settle` cycle.
4. Announce the upgrade, then confirm `version()` and the `contract_updated`
   event on chain afterwards. Watch `contract_updated` events: an unexpected
   one means the admin key is compromised.

Report upgrade-path bugs (an upgrade without the admin, a bypass of the hash
check, storage corruption across an upgrade) through the private channel
above; they are in scope.

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
