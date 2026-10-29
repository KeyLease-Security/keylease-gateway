# Rework for the Drips Wave appeal

This document lists every change made after the submission was rejected. The
short version: the project was a TypeScript wrapper around a contract that lived
in a different repository and did nothing but register strings. It is now a
project whose core product logic **is** a Soroban contract in this repo, with
real money flow (SAC escrow), on-chain quota and a live testnet deployment.

---

## 1. Why the earlier version read as not Stellar-native

The old repo:

- had no contract source — `keylease-core` was an external link, so no Soroban
  logic was authored, reviewed or tested here;
- "leases" were a registry write: no payment, no token transfer, no escrow, no
  settlement. The blockchain was used as a database;
- quota was enforced in a proxy's memory (`Map<string, number>`); the on-chain
  counter was never written, so running two proxies doubled the quota;
- read contract state with `getContractData` against a hard-coded storage key,
  which only works if the contract's storage layout never changes;
- had no deployment artifact of its own and could not be run end-to-end.

## 2. New Soroban contract (the core change)

Added `contracts/keylease-core` — a Rust contract built with `soroban-sdk 29`
for `wasm32v1-none`, deployed and verified on testnet.

| File | Change |
| --- | --- |
| `contracts/keylease-core/Cargo.toml` | New crate, `cdylib`/`rlib`, Soroban-optimised release profile |
| `contracts/keylease-core/rust-toolchain.toml` | Pins stable Rust + `wasm32v1-none` |
| `contracts/keylease-core/src/lib.rs` | Contract: `init`, `set_gateway`, `register_service`, `set_service_active`, `quote`, `create_lease`, `use_call`, `revoke`, `settle`, `get_lease`, `get_service`, `get_config`, `remaining_calls` |
| `contracts/keylease-core/src/test.rs` | 14 Rust tests against a real registered SAC instance |

What the contract actually does:

1. **Prepaid escrow.** `create_lease` transfers `calls × price_per_call` of the
   configured SAC token (native XLM on testnet) from the consumer into the
   contract before the lease exists. A lease cannot exist unpaid.
2. **On-chain quota.** `use_call` is gateway-authenticated and increments
   `calls_used` on chain (clamped at `calls_limit`). This is what closes the
   "spin up another proxy for free quota" hole.
3. **Deterministic settlement.** `settle` (permissionless, only after expiry or
   exhaustion) pays the provider `price_paid × calls_used / calls_limit` and
   refunds the rest to the consumer. `revoke` (consumer auth) refunds unused
   calls immediately. Escrow is paid out at most once (`AlreadySettled`).
4. **Typed errors and events.** 14 `Error` variants, 7 event topics
   (`lease_created`, `calls_committed`, `lease_settled`, …).
5. **TTL management.** Persistent lease/service entries are bumped on write
   (`MIN_TTL` 7 days, `EXTEND_TO` 30 days) so leases stay live while payable.
6. **Authorisation.** `require_auth` on admin, provider, consumer and gateway
   paths, with tests for each rejection (impostor provider, wrong consumer).

## 3. TypeScript packages reworked around the contract

### `@keylease/cli`

- `client/soroban.ts` rewritten:
  - reads lease/service state by **simulating** `get_lease` / `get_service` /
    `quote` over Soroban RPC (`simulateTransaction`) instead of reading raw
    contract storage, so the client follows the ABI, not the storage layout;
  - maps contract traps (`Error(Contract, #5)`) to `LeaseNotFoundError` /
    `ContractCallError` with the variant code;
  - new invocations: `useCalls` (gateway), `settle`, `revoke`, `registerService`;
  - `createLease` now returns the contract's `u64` lease id.
- New `commands/lifecycle.ts`: `keylease settle` and `keylease revoke`, which
  release escrow and print the provider payout / consumer refund split.
- `commands/status.ts`: now shows `provider`, `escrow (price_paid)` and
  `settled`, plus the existing call/expiry/active fields.
- `commands/lease.ts` / `index.ts`: new commands wired into argv parsing, help
  and dispatch; `acquire` output states that the calls were prepaid to escrow.
- New `client/soroban.test.ts`: lease struct round-trip, u64 id validation,
  contract-error mapping.
- New `commands/lifecycle.test.ts`: settle/revoke output, JSON mode, secret
  validation.

### `@keylease/proxy`

- New `quota.ts`: `OnChainQuota` batches served calls per lease and commits them
  with `use_call` (batch size / flush interval configurable), requeues counts on
  failure and never blocks the request path.
- `verifier.ts`: optional `quotaSink`; every allowed request is recorded so it
  can be committed on chain. Denied requests are never recorded.
- `index.ts`: new `KEYLEASE_GATEWAY_SECRET`, `KEYLEASE_QUOTA_BATCH`,
  `KEYLEASE_QUOTA_FLUSH_MS`; `startProxy` builds the sink and flushes on close.
- New `quota.test.ts`: batching, auto-flush, error requeue, close-flush.
- New verifier tests assert the sink sees allowed calls and only those.
- `@stellar/stellar-sdk` moved from `devDependencies` to `dependencies`
  (the proxy now signs `use_call` transactions at runtime).

