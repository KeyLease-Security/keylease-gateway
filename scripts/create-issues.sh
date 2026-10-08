#!/usr/bin/env bash
# Creates the planned issue batch for keylease-gateway in one run.
set -u
REPO="KeyLease-Security/keylease-gateway"

create() {
  local title="$1"; shift
  local labels="$1"; shift
  local body="$1"
  if out=$(gh issue create --repo "$REPO" --title "$title" --label "$labels" --body "$body" 2>&1); then
    echo "OK  $out  <- $title"
  else
    echo "ERR $out  <- $title"
  fi
}

create "feat(proxy): add /healthz and /readyz endpoints" "enhancement,size/trivial,points/100,area/proxy" "$(cat <<'EOF'
## Summary

The proxy exposes no liveness/readiness endpoints, so orchestrators and load balancers cannot tell a healthy proxy from one whose Soroban RPC connection is dead.

## Motivation

Deployments (Docker, systemd, k8s) need a cheap health signal. `/healthz` proves the process is up; `/readyz` reports whether the lease verifier can reach Soroban RPC (without spending an RPC call on every probe — use the cache).

## Acceptance criteria

- [ ] `GET /healthz` returns `200` with no token required, and is never forwarded upstream
- [ ] `GET /readyz` returns `200` when the verifier has a cached, reachable state; `503 verification_unavailable` otherwise
- [ ] Health routes are excluded from bearer-token enforcement
- [ ] Unit tests cover both endpoints (healthy + RPC-down cases)
- [ ] README proxy response table documents both endpoints

## Tech stack

TypeScript, Fastify, Vitest
EOF
)"

create "feat(proxy): expose Prometheus metrics" "enhancement,size/medium,points/150,area/proxy" "$(cat <<'EOF'
## Summary

Add an optional `/metrics` endpoint (Prometheus text format) exposing request counts, lease denials by reason, cache hit/miss ratio and upstream latency.

## Motivation

Operators gating a paid API need to see quota consumption and denial reasons without parsing logs. Metrics also make the TTL cache's value measurable.

## Acceptance criteria

- [ ] `KEYLEASE_METRICS_ENABLED` (default `false`) gates the endpoint
- [ ] Counters: requests total, allowed, denied by `error` code, cache hits/misses, upstream latency histogram
- [ ] Metrics endpoint requires no bearer token and is never proxied upstream
- [ ] No new runtime dependency without discussion in this issue
- [ ] Unit tests assert counter increments for allow/deny paths
- [ ] README env table documents the new variable

## Tech stack

TypeScript, Fastify, Vitest
EOF
)"

create "feat(proxy): constant-time and header-hardening security pass" "enhancement,size/high,points/200,area/proxy,security" "$(cat <<'EOF'
## Summary

Audit and harden the proxy's token verification path: constant-time signature/payload comparison, strict header allowlisting, and body-size limits.

## Motivation

The verifier is the security boundary. Timing side channels on signature comparison, hop-by-hop header smuggling, or unbounded request bodies are the exact failure modes this project exists to prevent.

## Acceptance criteria

