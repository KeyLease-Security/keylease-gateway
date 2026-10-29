# Contributing to keylease-gateway

Thanks for helping grow KeyLease. This repository is a PNPM + TypeScript
workspace plus the Soroban contract the whole system runs on:

| Component              | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `contracts/keylease-core` | Soroban contract: services, prepaid leases, escrow, on-chain quota |
| `@keylease/cli`        | Developer CLI: prepays leases, mints session tokens, settles        |
| `@keylease/proxy`      | Edge reverse proxy: verifies leases, commits quota, gates the API   |

## Getting started

```bash
pnpm install        # Node >= 20.11, pnpm 12 (see "packageManager")
pnpm build          # tsc emit for both packages
pnpm test           # vitest (108 tests)
pnpm lint           # eslint
pnpm typecheck      # build + tsc --noEmit

# contract (needs Rust + stellar-cli)
pnpm contract:test  # cargo test (14 tests)
pnpm contract:build # stellar contract build -> wasm32v1-none
```

> `pnpm typecheck` builds first because `@keylease/proxy` type-checks against
> the CLI's emitted `.d.ts` files.

> The contract needs `stellar-cli` v25.2.0+ (`soroban-sdk` 29 requires it for
> the wasm build) and the `wasm32v1-none` Rust target. CI installs both.

## Project layout

```
contracts/keylease-core/src
  lib.rs                   Soroban contract: init, services, leases, escrow,
                           use_call, settle, revoke, views
  test.rs                  contract tests (SAC mock, auth, settlement maths)
packages/cli/src
  index.ts                 argv parsing + dispatch (pure, unit tested)
  token.ts                 ed25519 session bearer token codec
  commands/lease.ts        `acquire` + `env` commands and session store
  commands/status.ts       `status` command (on-chain or offline token check)
  commands/lifecycle.ts    `settle` + `revoke` commands
  client/soroban.ts        keylease-core client (simulated reads + invocations)
packages/cli/scripts
  deploy-testnet.mjs       upload + create + init + register + demo lease
packages/proxy/src
  index.ts                 env config + server bootstrap + quota sink wiring
  server.ts                Fastify reverse proxy (routing, header hygiene)
  verifier.ts              token + on-chain verification, local call counter
  quota.ts                 batched on-chain `use_call` commits
  cache.ts                 generic in-memory TTL/LRU cache
```

## Coding conventions

- **TypeScript strict mode** — no `any`, no `@ts-ignore`; widen types
  deliberately instead.
- **Prefer editing existing files**; new modules need a justification in the PR.
- **Tests are part of the change.** Every bug fix gets a regression test and
  every new branch gets an assertion. Vitest only; no network access in tests —
  inject fakes (`SorobanRpc`, `LeaseStateProvider`, `fetchImpl`, `clock`).
- **Errors carry codes.** CLI errors are `CliError` with `code`/`exitCode`,
  token errors are `TokenVerificationError` with `code`, proxy denials return a
  JSON body `{ error, message }`.
- **Imports**: ESM with explicit `.js` extensions, `import type` for
  type-only imports (enforced by eslint).

## Commit and PR hygiene

- One logical change per PR; keep diffs reviewable.
- Fill in the pull request template; link the issue you are claiming
  (`Fixes #123`).
- CI must be green: `pnpm lint` → `pnpm build` → `tsc --noEmit` → `pnpm test`.
- Never commit secrets: `.env`, Stellar secret seeds or session tokens are
  git-ignored for a reason.

## Reporting issues

Pick the matching issue template:

| Template                 | Effort                       | Points  |
| ------------------------ | ---------------------------- | ------- |
| `trivial_issue.md`       | Single sitting               | 100 pts |
| `medium_issue.md`        | One package                  | 150 pts |
| `high_issue.md`          | Cross-cutting / security     | 200 pts |

Security-sensitive reports (token forgery, quota bypass, RPC spoofing) belong
in a **high** issue — or, better, in a private report per
[SECURITY.md](./SECURITY.md): describe the threat model, the reproduction and
the expected failure mode.

## Testing conventions

- `contracts/keylease-core`: Rust tests against a real SAC instance
  (`register_stellar_asset_contract_v2`), covering escrow, quota, settlement
  and authorisation. No mocks for the token contract.
- `packages/cli`: CLI parameter parsing, token mint/verify round-trips,
  command behaviour with injected stores/clients, lease struct parsing.
- `packages/proxy`: TTL cache semantics, verifier decisions (401/403/503 and
  cache hit ratios), quota batch/requeue behaviour, proxy routing (headers,
  bodies, status codes).
- Keep tests deterministic: inject a fake `clock`, a fake `SorobanRpc` and a
  fake committer instead of sleeping or hitting the network.