### Toolchain

- `@stellar/stellar-sdk` upgraded `^13.3.0` → `^17.4.0`. v13 cannot parse
  protocol-29 transaction meta (`Bad union switch: 4`), which broke every
  Soroban transaction on today's testnet. Client code updated for the new xdr
  API (`ScVal.type` instead of `switch().name`).
- Root scripts added: `contract:test`, `contract:build`, `deploy:testnet`.

## 4. Deployment (done, not planned)

`packages/cli/scripts/deploy-testnet.mjs` uploads and creates the contract with
plain Soroban operations (no `stellar-cli` needed at deploy time), computes the
contract id from the `HashIdPreimage::ContractId` preimage, funds four fresh
roles via friendbot, then runs `init`, `register_service` and `create_lease`.

Deployed on **Stellar Testnet**:

| Item | Value |
| --- | --- |
| Contract | `CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC` |
| Wasm sha256 | `b8c0874e05e61a49e5ea2ac9961289946f14260cc036fb34930440c0bc1a30bd` (13 836 bytes) |
| Escrow token (native SAC) | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| `uploadContractWasm` | `327114239efac079e49f140014020135829f2c150ad9c9dbf07fdf449613dc47` |
| `createCustomContract` | `1b94fb4522214f11b1548a54b921af9435b4cb9690474d8d4552c1cb669c6f7f` |
| `init` | `f5ed865b9cebd467f5af645148cca3eae73ad3e11869a63a90bfb92bd4a26c08` |
| `register_service(weather-api, 1000)` | `5d934e16163a52122731ae40b315bb08b4430bc8bd12280f6655c9d1229d54ee` |
| `create_lease(25 calls, 1 day)` | `8aea8f39f4d75adfa76416e2e98b03644acddaf4be449cc145f5253ba29d3db3` |

New `deployments.json` records the contract id, wasm hash, escrow token, role
accounts and every transaction hash. Secret seeds from the deploy are written
only to the git-ignored `.keylease/testnet-accounts.json`.

## 5. Live end-to-end verification

Run against the deployed testnet contract, not mocks:

1. `keylease acquire --service weather-api --calls 2` → lease `2`, tx
   `8a31154bc07776a68585f3a1978eee6b8f9aea94653e1df7ad9d5839514302b9`,
   2 000 stroops pulled into contract escrow.
2. `GET /v1/weather?city=paris` through the proxy with the session token →
   `200`, body from the upstream, `x-keylease-lease-id: 2`,
   `x-keylease-calls-remaining: 1`.
3. Same endpoint with a tampered token → `401 invalid_token`.
4. After the proxy's quota flush, `keylease status --lease 2` reads the chain
   and reports `calls: 1/2` — proof the local request became on-chain state.

These results are recorded under `verification` in `deployments.json`.

## 6. Tests and CI

- Contract: **14** Rust tests (`pnpm contract:test`), covering escrow amounts,
  quota clamping, expiry, settlement maths, revocation, authorisation and
  replay of `init`.
- CLI: **58** Vitest tests (was 48) — new lifecycle and client tests.
- Proxy: **52** Vitest tests (was 46) — new quota and sink tests.
- Total: **124** tests across Rust and TypeScript.
- `.github/workflows/ci.yml` gained a `contract` job: installs Rust
  (`wasm32v1-none`) and `stellar-cli` 28.1.0, runs `cargo test`, builds the wasm
  with `stellar contract build` and uploads it as an artifact.

Verified locally exactly as CI runs it:

```
pnpm build      → 0
pnpm -r typecheck → 0
pnpm lint       → 0
pnpm test       → 58 + 52 passed
pnpm contract:test → 14 passed
```

## 7. Documentation

- `README.md` rewritten: on-chain escrow and quota in the architecture diagram
  and sequence diagram, contract entry-point table, escrow/settlement maths,
  contract error table, "why it is shaped this way" now argues from the
  contract instead of from the proxy's cache, new deployments table with real
  contract/tx links, new development commands, updated test counts and repo
  layout.
- `CONTRIBUTING.md`: contract added to layout and testing conventions, new
  contract commands and `stellar-cli` requirement.
- `SECURITY.md`: in-scope list now covers escrow payout bugs and contract
  authorisation; dropped the "report the contract in another repo" carve-out.
- `.gitignore`: Rust `target/` and `*.wasm` artifacts.

## 8. Scope that was deliberately not changed

- The session-token format (`kls1.<payload>.<ed25519 sig>`) is unchanged, so
  existing tokens and clients keep working; the change is what the token is
  backed by on chain.
- The proxy's routing, header hygiene, cache and response codes are unchanged.
- `@keylease/cli` is still unpublished and the proxy is still not hosted; the
  README states both plainly instead of implying otherwise.

## 9. Suggested next steps (not done here)

- Host the reference proxy and publish the CLI so the demo is clickable.
- Add a second priced service and a provider-facing `service register` command.
- Commit quota more aggressively (per-request commits) once a dedicated gateway
  account is funded for fees.

---

Files changed: see `git status` / `git diff`. This file is intentionally
untracked and must not be staged or pushed.
