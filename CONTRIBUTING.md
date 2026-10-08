# Contributing to keylease-gateway

Thanks for helping grow KeyLease. This repository is a PNPM + TypeScript
workspace with two packages:

| Package            | Description                                                    |
| ------------------ | -------------------------------------------------------------- |
| `@keylease/cli`    | Developer CLI: acquires Soroban leases, mints session tokens     |
| `@keylease/proxy`  | Edge reverse proxy: verifies leases, gates the upstream API      |

## Getting started

```bash
pnpm install        # Node >= 20.11, pnpm 12 (see "packageManager")
pnpm build          # tsc emit for both packages
pnpm test           # vitest (94 tests)
pnpm lint           # eslint
pnpm typecheck      # build + tsc --noEmit
```

> `pnpm typecheck` builds first because `@keylease/proxy` type-checks against
> the CLI's emitted `.d.ts` files.

## Project layout

```
packages/cli/src
  index.ts                 argv parsing + dispatch (pure, unit tested)
  token.ts                 ed25519 session bearer token codec
  commands/lease.ts        `acquire` + `env` commands and session store
  commands/status.ts       `status` command (on-chain or offline token check)
  client/soroban.ts        keylease-core contract client (create_lease / read)
packages/proxy/src
  index.ts                 env config + server bootstrap
  server.ts                Fastify reverse proxy (routing, header hygiene)
  verifier.ts              token + on-chain verification, local call counter
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

- `packages/cli`: CLI parameter parsing, token mint/verify round-trips,
  command behaviour with injected stores/clients.
- `packages/proxy`: TTL cache semantics, verifier decisions (401/403/503 and
  cache hit ratios), proxy routing (headers, bodies, status codes).
- Keep tests deterministic: inject a fake `clock` instead of sleeping.
