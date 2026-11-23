# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the pre-1.0 policy below. Entries are grouped as `Added`, `Changed`,
`Fixed` and `Security`.

There are no Git release tags in this repository at the time of writing.
Version numbers below come from the checked-in manifests. The historical core
baseline is `0.2.0`; `contracts/keylease-core/Cargo.toml` is bumped to `0.3.0`
in `Unreleased` for the additive `extend_lease` ABI change below. The TypeScript
packages and workspace remain at `0.1.0`.

## [Unreleased]

### Added

- `docs/troubleshooting.md`: exact CLI codes, token codes, contract traps and
  proxy 401/403 denials with the command or configuration change that fixes
  them.
- `CONTRIBUTING.md`: an end-to-end first-contribution walkthrough from
  `git clone` through a reviewable PR, with the repository's label/point scheme
  and three real open good-first issues.
- This changelog, linked from the README and CONTRIBUTING.
- `keylease-core` entry point `extend_lease(lease_id, extra_calls,
  extra_duration)`: consumer-authorised top-up of an active, unexpired,
  unsettled lease. One dimension may be zero; both may not. The top-up uses the
  `create_lease` price formula with checked arithmetic, adds to escrow and
  `price_paid`, grows `calls_limit` / `expires_at`, and emits a dedicated
  `lease_extended` event.
- Contract and troubleshooting documentation for the new entry point. The CLI
  has no `extend` command yet; call the contract directly.

### Changed

- `contracts/keylease-core` is bumped from `0.2.0` to `0.3.0` because the new
  entry point and event are additive ABI changes. No release tag is created by
  this change.
- `docs/troubleshooting.md` now lists `extend_lease` among the raising entry
  points for contract codes 2, 3, 5, 6, 7, 9, 10, 11 and 13.

### Fixed

- No fixes in this section yet.

### Security

- `extend_lease` adds a second escrow transfer path to review: it must require
  the stored lease consumer's auth, refuse settled/inactive/expired leases,
  price only the added calls, and never double-pay on settlement. The pre-1.0,
  unaudited policy in [SECURITY.md](./SECURITY.md) remains in force.

## [0.2.0] - keylease-core

Historical baseline before this branch. No Git tag exists for it; the entries
below are derived from the prior manifest, the current source and the commit
history (starting with `9aad5c5 feat: make keylease-core an escrowed Soroban
contract in this repo`).

### Added

- The on-chain component was re-scoped from a link to an external registry
  contract into the in-repo Soroban crate `contracts/keylease-core`, built with
  `soroban-sdk` 29 for `wasm32v1-none`.
- Prepaid escrow: `create_lease` pulls `calls × price_per_call` of the configured
  SAC token from the consumer before a lease exists.
- On-chain quota: gateway-authenticated `use_call` commits served calls so a
  second proxy cannot mint free quota.
- Deterministic payouts: permissionless `settle` after expiry or exhaustion and
  consumer-authorised `revoke` release `price_paid` at most once.
- Typed errors (codes 1–15) and events (`init`, `gateway`, `admin_proposed`,
  `admin_changed`, `service_registered`, `lease_created`, `calls_committed`,
  `lease_revoked`, `lease_settled`).
- Views `get_lease`, `get_service`, `get_config`, `remaining_calls` and the
  `version` ABI view, which is readable before `init`.
- Two-step admin handover (`propose_admin` / `accept_admin`), `InvalidConsumer`
  rejection of the contract as a lease consumer, overflow checks in `quote`,
  and read-side TTL bumps for leases, services and config.

### Changed

- The core product logic moved from a TypeScript wrapper around an external
  registry contract into this repository's Rust contract. The CLI and proxy now
  follow the contract ABI: reads are simulated over Soroban RPC instead of
  reading raw storage, and writes are signed invocations.
- `calls_committed` keeps its `(calls_committed, consumer, lease_id)` topics but
  publishes `(calls_used, remaining)` so indexers do not need a second read.
- The TypeScript client uses `@stellar/stellar-sdk` 17.4.0 so protocol-29
  transaction metadata parses correctly; the CLI and proxy remain unpublished
  at version `0.1.0`.

### Fixed

- Leases, services and config kept alive when only read by the proxy's
  `get_lease` simulation.
- Concurrent `acquire` runs preserve every session through a locked, atomic
  `.keylease/sessions.json` writer.
- `--rpc` URLs are validated before a client is built; non-loopback `http:`
  endpoints are rejected.
- Quota commits requeue counts after a failed `use_call` instead of dropping
  them.

### Security

- Escrow invariant: payouts use `price_paid × calls_used / calls_limit` and can
  happen only once per lease.
- Authorisation paths for admin, provider, consumer and gateway are covered by
  contract tests, including negative cases with cleared auth.
- The software is **pre-1.0 and has not been independently audited**. It is for
  development and testnet evaluation only until an audit is announced and the
  [mainnet readiness checklist](./docs/mainnet-readiness.md) is signed off.

## Compatibility policy

- The repository as a whole is pre-1.0 and unaudited; see
  [SECURITY.md](./SECURITY.md). Do not infer stability from a `0.x` version.
- For the contract, SemVer applies to the ABI: **patch** for internal fixes with
  no interface change, **minor** for additive entry points, views, error
  variants or events, and **major** for removed/renamed entry points or changed
  argument/storage layouts. Bump `contracts/keylease-core/Cargo.toml` with every
  contract change; clients should refuse a major version they do not recognise.
- For the TypeScript packages, additive changes keep `0.1.0` until a release is
  cut; breaking changes must be called out in the PR and in `Unreleased`.
- Unreleased entries move to a version heading only when a release is actually
  cut and tagged. Do not invent release dates or tags.
