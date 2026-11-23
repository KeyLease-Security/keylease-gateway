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
pnpm test           # vitest: package suites + the PR-title rules in scripts/
pnpm lint           # eslint
pnpm typecheck      # build + tsc --noEmit
pnpm test:e2e       # scripted end-to-end flow: proxy + simulated soroban network

# prose and identifiers (typos-cli 1.52.2)
typos --config _typos.toml

# contract (needs Rust + stellar-cli)
pnpm contract:test  # cargo test (40 tests)
pnpm contract:build # stellar contract build -> wasm32v1-none
```

> `pnpm typecheck` builds first because `@keylease/proxy` type-checks against
> the CLI's emitted `.d.ts` files.

> The contract needs `stellar-cli` v25.2.0+ (`soroban-sdk` 29 requires it for
> the wasm build) and the `wasm32v1-none` Rust target. CI installs both.

> Stuck on a CLI code, contract trap (`Error(Contract, #n)`) or a proxy 401/403?
> Start with the [troubleshooting guide](./docs/troubleshooting.md). User-facing
> and contract changes need an entry in [CHANGELOG.md](./CHANGELOG.md).

## Your first contribution: good first issues

This is the full path from a fresh clone to a reviewable pull request. Output
blocks carry one of two labels:

- **REAL** — a literal string produced by the current source or CI configuration.
- **UNVERIFIED** — an example value (fork name, branch, counts, timings, URL). Check
  it against your own run; do not paste example output into a PR as evidence.

### 1. Claim a real open issue

Comment on the issue to ask for assignment and wait for a maintainer to confirm.
Three open `good first issue` examples at the time this guide was written (check
the [current issue list](https://github.com/KeyLease-Security/keylease-gateway/issues/labels/good%20first%20issue)
before choosing one):

- [#125 — proxy HTTP reference](https://github.com/KeyLease-Security/keylease-gateway/issues/125)
- [#126 — integration snippets for curl, Node and Go](https://github.com/KeyLease-Security/keylease-gateway/issues/126)
- [#127 — session token format with a worked example](https://github.com/KeyLease-Security/keylease-gateway/issues/127)

### 2. Clone your fork and branch from upstream

Replace `<your-username>` with your GitHub handle. The example below uses the
`docs` issue #125; use the slug of the issue you claimed.

```bash
git clone https://github.com/<your-username>/keylease-gateway.git
cd keylease-gateway
git remote add upstream https://github.com/KeyLease-Security/keylease-gateway.git
git fetch upstream
git checkout -b docs/125-proxy-http-reference upstream/main
```

```text
UNVERIFIED — Cloning into 'keylease-gateway'...
UNVERIFIED — branch 'docs/125-proxy-http-reference' set up to track 'upstream/main'.
```

Keep `origin` pointing at **your fork** and `upstream` at
`KeyLease-Security/keylease-gateway`. Push only to `origin`.

### 3. Install and smoke-test the toolchain

Node `>=20.11.0` and pnpm `12.3.4` come from `package.json`; Rust and the
`wasm32v1-none` target are needed only for contract work.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm build
node packages/cli/dist/index.js --version
```

```text
REAL — keylease 0.1.0
```

```bash
git status --short --branch
```

```text
UNVERIFIED — ## docs/125-proxy-http-reference...origin/docs/125-proxy-http-reference
```

A clean status before you edit is the baseline. If `pnpm install` fails, fix the
toolchain before claiming the issue is blocked.

### 4. Run the focused test, then the full gates

Start with the smallest suite that covers the file you touched, then run the
same checks CI runs (see [CI workflow](./.github/workflows/ci.yml)).

```bash
# Pick the line that matches your area.
pnpm --filter @keylease/cli test -- src/index.test.ts
pnpm --filter @keylease/proxy test -- src/verifier.test.ts
cargo test --manifest-path contracts/keylease-core/Cargo.toml <test_name>

# Then the full gates.
pnpm lint
pnpm typecheck
pnpm test
pnpm contract:test
pnpm contract:build
```

```text
UNVERIFIED — vitest/cargo summary lines: file counts, test counts and elapsed time depend on your change and machine.
```

The exact conventions for what to assert and which fake to inject are in
[Testing conventions](#testing-conventions) below. A change without a
new/updated assertion is not ready for review.

### 5. Commit, push and open the PR

Use a Conventional Commits header. The PR title is what lands on `main` on
squash merge, and CI validates it.

```bash
git add <files-you-changed>
git commit -m "docs: add proxy HTTP reference (#125)"
git push -u origin docs/125-proxy-http-reference
```

Preview and validate the title locally:

```bash
node scripts/pr-title-suggestion.mjs "docs: add proxy HTTP reference"
printf '%s\n' "docs: add proxy HTTP reference" | pnpm commitlint
```

Open a PR from your fork's branch to `KeyLease-Security/keylease-gateway:main`,
fill in [the PR template](./.github/pull_request_template.md), and replace
`Fixes #` with `Fixes #125`. The output URL is **UNVERIFIED** until GitHub
creates it.

### Labels and points

The issue templates encode the effort scheme used by this repository:

| Template | Labels it sets | Effort | Points |
| --- | --- | --- | --- |
| `trivial_issue.md` | `size/trivial`, `points/100` | Single sitting | 100 |
| `medium_issue.md` | `size/medium`, `points/150` | One package | 150 |
| `high_issue.md` | `size/high`, `points/200` | Cross-cutting / security | 200 |

Other labels in use: `documentation`, `enhancement`, `bug`, `security`,
`good first issue`, `help wanted`, `Stellar Wave`, and the area labels
`area/cli`, `area/proxy`, `area/contract`, `area/docs`, `area/ci`. Security and
cross-cutting work belongs in a **high** issue or a private report per
[SECURITY.md](./SECURITY.md). Points describe the template's estimate, not a
payment.

### What a reviewable PR looks like

- [ ] One logical change; no unrelated formatting or generated `dist/` files.
- [ ] PR title follows Conventional Commits; local `commitlint` check passes.
- [ ] The PR template is filled in and `Fixes #<issue>` links the claimed issue.
- [ ] New behaviour has a new/updated assertion; focused test and full `pnpm test`
      were both run.
- [ ] `pnpm lint`, `pnpm build`, `pnpm -r typecheck` and `pnpm test` pass; contract
      changes also pass `pnpm contract:test` and `pnpm contract:build`.
- [ ] `README.md` / `CONTRIBUTING.md` and docs are updated when behaviour or
      config changed; changelog entries are added for shipped changes.
- [ ] No secrets, private keys, session tokens or `.env` files are committed.
- [ ] The diff can be reviewed in one sitting; if it cannot, say why in the PR.

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

## Commit messages and PR titles

Pull requests are squash-merged, so the **PR title** becomes the commit message
on `main`. CI validates it against
[Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>)!: <subject>

feat(proxy): add request validation
```

| Part | Rule |
| --- | --- |
| `type` | Required, lower-case, one of the types below |
| `scope` | Optional, lower-case. `(proxy)`, `(contract)`, `(cli)` and `(ci)` are the areas used today; introduce a new lower-case scope when the change is in a new area — no registration needed |
| `!` | Optional, marks a breaking change |
| `subject` | Required, imperative, no trailing period, whole header ≤ 100 characters |

| Type | Use for |
| --- | --- |
| `feat` | A user-visible feature or capability |
| `fix` | A bug fix, including a security fix |
| `docs` | Documentation only (README, CONTRIBUTING, SECURITY, `docs/`) |
| `ci` | Workflows, tooling and release automation |
| `chore` | Maintenance that changes no behaviour (dependencies, metadata) |
| `test` | Adding or repairing tests only |
| `refactor` | A change that neither fixes a bug nor adds a feature |
| `perf` | A performance improvement |
| `build` | The build, packaging or lockfile setup |
| `revert` | Reverting a previous commit |

Valid titles:

```text
feat(proxy): add request validation
fix(proxy): strip client-supplied x-keylease headers
docs: add proxy operations runbook
ci: validate the pull request title
test(contract): cover every unauthorised entrypoint
chore: bump fastify to 5.6.0
feat(proxy)!: require the gateway key for on-chain quota
```

Titles CI rejects, and what it suggests instead:

```text
Add proxy runbook            ->  docs: add proxy runbook
feature(proxy): add x        ->  feat(proxy): add x
feat(Proxy): add x           ->  feat(proxy): add x
docs: add the runbook.       ->  docs: add the runbook
```

**Breaking changes.** Add `!` after the type/scope (`feat(proxy)!: …`) and
explain the migration in the PR description (and in a `BREAKING CHANGE:` footer
if you are writing the commit yourself). Contract ABI changes also require a
major bump of `contracts/keylease-core/Cargo.toml`, per the README's versioning
policy.

**How the check behaves.** The `PR title · conventional commits` job runs on
pull requests. It skips titles that begin with `Merge ` (GitHub-generated merge
commit titles) and PRs opened by `dependabot[bot]`; every contributor PR,
including from forks, is validated. It never rewrites a title. On failure it
prints a copy-pasteable corrected title in the job log and the run summary.
After editing the title, re-run the failed check from the Actions tab (or push a
commit) — a title edit alone does not re-trigger CI.

**Running it locally.** Preview a corrected title, then validate exactly as CI
does:

```bash
node scripts/pr-title-suggestion.mjs "Add proxy runbook"
printf '%s\n' "feat(proxy): add request validation" | pnpm commitlint
```

The rules live in `commitlint.config.mjs` and `scripts/conventional-commits.mjs`
(tested by `scripts/conventional-commits.test.mjs`).

## Commit and PR hygiene

- One logical change per PR; keep diffs reviewable.
- Write the PR title in Conventional Commits form (above).
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

## CI Matrix and Node.js support

CI tests the full TypeScript test suite across all supported LTS and current Node.js release lines:
- **Node 20** (Active LTS)
- **Node 22** (Active LTS)
- **Node 24** (Current)

All pull requests must pass across the full matrix. Caching for `pnpm` dependencies is segregated per Node version.

## Code review routing (CODEOWNERS)

To protect critical security boundaries, GitHub automatically requests reviews from maintainers (`.github/CODEOWNERS`) when pull requests touch:
- `/contracts/`: Soroban smart contract logic (escrow, settlement, authorization)
- `/.github/workflows/`: CI/CD automation and security check pipelines
- `/SECURITY.md`: Vulnerability disclosure and reporting policies
- `/packages/proxy/src/verifier.ts` and `/packages/proxy/src/quota.ts`: Token verification and quota tracking

## Stale issue and PR lifecycle

To keep the backlog actionable for contributors:
- Issues and PRs with no activity for **60 days** are automatically marked as `stale`.
- If no activity occurs within a **14-day grace period**, stale items are closed.
- Posting a comment or pushing a commit removes the `stale` label and resets the timer.
- Issues labeled `security`, `help wanted`, or `pinned` are exempt from stale management.

## Documentation link verification

Documentation links are checked automatically on pull requests touching markdown files via [Lychee](https://github.com/lycheeverse/lychee):
- Flaky or anti-bot protected domains (such as `stellar.expert` and badge services) are excluded in `.lycheeignore`.
- You can run the link checker locally before submitting docs:
  ```bash
  # Using lychee CLI or docker
  lychee '**/*.md'
  ```
