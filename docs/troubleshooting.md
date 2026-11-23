# Troubleshooting

This page turns the exact strings emitted by `@keylease/cli`, `@keylease/proxy`
and `keylease-core` into a cause and a fix. Commands use the built CLI from the
repository root (see [README](../README.md#quickstart)); replace the example
contract id, service id and lease id with your own. For operator procedures
(5xx, quota drift, gateway key rotation), see the [runbook](./runbook.md).

## Start here: offline token check vs live lease read

A session token is `kls1.<base64url(payload)>.<base64url(ed25519 signature)>`.
The CLI can check that token **offline**: it verifies the structure, the
consumer's signature, the version and the validity window. It does not contact
Soroban and therefore cannot know whether the lease was revoked, expired,
settled or spent.

```bash
# Offline only: signature + expiry. No RPC, no chain state.
node packages/cli/dist/index.js status --token "$KEYLEASE_SESSION_TOKEN"
```

A **live read** simulates `get_lease` over Soroban RPC. It reports the on-chain
state (service, consumer, calls, expiry, escrow, active/settled) and is what the
proxy uses before admitting a request.

```bash
# Live lease state. Requires network + contract configuration.
node packages/cli/dist/index.js status --lease 2

# Offline token checks plus live active/consumer/quota checks and a JSON result.
node packages/cli/dist/index.js status --token "$KEYLEASE_SESSION_TOKEN" --check-chain --json
```

`status --token --check-chain` prints `Session token chain check` with
`signature`, `expiry`, `lease active`, `consumer match`, `quota` and, when
`--lease` is also supplied, `lease id match` lines. A failed check exits with
code `1`. A chain lookup failure appears as `chain lookup failed: …` in the
check detail rather than as a token error.

## CLI usage and setup errors

`CliError` carries a stable `code` and exits with code `2` unless a command
returns its own status. These are the messages you will actually see.

| String / code | Typical output | Cause | Fix |
| --- | --- | --- | --- |
| `missing_option` | `--calls is required` | Required flag omitted | Re-run with the flag, e.g. `node packages/cli/dist/index.js acquire --service weather-api --calls 25 --duration 3600 --secret "$STELLAR_SECRET"` |
| `missing_option` | `--secret is required unless --dry-run is set` | `acquire` without a signer | Pass `--secret "$STELLAR_SECRET"`, or add `--dry-run` to quote without signing |
| `missing_option` | `status requires either --lease <id> or --token <session-token>` | `status` has no subject | Use `status --lease 2` for a live read or `status --token "$KEYLEASE_SESSION_TOKEN"` for an offline check |
| `missing_option` | `--service is required (or set "defaultService" in .keyleaserc.json)` | No service flag, env var or config default | Pass `--service weather-api`, set `KEYLEASE_SERVICE=weather-api`, or add `"defaultService": "weather-api"` to `.keyleaserc.json` |
| `invalid_option` | `--calls must be a positive integer, got "0"` | Zero, negative or non-numeric call count | Use a positive integer such as `--calls 25` |
| `invalid_option` | `--check-chain requires --token <session-token>` | `--check-chain` without a token | Add `--token "$KEYLEASE_SESSION_TOKEN"` to the `status` command |
| `invalid_option` | `invalid --rpc URL "http://rpc.example.com": http: is only allowed for localhost, not rpc.example.com` | Non-loopback `http:` RPC endpoint | Use an `https:` endpoint, or `http://localhost:8000/soroban/rpc` for a local network |
| `unexpected_argument` | `unexpected argument "extra"` | Positional argument where only flags are accepted | Remove it; `completions` is the only command with a positional shell name |
| `unknown_command` | `unknown command "destroy" (expected acquire, env, status, settle, revoke, sessions or completions)` | Typo or unsupported command | Run `node packages/cli/dist/index.js help` and use a listed command |
| `parse_error` | Message from Node's `parseArgs` (for example, an unknown option) | Malformed argv | Compare against `node packages/cli/dist/index.js help`; remove the unknown option |

## Token errors

`status --token` prefixes token failures with
`token verification failed (<code>): <message>`. The same `TokenVerificationError`
codes drive the proxy's `401 invalid_token` / `401 token_expired` decisions.

| Code | Exact message | Cause | Fix |
| --- | --- | --- | --- |
| `malformed_token` | `token is empty` / `expected three dot-separated segments` | Missing value or not `kls1.<payload>.<signature>` | Reload `KEYLEASE_SESSION_TOKEN` from `keylease env` or re-acquire |
| `unsupported_version` | `unsupported token version 2` | Token format version is not `1` | Mint a new token with the current CLI |
| `invalid_consumer` | `consumer secret is not a valid Stellar secret seed` | `--secret` is not an `S...` Stellar secret seed | Use the correct consumer secret; never paste a public key into `--secret` |
| `invalid_consumer` | `consumer is not a valid Stellar public key` | Payload's `consumer` is not an ed25519 Stellar address | Re-mint the token from a valid keypair |
| `bad_signature` | `session token signature does not verify` | Payload was altered or signed by a different key | Discard the token; mint one with the lease consumer's key |
| `consumer_mismatch` | `token consumer does not match the lease consumer` | Token is scoped to a different account than `--lease` | Use the session from the same consumer, or omit the mismatched `--lease` |
| `lease_mismatch` | `token is not scoped to the requested lease` | `--lease` differs from payload's `lease_id` | Run `keylease env --service weather-api --lease <id>` for that lease |
| `token_expired` | `session token has expired` | `now >= exp` | Acquire a new lease/session; an expired token cannot be renewed |
| `token_not_yet_valid` | `session token is not valid yet` | `iat` is more than 60 seconds ahead of the verifier's clock | Check the machine clock; the proxy maps this to `401 token_expired` |

The `invalid_consumer` **token code** above is different from contract error
**15** (`InvalidConsumer`): the former rejects a bad key/seed in a token, the
latter rejects the contract itself as the `create_lease` consumer.

## Session store errors

The CLI remembers acquired leases in the git-ignored `.keylease/sessions.json`.

| Exact message | Cause | Fix |
| --- | --- | --- |
| `Cannot read session store at .keylease/sessions.json: missing. Run \`keylease acquire\` to create a stored lease.` | No local session file | Run `node packages/cli/dist/index.js acquire --service weather-api --calls 25 --duration 3600 --secret "$STELLAR_SECRET"` |
| `Cannot read session store at .keylease/sessions.json: corrupt. Back up or repair the file, then run this command again.` | Invalid JSON or v2 shape | Back up the file, then re-acquire: `node packages/cli/dist/index.js acquire --service weather-api --calls 25 --duration 3600 --secret "$STELLAR_SECRET"` |
| `Cannot write session store at .keylease/sessions.json: locked. Another keylease process holds .keylease/sessions.json.lock; wait for it to finish, or delete the lock file if no keylease command is running.` | Another `acquire` holds the lock (2 s wait; locks older than 10 s are treated as abandoned once) | Wait for the other process; only remove `.keylease/sessions.json.lock` when no `keylease` command is running |
| `no lease found for service "weather-api"` | No stored lease for that service | Re-run the `acquire` command above |
| `no valid lease found for service "weather-api"` followed by `(all N leases expired)` or `(requested lease X not found or expired)` | Stale session file entries | Run `node packages/cli/dist/index.js sessions --prune --json`, then acquire again or select a live id with `env --lease <id>` |

A stale `.env` is a separate problem: `keylease env` replaces matching keys and
deduplicates them, but a token copied into another shell stays there until you
re-source the file. Re-run
`node packages/cli/dist/index.js env --service weather-api --file .env` and then
`set -a; . ./.env; set +a` to refresh `KEYLEASE_SESSION_TOKEN`.

## Wrong network, contract or unfunded account

| Symptom | Cause | Exact fix |
| --- | --- | --- |
| `unknown KEYLEASE_NETWORK "main" (expected one of: testnet, mainnet, local)` | Unsupported network name | `export KEYLEASE_NETWORK=testnet` (or pass `--network testnet`) |
| `KEYLEASE_CONTRACT_ID is not set: deploy keylease-core and point this variable at its contract id` | Missing contract id | `export KEYLEASE_CONTRACT_ID=CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC` |
| `KEYLEASE_CONTRACT_ID "…" is not a valid contract address` | Wrong value, often a `G...` account address | Use the `C...` contract id from [`deployments.json`](../deployments.json) |
| `Error(Contract, #3)` / `Service was never registered` against the wrong network | Contract id and network disagree | Set both: `export KEYLEASE_NETWORK=testnet KEYLEASE_CONTRACT_ID=CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC` |
| Transaction rejected because the consumer account is unfunded | Fresh testnet key has no XLM for fees | Fund the **public** key with Friendbot: `curl "https://friendbot.stellar.org/?addr=<PUBLIC_KEY>"`, then retry `acquire`. The `pnpm deploy:testnet` script funds its role accounts the same way |
| `create_lease` fails with insufficient token balance | Funded for fees but no escrow token balance | Use the funded testnet SAC from [Deployments](../README.md#deployments) and retry `acquire`; `acquire --dry-run` quotes the price without spending it |

Never put a secret seed in `KEYLEASE_CONTRACT_ID`, a URL or a committed file.
The deploy script writes role seeds only to the git-ignored
`.keylease/testnet-accounts.json`.

## Contract errors: `Error(Contract, #n)`

A typed contract trap is rendered by the CLI as:

```text
keylease-core.<method> failed with Error(Contract, #n): <summary>
Next step: <next step>
```

The table below is cross-checked against
[`contracts/keylease-core/src/lib.rs`](../contracts/keylease-core/src/lib.rs).
"Raised by" lists the entry points that can produce the variant; host-level
signature failures on `require_auth` are **not** `Error(Contract, #14)`.

| Code | Variant | Raised by | Meaning / next action |
| --- | --- | --- | --- |
| 1 | `AlreadyInitialized` | `init` | Setup already happened; do not call `init` again |
| 2 | `NotInitialized` | `set_gateway`, `propose_admin`, `accept_admin`, `register_service`, `create_lease`, `extend_lease`, `use_call`, `revoke`, `settle`, `get_config` (any path that loads config) | Contract was deployed but not initialized; contact the operator. Views that only load a service or lease do not raise this code |
| 3 | `UnknownService` | `quote`, `create_lease`, `extend_lease`, `get_service`, `set_service_active` | `Service was never registered`. Check `--service`; ask the provider to call `register_service(provider, service, price_per_call)` on the configured contract |
| 4 | `ServiceInactive` | `create_lease` | Provider paused the service; ask them to call `set_service_active(..., true)` |
| 5 | `LeaseNotFound` | `use_call`, `extend_lease`, `revoke`, `settle`, `get_lease`, `load_lease` paths | Check `--lease` and the network/contract triple; the proxy returns `403 lease_not_found` |
| 6 | `LeaseInactive` | `use_call`, `extend_lease` | Lease was revoked or settled; acquire a new lease |
| 7 | `LeaseExpired` | `use_call`, `extend_lease` | `expires_at` has passed; settle the old lease and acquire a new one. An expired lease cannot be extended |
| 8 | `LeaseNotSettleable` | `settle` | Settlement is only allowed after expiry or quota exhaustion; wait or exhaust the calls |
| 9 | `AlreadySettled` | `revoke`, `settle`, `extend_lease` | Escrow was already paid out; payouts cannot repeat and a settled lease cannot be extended |
| 10 | `InvalidCalls` | `quote`, `create_lease`, `extend_lease`, `use_call` | Call count must be positive; use `--calls 25` or a positive `count`. For `extend_lease` this also means both `extra_calls` and `extra_duration` were zero, or `calls_limit` would overflow |
| 11 | `InvalidDuration` | `create_lease`, `extend_lease` | Duration must be positive seconds; use `--duration 3600`. For `extend_lease` this also means `expires_at` would overflow |
| 12 | `InvalidPrice` | `register_service` | `price_per_call` must be positive; provider must fix the registration |
| 13 | `InvalidAmount` | `quote`, `create_lease`, `extend_lease` | `price_per_call × calls` overflowed or produced an invalid amount; reduce the call count. For `extend_lease` this is the `extra_calls × price_per_call` top-up |
| 14 | `Unauthorized` | `accept_admin` (no pending proposal), `set_service_active` (provider mismatch) | Use the correct account/role; a missing signature is a host auth error, not this code |
| 15 | `InvalidConsumer` | `create_lease` | Consumer cannot be the contract's own address; pass a real Stellar account as `consumer` |

The CLI's `mapContractError` currently maps codes 1–14; code 15 comes from the
contract source and will be shown by the CLI as an unknown contract error until
the mapper is extended. Codes 10–13 in the README are expanded above because
each has a different entry point and fix.

### Extending an existing lease

`extend_lease(lease_id, extra_calls, extra_duration)` is a consumer-authorised
contract entry point. It extends only an active, unexpired, unsettled lease, and
at least one of the two amounts must be nonzero: pass `0` for `extra_calls` to
buy time only, or `0` for `extra_duration` to buy calls only. The top-up is
priced with the same `extra_calls × price_per_call` formula as `create_lease`,
added to `price_paid` and escrow, and reported in a `lease_extended` event with
topics `(lease_extended, consumer, lease_id)`.

There is no CLI `extend` subcommand yet, so invoke the contract entry point
directly with the lease consumer's signature. After extending, re-run
`node packages/cli/dist/index.js status --lease <id>` to see the new
`calls_limit`, `expires_at` and remaining quota. An offline `status --token`
check still describes the old token; the token payload does not carry lease
limits and must not be read as proof of the extension.

## Proxy 401 and 403 decisions

The proxy writes JSON bodies `{ "error": "<reason>", "message": "<detail>" }`
and an `x-request-id` header. These are the exact `FailureReason` values from
[`packages/proxy/src/verifier.ts`](../packages/proxy/src/verifier.ts).

| Status | `error` | Cause | Fix |
| --- | --- | --- | --- |
| 401 | `missing_token` | No `Authorization` header | Add `-H "Authorization: Bearer $KEYLEASE_SESSION_TOKEN"` to the `curl` call |
| 401 | `invalid_token` | Header is not `Bearer <token>`, or token parsing/signature failed | Re-export the current token: `node packages/cli/dist/index.js env --service weather-api --file .env`, then re-source it |
| 401 | `token_expired` | `token_expired` or `token_not_yet_valid` | Check the clock; mint a new session with a fresh lease |
| 403 | `lease_not_found` | `lease X was not found on chain` | Verify with `node packages/cli/dist/index.js status --lease X`; check `KEYLEASE_NETWORK` / `KEYLEASE_CONTRACT_ID`, then re-acquire |
| 403 | `lease_inactive` | `lease has been revoked` | Acquire a new lease; a revoked lease never becomes active again |
| 403 | `lease_expired` | `lease has expired` | Run `node packages/cli/dist/index.js settle --lease X --secret "$STELLAR_SECRET"`, then acquire a new lease |
| 403 | `consumer_mismatch` | `token consumer does not own this lease` | Use the token and secret from the lease's consumer; re-run `env --service weather-api --lease X` |
| 403 | `quota_exhausted` | `lease quota exhausted (N calls spent)` | Acquire another lease; the local counter and `calls_used` on chain both refuse further calls |
| 503 | `verification_unavailable` | Soroban RPC unreachable or `/readyz` has no cached state | Check `KEYLEASE_RPC_URL`; response includes `Retry-After`. The proxy fails closed |

A successful proxied response carries `x-keylease-lease-id` and
`x-keylease-calls-remaining`. Client-supplied `x-keylease-*` headers are always
stripped and rebuilt by the proxy, so they cannot spoof quota.