- [ ] Signature and payload comparisons use `crypto.timingSafeEqual` (or documented equivalent) on equal-length buffers
- [ ] Header forwarding follows an allowlist; `x-keylease-*` headers from clients are stripped before verification
- [ ] Configurable max body size rejects oversized payloads with `413` before lease verification work is done
- [ ] Threat-model tests: tampered signature, mixed-case header injection, oversized body
- [ ] Findings (or absence) documented in `SECURITY.md` scope notes
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` pass

## Tech stack

TypeScript, Node crypto, Fastify, Vitest
EOF
)"

create "feat(proxy): graceful shutdown and connection draining" "enhancement,size/medium,points/150,area/proxy" "$(cat <<'EOF'
## Summary

Handle `SIGTERM`/`SIGINT`: stop accepting new connections, let in-flight proxied requests finish (bounded by a drain timeout), then exit.

## Motivation

Today a deploy restart can cut in-flight requests and lose the in-memory call counter's newest increments. Draining keeps restarts invisible to callers.

## Acceptance criteria

- [ ] `SIGTERM` stops new connections, waits for in-flight requests up to `KEYLEASE_SHUTDOWN_TIMEOUT_MS` (default 10s), then closes
- [ ] Second signal forces immediate exit
- [ ] Startup logs the listen address; shutdown logs the drain outcome
- [ ] Unit test simulates shutdown with an in-flight request
- [ ] README env table documents the timeout

## Tech stack

TypeScript, Fastify, Vitest
EOF
)"

create "test(proxy): deterministic quota-exhaustion race tests" "enhancement,size/medium,points/150,area/proxy" "$(cat <<'EOF'
## Summary

Add tests proving the local call counter cannot be raced past `calls_limit` by concurrent requests, using a controlled fake clock and parallel dispatch.

## Motivation

Quota enforcement is the product's core promise. The check-then-increment path must be safe under concurrent load, and no test currently exercises concurrency.

## Acceptance criteria

- [ ] Test fires N concurrent requests against a lease with `calls_limit = M < N` and asserts exactly M succeed
- [ ] On-chain `calls_used` larger than the local counter still denies (max() rule)
- [ ] No real timers or sleeps — fake clock, deterministic scheduling
- [ ] Test is stable across 20 repeated runs

## Tech stack

TypeScript, Vitest, fake clock injection
EOF
)"

create "feat(cli): add keylease release command for expired leases" "enhancement,size/high,points/200,area/cli" "$(cat <<'EOF'
## Summary

Add `keylease release --lease <id> --secret <key>` that invokes the consumer-side refund path on `keylease-core` for an expired lease, complementing `acquire` / `env` / `status`.

## Motivation

The CLI can create and inspect leases but cannot act on expiry. Without it, consumers must hand-craft the refund invocation in an explorer.

## Acceptance criteria

- [ ] Command invokes the core contract's expired-lease refund entrypoint (`revoke_expired_lease` in `keylease-core`) with `require_auth` from the consumer
- [ ] Clear `CliError` codes for: lease not expired, not found, auth failure
- [ ] `--json` output returns `{ leaseId, refunded, txHash }`
- [ ] Unit tests with the injected fake `SorobanRpc` cover success and each error path
- [ ] README CLI reference table updated

## Tech stack

TypeScript, @stellar/stellar-sdk, Vitest

**Depends on:** `keylease-core` refund entrypoint (already present in the registry contract)
EOF
)"

create "feat(cli): manage stored sessions (list and prune)" "enhancement,size/trivial,points/100,area/cli" "$(cat <<'EOF'
## Summary

`acquire` appends to `.keylease/sessions.json` forever. Add `keylease sessions` to list stored leases and `keylease sessions --prune` to drop expired ones.

## Motivation

Long-lived dev machines and CI workspaces accumulate dead sessions; today the only fix is deleting the file by hand.

## Acceptance criteria

- [ ] `keylease sessions` prints a table (service, lease id, expiry, status) and supports `--json`
- [ ] `keylease sessions --prune` removes entries past `expires_at`, reporting how many were removed
- [ ] Corrupt/missing session file handled with an actionable error, never a stack trace
- [ ] Unit tests cover list, prune and corrupt-file paths
- [ ] README CLI reference updated

## Tech stack

TypeScript, Vitest
EOF
)"

create "ci: add release workflow with tags and artifacts" "enhancement,size/medium,points/150,area/ci" "$(cat <<'EOF'
## Summary

Add a GitHub Actions workflow that on `v*` tags runs lint/build/typecheck/test, publishes nothing but attaches built tarballs, and creates a GitHub release whose body includes the deployed `keylease-core` contract addresses.

## Motivation

Releases are the reviewer-visible evidence of ongoing maintenance. Addresses belong in release notes, not scattered through docs.

## Acceptance criteria

- [ ] `v*` tag triggers the full check suite before release creation
- [ ] Release body auto-includes contract addresses from `deployments.json` (or fails the workflow if missing)
- [ ] Built `packages/*/dist` tarballs attached as release assets
- [ ] Workflow uses pnpm with `--frozen-lockfile`, Node 22
- [ ] Dry-run verified on a pre-release tag `v0.1.0-rc.1`

## Tech stack

GitHub Actions, pnpm, Node 22
EOF
)"

create "test: end-to-end harness against local Soroban network" "enhancement,size/high,points/200,area/ci,area/proxy" "$(cat <<'EOF'
## Summary

Scripted end-to-end test: start a local Soroban network, deploy `keylease-core`, run `keylease acquire`, boot the proxy, and prove an allowed request passes while forged/expired/quota-exhausted requests are denied.

## Motivation

All 94 current tests use injected fakes. Nothing proves the three pieces (contract, CLI, proxy) interoperate against a real network — the exact claim the README makes.

## Acceptance criteria

- [ ] One command (`pnpm test:e2e`) spins up network, deploys contract, runs the full flow
- [ ] Asserts: allowed 200 + `x-keylease-calls-remaining`; forged token 401; expired lease 403; exhausted quota 403
- [ ] Cleans up network state on success and failure
- [ ] Runs in CI as an optional job (allowed to be slower, must be deterministic)
- [ ] Documented in CONTRIBUTING.md

## Tech stack

TypeScript, Vitest, stellar quickstart / soroban CLI, Docker

**Depends on:** `keylease-core` deployable locally (sibling repo)
EOF
)"

create "docs: add demo video and animated quickstart to README" "documentation,size/trivial,points/100,area/cli" "$(cat <<'EOF'
## Summary

Record a ~2-minute end-to-end demo (acquire → env → proxy → curl → denied forged token) and link it from the README top section, plus a quickstart GIF.

## Motivation

A submission without a working demo reads as unfinished. Reviewers should see the product flow before reading architecture.

## Acceptance criteria

- [ ] Video covers: acquire lease, write .env, start proxy, allowed request with `x-keylease-calls-remaining`, rejected forged token
- [ ] README links the video near the top and the GIF next to Quickstart
- [ ] Captions or a pinned comment listing the commands shown
- [ ] No real secrets visible in the recording (testnet keys only)

## Tech stack

OBS/screen recording, testnet
EOF
)"
