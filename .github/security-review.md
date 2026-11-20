# Security review checklist

Use this for every pull request that touches authentication or authorization,
the contract, quota or escrow accounting, proxy headers, secrets, dependencies
or release tooling. Copy the relevant items into the PR description and tick
them off; leave an item out only with a one-line reason. Nothing here replaces
the reporting process in [SECURITY.md](../SECURITY.md) for an actual
vulnerability.

## Authentication and authorization

- [ ] Every new entry point or route states who may call it, and the check is
      enforced on chain or in the proxy, not only in the CLI.
- [ ] Admin-only actions (`set_gateway`, `propose_admin`/`accept_admin`,
      `set_paused`, `register_service`) call `require_auth` on the stored role,
      not on a caller-supplied address.
- [ ] Consumer actions (`create_lease`, `revoke`) authenticate the consumer that
      owns the tokens or escrow.
- [ ] Negative tests exist for the unauthorised path (clear mocked auths and
      assert the host rejects the invocation).
- [ ] Permissionless paths (`settle`, views) still work without a signature and
      cannot be abused to move funds to an attacker-controlled address.

## Token binding and validation

- [ ] The session token still binds `(version, lease_id, consumer, iat, exp)`
      and is verified against the consumer's ed25519 key before any RPC call.
- [ ] Expired, not-yet-valid, malformed and forged tokens are rejected with the
      documented 401 codes and covered by tests.
- [ ] The token's consumer is compared with the on-chain lease consumer
      (`consumer_mismatch`), so a token cannot be replayed against another lease.
- [ ] Changing the token payload or format bumps the version and keeps old
      tokens failing closed.

## Quota accounting and enforcement

- [ ] Quota is enforced on chain (`use_call`) and locally, and a stale or
      missing cache cannot mint free calls.
- [ ] `use_call` still clamps at `calls_limit` and rejects settled, revoked or
      expired leases.
- [ ] The local counter cannot be reset or bypassed by a request that later
      fails; consumed calls stay consumed.
- [ ] Batched commits requeue on transport failure without double-counting, and
      are bounded by the documented pending-lease cap.

## Escrow and settlement invariants

- [ ] `price_paid` is debited exactly once per lease and never exceeds
      `calls × price_per_call`.
- [ ] `settle` pays `price_paid × calls_used / calls_limit` and refunds the
      remainder; the two transfers never exceed `price_paid`.
- [ ] `revoke` refunds unused calls to the consumer and stops further
      `use_call`.
- [ ] A lease cannot be settled twice, settled while active and unexpired, or
      settled after being revoked.
- [ ] Arithmetic uses checked or saturating operations where overflow is
      possible, and validation errors are typed.
- [ ] The emergency pause never moves escrow and leaves `use_call`, `revoke`
      and `settle` working for existing leases.

## Proxy headers and trust boundaries

- [ ] `x-keylease-*` headers are stripped from inbound requests and set only by
      the proxy after verification.
- [ ] `x-forwarded-*` is rebuilt from the socket unless `KEYLEASE_TRUST_PROXY`
      explicitly trusts the peer, and only the configured hops/CIDRs are used.
- [ ] `x-request-id` is validated before reuse and is safe to log and forward.
- [ ] Upgrade/WebSocket requests are rejected before a call is consumed.
- [ ] Body, header and in-flight limits are enforced before quota is charged.

## SSRF prevention

- [ ] The upstream target comes from operator configuration
      (`KEYLEASE_UPSTREAM_URL`), never from the request path, query or headers.
- [ ] Path joining cannot escape the configured upstream base (no scheme, host
      or `..` override).
- [ ] Redirects and proxy-style absolute URLs from clients are not followed or
      forwarded.
- [ ] Error responses do not echo internal upstream URLs or credentials.

## Secret handling and exposure

- [ ] No secret seed, gateway key or session token is printed, logged, stored
      in the session file or included in an error message.
- [ ] New configuration uses environment variables; no credentials are added to
      tracked files, fixtures or docs.
- [ ] CLI `--secret` handling does not echo the value, including on failure.
- [ ] Denial logs contain identifiers and reasons, not bearer tokens.

## CI and dependency security

- [ ] Workflows use least-privilege `permissions` and do not run untrusted PR
      code with write tokens or repository secrets.
- [ ] Third-party actions are pinned to maintained versions (or an immutable
      commit SHA where the repository does that elsewhere).
- [ ] New dependencies are necessary, maintained and reflected in the lockfile;
      no lifecycle script is enabled without review.
- [ ] Release changes keep build, attestation and publication in that order, so
      provenance is never claimed for an artifact that was not built and
      attested.

## Rollback plans for contract changes

- [ ] The change states how to stop it if it ships broken (pause new leases,
      rotate the gateway, stop the proxy) and who holds that key.
- [ ] Outstanding leases remain redeemable: pause does not block `use_call`,
      `revoke` or `settle`.
- [ ] Storage layout changes (`Config`, `DataKey`, stored structs) state whether
      a live deployment needs a fresh deploy or a migration, and the version is
      bumped accordingly.
- [ ] Event and ABI changes are additive or the contract version bump reflects
      the break.
- [ ] A testnet redeploy and smoke test are planned or completed before the
      change is announced as released.
