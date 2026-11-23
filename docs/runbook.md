# Proxy operations runbook

Operational guide for `@keylease/proxy` (`packages/proxy`), the edge service that
verifies KeyLease session tokens against `keylease-core` and commits served
calls with `use_call`. It is written for the person on call at 02:00. Every
statement about behaviour comes from the code in `packages/proxy/src` and
`contracts/keylease-core/src/lib.rs`; the read-only commands below were run
against the deployed testnet contract and the proxy/CLI commands against a local
build. The write commands (`use_call`, `set_gateway`) were only simulated, so
each is paired with the read that proves whether it landed.

**What the proxy owns.** Three pieces of state, all in memory:

| State | Where | Survives a restart? |
| --- | --- | --- |
| Per-lease local call counter | `LeaseVerifier.calls` | No — starts empty |
| Lease-state TTL cache | `LeaseVerifier.cache` (default `KEYLEASE_CACHE_TTL_MS` = 30 s) | No |
| Pending `use_call` commits | `OnChainQuota.pending` | No |

The chain is the only durable accounting. Nothing on disk needs backing up,
but an unclean stop loses whatever the batch had not committed yet — see
[§3](#3-quota-drift-and-crash-recovery) and [§5](#5-restarting-without-losing-calls).

## Conventions used below

```bash
export KEYLEASE_NETWORK=testnet
export KEYLEASE_CONTRACT_ID=CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC
export KEYLEASE_RPC_URL=https://soroban-testnet.stellar.org
# Operator shell variable, not an application setting: stellar-cli always needs a
# transaction source, even with --send=no. Use the public key of any funded
# account on the same network; it is never used to sign a read.
export READ_ONLY_SOURCE=GAVJ74TDCV5EUG3TQEBUBQLIFPY7WUM6TRVJMH5VMEB5CCYZTHDHSXGE
```

`stellar` is [stellar-cli](https://github.com/stellar/stellar-cli) ≥ 25.2 (the
version this repository requires to build the contract; CI installs 28.1.0).
`keylease` means `node packages/cli/dist/index.js` after `pnpm build`.

---

## 1. Startup checklist

Work top to bottom. Each step states what to inspect, the command, the
successful result, and what to do when it fails.

### 1.1 Configuration is present and valid

```bash
# Names only — never print values.
env | grep -E '^(KEYLEASE_|PORT=|HOST=)' | sed 's/=.*$/=<set>/'
```

Required: `KEYLEASE_UPSTREAM_URL`, `KEYLEASE_CONTRACT_ID`.
Production also requires `KEYLEASE_GATEWAY_SECRET` (see 1.3).
Everything else is optional and documented in
[the README configuration table](../README.md#proxy-configuration).

The proxy validates its configuration at boot only. A valid start logs two
secret-free lines (`describeConfig` reduces the seed to a boolean and strips
credentials/query/fragment from the upstream URL):

```json
{"msg":"configuration","config":{"upstream":"https://api.example.com/","host":"0.0.0.0","port":8080,"cacheTtlMs":30000,"forwardAuthorization":false,"trustProxy":false,"metricsEnabled":false,"shutdownTimeoutMs":10000,"onChainQuotaCommits":true,"quotaBatch":50,"quotaFlushMs":10000,"maxBodyBytes":33554432,"maxInFlight":1024}}
{"msg":"listening on http://0.0.0.0:8080"}
```

Success: `onChainQuotaCommits: true`, the upstream host is the one you expect,
the port is the one your load balancer targets.

Failure: the process exits 1 with
`keylease-proxy: <message>` on stderr. The messages are literal:

| Message | Fix |
| --- | --- |
| `KEYLEASE_UPSTREAM_URL is required (protected API base URL)` | set it |
| `KEYLEASE_UPSTREAM_URL "<x>" is not a valid URL` | include the scheme, e.g. `https://api.example.com` |
| `KEYLEASE_GATEWAY_SECRET is not a valid Stellar secret seed (starts with "S")` | wrong/truncated seed; re-inject from the secret store |
| `KEYLEASE_TRUST_PROXY "<x>" must be "true", "false", a hop count or a comma-separated IP/CIDR list` | fix the edge-proxy setting |
| `KEYLEASE_MAX_BODY_BYTES "<x>" exceeds maximum allowed limit of 1 GiB` | lower it |
| `KEYLEASE_MAX_INFLIGHT "<x>" must be a non-negative integer (0 disables the cap)` | fix the value |
| `unknown KEYLEASE_NETWORK "<x>" (expected one of: testnet, mainnet, local)` | fix the network name |
| `KEYLEASE_CONTRACT_ID is not set: deploy keylease-core and point this variable at its contract id` | set it |
| `KEYLEASE_CONTRACT_ID "<x>" is not a valid contract address` | contract ids start with `C` |

Unknown `KEYLEASE_*` names are ignored, not rejected: a typo'd optional
variable silently falls back to its default. Compare the startup summary with
the values you intended — that is the only validation you get.

### 1.2 Network, contract and ABI version

```bash
stellar contract invoke \
  --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" --send=no \
  --source-account "$READ_ONLY_SOURCE" -- version
stellar contract invoke \
  --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" --send=no \
  --source-account "$READ_ONLY_SOURCE" -- get_config
```

Success: a quoted semver from `version()` (it equals
`contracts/keylease-core/Cargo.toml`), and a config object:

```json
{"admin":"GAVJ…","gateway":"GB3I…","lease_count":2,"token":"CDLZ…"}
```

Check that `token` is the escrow asset you expect (the native SAC on the testnet
deployment) and that `lease_count` is plausible for the deployment you are
starting against.

Failure: `Error(Contract, #2)` (`NotInitialized`) means the address is a
contract that never ran `init`. A transport or "missing contract" error means
the id/network/RPC triple is wrong — fix 1.1 before continuing. A `version()`
whose major differs from what this proxy was built and tested against: stop,
per the ABI compatibility policy in the README.

### 1.3 Gateway key availability and validity

Without `KEYLEASE_GATEWAY_SECRET` the proxy still starts, logs
`onChainQuotaCommits: false`, and enforces quota only in its own process. In
that mode `calls_used` on chain does not move until settlement, a restart
forgets every local counter, and every proxy instance starts from the same
on-chain number. **Do not run production traffic this way.** The gateway key is
what makes on-chain quota authoritative.

Derive the public key of the configured seed and compare it with
`get_config.gateway`:

```bash
cd packages/proxy
node --input-type=module -e "import { Keypair } from '@stellar/stellar-sdk'; process.stdout.write(Keypair.fromSecret(process.env.KEYLEASE_GATEWAY_SECRET).publicKey() + '\n')"
```

Success: the printed address equals `gateway` from 1.2, and the gateway account
holds XLM to pay `use_call` fees:

```bash
# $KEYLEASE_ESCROW_TOKEN is the `token` field from get_config.
stellar contract invoke \
  --id "$KEYLEASE_ESCROW_TOKEN" --network "$KEYLEASE_NETWORK" --send=no \
  --source-account "$READ_ONLY_SOURCE" -- balance --id "$KEYLEASE_GATEWAY_PUBLIC_KEY"
```

The native SAC balance is in stroops (7 decimals). A drained gateway account
cannot submit `use_call`, so commits fail and counts stay pending.

Failure: a mismatch means the proxy holds a key the contract does not accept;
every commit then fails with `Error(Contract, #14)` (`Unauthorized`) and is
logged as `on-chain quota commit failed; calls requeued`. Either start with the
registered key or rotate deliberately ([§4](#4-gateway-key-rotation)) — do not
"fix" it by editing the contract ad hoc during an incident.

Export the printed address for the commands in §1.3 and §4:
`export KEYLEASE_GATEWAY_PUBLIC_KEY=<printed address>`.

Handle the seed as a secret: inject it from the secret manager, never paste it
into a shell command line (it would show up in process listings and history).
`scripts/demo/quickstart.sh` shows the prompt-and-hide pattern used in this
repository.

### 1.4 RPC reachability

```bash
curl -sS -X POST "$KEYLEASE_RPC_URL" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
```

Success:

```json
{"jsonrpc":"2.0","id":1,"result":{"status":"healthy","latestLedger":5817004,…,"ledgerRetentionWindow":120960}}
```

Call it twice and check that `latestLedger` advances: `status: healthy` alone
only says the node is up, not that it is following the chain.

Failure: timeouts/DNS/TLS are network problems; HTTP 429 or 5xx from the
provider is RPC degradation. The proxy fails **closed**: a lease read that
cannot be completed becomes `503 verification_unavailable` (never an allow).
With a warm cache, leases already cached keep being served for up to
`KEYLEASE_CACHE_TTL_MS`; new leases fail immediately.

### 1.5 Contract state you expect to serve

```bash
stellar contract invoke --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" \
  --send=no --source-account "$READ_ONLY_SOURCE" -- get_service --service weather-api
stellar contract invoke --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" \
  --send=no --source-account "$READ_ONLY_SOURCE" -- remaining_calls --lease_id 1
keylease status --lease 1 --network "$KEYLEASE_NETWORK" --contract "$KEYLEASE_CONTRACT_ID"
```

Success: the service is `active: true` with the price you expect, and the
leases your traffic uses show `callsUsed < callsLimit`, `active: true`, and an
expiry in the future. `keylease status --json` gives the same fields
(`callsLimit`, `callsUsed`, `expiresAt`, `active`, `settled`, `pricePaid`).

Two things operators get wrong here:

* **The proxy does not check the service's `active` flag.** Pausing a service
  stops *new* leases (`create_lease` → `Error(Contract, #4)`), but existing
  leases keep being admitted until they expire or are revoked.
* **Expiry is a timestamp, not a flag.** An expired lease still reads
  `active: true, settled: false`; `expiresAt` is what denies it.

### 1.6 Start the proxy and verify health

```bash
pnpm build                       # once, from the repo root
node packages/proxy/dist/index.js   # or: pnpm --filter @keylease/proxy start
curl -sS -i http://127.0.0.1:8080/healthz
curl -sS -i http://127.0.0.1:8080/readyz
```

* `/healthz` → `200 {"status":"ok"}`. Liveness only: it does not touch RPC.
* `/readyz` → `200 {"status":"ok"}` only when the verifier holds at least one
  cached lease state **and** its last RPC read did not fail. A freshly started
  proxy with no traffic answers `503` with
  `{"error":"verification_unavailable","message":"verifier has no cached, reachable state"}`
  and `Retry-After: 30` even when RPC is perfectly healthy — this is expected.

Practical consequence: readiness is "has served a verifiable request", not
"can reach Soroban". Alert on the `/readyz` 5xx ratio rather than on a single
probe, or warm the instance with one real request before adding it to the load
balancer.

Failure: connection refused means the process is not listening (go back to
1.1 and read stderr). `healthz` 200 with `readyz` 503 after real traffic means
the RPC path: run 1.4 and `keylease status` for the lease you tested with.

### 1.7 Quota and accounting readiness

Before announcing the instance:

1. Record the baseline `callsUsed` for every lease you expect to serve
   (`keylease status --json`). This is your only before-picture.
2. Confirm `onChainQuotaCommits: true` (1.3).
3. Confirm the batch window is what you intend: `KEYLEASE_QUOTA_BATCH` (default
   50 calls across all leases) and `KEYLEASE_QUOTA_FLUSH_MS` (default 10 s).
   The pending map is bounded at 10 000 distinct leases (not configurable).
4. Send **one** authorized call and prove it reaches the chain: re-read the
   lease after at most `KEYLEASE_QUOTA_FLUSH_MS` and see `callsUsed` increase
   by 1. Do this once per new instance during a rollout.

Failure: `callsUsed` does not move → commits are failing (§2, 503/`#14`) or the
lease you tested is expired (`use_call` → `Error(Contract, #7)`), in which case
the count is unrecoverable by design ([§3.8](#38-what-cannot-be-reconciled)).

### 1.8 Monitoring and logging

* `KEYLEASE_METRICS_ENABLED=true` exposes Prometheus text on `/metrics`:
  `keylease_requests_total`, `keylease_requests_allowed_total`,
  `keylease_requests_denied_total{error="…"}`, `keylease_cache_hits_total`,
  `keylease_cache_misses_total`, and `keylease_upstream_latency_seconds_*`.
* Logs are pino JSON on stdout. Alert on these `msg` values:
  `request denied by lease verifier` (carries `reason`; a spike in
  `verification_unavailable` is an RPC incident), `upstream request failed`,
  `on-chain quota commit failed; calls requeued`, and
  `on-chain quota lease limit reached; flushing pending calls early`.
* Each response carries `x-request-id`; a valid inbound value is reused,
  anything else is replaced by a UUID. It is also forwarded upstream and
  appears on the `access` log line.
* Gaps to plan around: there is **no metric or log line for pending/uncommitted
  quota**, no success log per commit, and the `access` line records the method,
  path, status, byte counts and duration but **not** the lease id. Per-lease
  evidence has to come from the client (`x-keylease-calls-remaining`) or the
  upstream's own request log.

---

## 2. HTTP 5xx diagnostics

The proxy produces the following 5xx bodies of its own, forwards upstream 5xx
statuses unchanged, and can return Fastify's default error shape for an
unexpected internal error.

| Status | Body | Produced by | Quota charged? | Retryable as-is? |
| --- | --- | --- | --- | --- |
| `503` | `{"error":"verification_unavailable",…}` | lease verification (RPC read failed) | No | Yes, after `Retry-After` |
| `503` | `{"error":"verification_unavailable",…}` on `/readyz` | readiness probe only | n/a | Yes |
| `503` | `{"error":"overloaded",…}` | in-flight cap (`KEYLEASE_MAX_INFLIGHT`) | No | Yes, after `Retry-After: 1` |
| `502` | `{"error":"bad_gateway",…}` | upstream fetch threw | **Yes** | Retrying costs another call |
| `504` | `{"error":"gateway_timeout",…}` | upstream request timeout | **Yes** | Retrying costs another call |
| any 5xx | upstream's own body | upstream response forwarded verbatim | **Yes** | Upstream decides |
| `500` | Fastify default `{statusCode,error,message}` | unexpected exception | Possibly (if after verification) | No — investigate |

### 503 `verification_unavailable` (proxied request)

**Meaning.** The bearer token parsed and was not obviously invalid, but the
lease state could not be read over Soroban RPC. The verifier fails closed.

**Failure path.** `LeaseVerifier.resolveLease` → `SorobanClient.getLeaseState`
→ simulation error that is not `Error(Contract, #5)`, or a transport failure.
The denial cache only remembers *missing* leases (≤ 5 s), so transient errors
keep reaching RPC.

**First command.**

```bash
keylease status --lease <lease-id> --network "$KEYLEASE_NETWORK" --contract "$KEYLEASE_CONTRACT_ID"
```

**Evidence.** The proxy logs `request denied by lease verifier` with
`reason: "verification_unavailable"` and the request id; the response carries
`Retry-After` = `ceil(min(KEYLEASE_CACHE_TTL_MS, 30 s) / 1000)` (30 s by
default). The CLI prints the underlying error (`Error(Contract, #n)`, timeout,
or RPC message) that the proxy only classifies.

**Next step.** If `getHealth` is healthy and `keylease status` works, the proxy
is pointed at a different `KEYLEASE_RPC_URL`/network/contract than your shell —
compare 1.1. If the CLI also fails, it is the RPC path: escalate to the RPC
provider and keep the proxy up (it serves cached leases); do not "fix" it by
disabling verification.

**Retryable** by the client after `Retry-After`. No quota is consumed: the call
is charged only after a successful verification.

### 503 `verification_unavailable` from `/readyz`

Readiness only; no bearer token involved. Means the process has no cached lease
state yet (cold start) or the last RPC read failed. `Retry-After` is the same
value. Do not remove it from the load balancer on a single probe from a cold
instance; see 1.6.

### 503 `overloaded`

**Meaning.** `KEYLEASE_MAX_INFLIGHT` (default 1024, `0` disables) proxied
requests were already in flight. The slot is taken **before** verification, so
a shed request never consumes a call.

**Failure path.** `handler` in `server.ts` compares `upstreamSlots` with the
limit and answers immediately with `Retry-After: 1`.

**First command.**

```bash
curl -sS http://127.0.0.1:8080/metrics | grep -E 'keylease_requests_(total|allowed|denied)'
```

**Evidence.** Requests total far above allowed, upstream latency histogram in
the seconds buckets, and slow `durationMs` on `access` lines.

**Next step.** Find out whether the upstream is hanging (see 504) or traffic
really is above capacity; raise the cap or add instances only after confirming
the upstream can take it.

**Retryable**, and free: no quota is charged for a shed request.

### 502 `bad_gateway`

**Meaning.** The lease verified and the call was consumed, then `fetch` to
`KEYLEASE_UPSTREAM_URL` threw a non-timeout error (DNS failure, connection
refused, TLS error).

**First command.**

```bash
curl -sS -i "${KEYLEASE_UPSTREAM_URL%/}/" | head -5
```

**Evidence.** `upstream request failed` in the proxy log with `err` and
`target`; the same `x-request-id` on the client response.

**Next step.** Fix the upstream/URL. Note the caller has been charged and the
call is **not** refunded — that is documented behaviour: once verification
succeeds, a call stays consumed even if the client disconnects or the upstream
fails.

**Not retryable for free**: every retry consumes another call. If a whole
traffic burst fails this way, reconcile the affected leases when the upstream
is healthy ([§3](#3-quota-drift-and-crash-recovery)); consider revoking
affected leases as a customer-relations decision, not an operator one.

### 504 `gateway_timeout`

**Meaning.** The upstream did not answer within the per-request timeout
(15 s by default) and the abort surfaced as `TimeoutError`/`AbortError`.

**Failure path.** `requestTimeoutMs` in `buildProxyServer` racing the client
abort signal; the same `upstream request failed` log line records it.

**First command.**

```bash
curl -sS -o /dev/null -w '%{http_code} %{time_total}\n' "${KEYLEASE_UPSTREAM_URL%/}/"
```

**Evidence.** `keylease_upstream_latency_seconds` buckets piling up at the top,
`durationMs` near 15 000 in `access` lines.

**Next step.** Treat it as an upstream latency incident. The timeout is **not
environment-configurable in this version** (`requestTimeoutMs` is a
programmatic option only), so raising it requires a code change and a release —
do not expect an env var to exist.

**Retryable, but each retry costs a call.**

### 5xx forwarded from the upstream

The proxy sets `reply.code(response.status)` and copies the upstream's headers
and body. A `500`/`503` from the API therefore appears through the proxy with
the upstream's own body, plus `x-keylease-lease-id` and
`x-keylease-calls-remaining`.

**Evidence.** The body is not `{"error":"…"}` from this list; `x-keylease-*`
headers are present; `access` shows the status with a duration consistent with
the upstream's. **Next step.** Debug the upstream; no proxy configuration is
involved.

### 500 (Fastify default shape)

**Meaning.** An unexpected exception escaped a route/hook. The error handler
only special-cases `413`; everything else is re-sent, so Fastify renders its
default `{statusCode, error, message}` rather than the proxy's
`{error, message}` shape.

**First command.** Look at the process log around the request id; if it is not
obvious, reproduce locally with the same body:

```bash
curl -sS -i -H "Authorization: Bearer $KEYLEASE_SESSION_TOKEN" \
  -X <method> "http://127.0.0.1:8080<path>"
```

**Evidence.** A pino `error` entry with a stack trace and the same `reqId`.
**Next step.** Treat it as a bug: capture the log window, open an issue, and
restart if it persists. If it happened after verification the call was already
charged.

---

## 3. Quota drift and crash recovery

### 3.1 What `calls_used` means

`calls_used` is a `u32` on the `Lease` struct in `keylease-core`. It only
changes when the registered gateway account submits `use_call(lease_id, count)`,
which adds `count` and saturates at `calls_limit` (`min(used + count, limit)`);
it never decreases. It drives:

* `remaining_calls(lease_id)` and the proxy's on-chain check,
* settlement: `payable = price_paid × calls_used / calls_limit` to the provider,
  `refund = price_paid − payable` to the consumer.

So drift is money: under-reporting under-pays the provider and over-refunds the
consumer; over-reporting charges the consumer for calls nobody served.

### 3.2 Local and on-chain accounting

Two counters, one authority:

* **Local** (`LeaseVerifier.calls`) — per process, per lease, incremented at
  admission, starts at 0 on every start, evicted LRU-style at 10 000 tracked
  leases.
* **On-chain** (`calls_used`) — authoritative, only moves on `use_call`.

Admission uses `max(chain.calls_used from the cache, local counter)` and denies
at `calls_limit`. The cache is at most `KEYLEASE_CACHE_TTL_MS` old and never
outlives the lease's own expiry. Between commits, the local counter is ahead of
the chain; on a second instance, the chain is ahead of the local counter.

### 3.3 How a served call becomes an on-chain call

`record(leaseId)` → pending map (memory) → flush when the **total** pending
count reaches `KEYLEASE_QUOTA_BATCH` (50), every `KEYLEASE_QUOTA_FLUSH_MS`
(10 s), or at graceful shutdown → one `use_call` per lease, serialised through a
queue. A failed commit puts the count back into pending and retries with
exponential backoff and jitter (base 1 s, cap 30 s) for at most 5 attempts;
each failure is logged through `onError`. There is no success log.

### 3.4 What a crash loses

Everything in pending. `flush()` takes a snapshot and **clears** the pending map
before the commits resolve, so a process that dies mid-commit loses those counts
as well. The loss is bounded by roughly one batch window per flush cycle, plus
everything served while commits were failing — not by a single call.

Consequences:

* The provider is under-paid at settlement for the missing calls.
* The consumer is refunded for calls that were served.
* Any other instance (or the same instance after restart) sees a higher
  on-chain `remaining_calls` than reality and may admit calls the crashed
  instance already served. This is over-delivery, and it is the reason quota
  reconciliation matters before settlement.

### 3.5 Identifying incomplete accounting

The proxy keeps **no per-lease served-call ledger**: there is no pending-count
metric, no commit success log, and the `access` log line has no lease id. Exact
reconstruction is therefore impossible from proxy output alone. Evidence you do
have:

1. The baseline `callsUsed` you recorded at startup (1.7).
2. Client-visible `x-keylease-calls-remaining` values from responses.
3. Upstream request logs (they include `x-request-id` and the proxy's
   `x-keylease-lease-id` header).
4. `on-chain quota commit failed; calls requeued` warnings, whose `leaseId` and
   `count` fields name the affected lease and batch size.

Treat any `calls_used` that is lower than the best evidence of served calls as
drift, and reconcile before the lease expires.

### 3.6 Reconciling with `use_call`

`use_call` is the only way to move `calls_used`, and it has **no idempotency
key**: no nonce, no request id, no dedupe. Calling it twice with the same count
adds the count twice. The only protection is the saturating clamp at
`calls_limit` (which caps over-commit but also silently swallows the excess).

Preconditions: the lease must exist, be `active`, not `settled`, and not
expired. Otherwise you get `Error(Contract, #6)` (`LeaseInactive`),
`#7` (`LeaseExpired`), or `#14` (`Unauthorized`) for a non-gateway signer.

1. Freeze new traffic for the lease if you can (rotate the consumer's token out
   or stop that tenant at the edge). The proxy has no per-lease kill switch.
2. Read the current count and decide the delta from evidence (3.5):

   ```bash
   keylease status --lease <lease-id> --json --network "$KEYLEASE_NETWORK" --contract "$KEYLEASE_CONTRACT_ID"
   ```

3. Import the gateway seed into the local keystore once. The prompt reads it
   without echoing, and the seed never appears in your shell history or the
   process list:

   ```bash
   stellar keys add gateway-ops --secret-key   # prompts; --secure-store is the newer flag for seed phrases
   ```

4. **Preview** the invocation (simulation; nothing is signed or sent) to check
   the argument names and that the contract accepts the call shape:

   ```bash
   stellar contract invoke --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" \
     --send=no --source-account gateway-ops -- use_call --lease_id <lease-id> --count <delta>
   ```

   Simulation records authorisation instead of enforcing it, and can print
   `Success` without changing state. A successful preview therefore proves
   nothing about the key or the result: only the on-chain read in step 6 does.

5. Submit it once, and record the transaction hash from the output:

   ```bash
   stellar contract invoke --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" \
     --source-account gateway-ops -- use_call --lease_id <lease-id> --count <delta>
   ```

6. Verify by re-reading — not by trusting the command's success line:

   ```bash
   keylease status --lease <lease-id> --json --network "$KEYLEASE_NETWORK" --contract "$KEYLEASE_CONTRACT_ID"
   ```

   `callsUsed` must equal the pre-read plus the delta (capped at `callsLimit`).
   The transaction also emits `calls_committed` with `(calls_used, remaining)`
   under the `(calls_committed, consumer, lease_id)` topics; the hash from step
   5 is your audit record.

Record in the incident log: lease id, evidence used for the delta, delta, tx
hash, before/after `callsUsed`. If you cannot justify the delta from evidence,
do not guess.

### 3.7 When the outcome is ambiguous

If a reconciliation transaction's outcome is unknown (RPC timeout after
submission, operator interrupt, process death):

1. **Read first.** `get_lease` and compare `calls_used` with the pre-read. The
   transaction may already be included.
2. If it is included, stop — do not resubmit.
3. If it is not included and you have the hash, check the hash on an explorer
   for the network; `NOT_FOUND` after a reasonable window means it was never
   included.
4. If neither is conclusive, wait for the ledger window to settle, read again,
   and only then decide. There is no mechanism that makes a second submission
   safe; the contract cannot tell a retry from a new count.

### 3.8 What cannot be reconciled

Be explicit with stakeholders; these are limitations of the implementation, not
procedure gaps:

* **Expired leases** reject `use_call` with `Error(Contract, #7)`. `settle`
  becomes available immediately, and it uses the under-reported `calls_used`.
  Reconcile *before* expiry or accept the shortfall.
* **Settled or revoked leases** reject `use_call` with `Error(Contract, #6)`.
  The escrow has already been split; nothing can add calls afterwards.
* **No per-lease served-call ledger** means the delta is an evidence-based
  estimate, not an exact figure.
* **`use_call` is not idempotent**, so there is no exactly-once reconciliation
  and no automatic retry you can trust.

Never "correct" a lease by incrementing or decrementing counters that the
contract does not expose, and never settle a lease to make a discrepancy go
away — settlement is what turns accounting into payouts.

---

## 4. Gateway key rotation

Two independent layers, rotated separately:

| Layer | What it is | Changed by |
| --- | --- | --- |
| On-chain gateway | the single `Address` in `Config` allowed to call `use_call` | `set_gateway(gateway)`, admin auth |
| Proxy configuration | `KEYLEASE_GATEWAY_SECRET` in the process environment | secret store + restart |

The contract stores exactly **one** gateway, so rotation is unavoidably
two-phase and has a short window in which commits fail. Plan it outside peak
traffic.

### 4.1 Prepare the replacement key

Create a fresh Stellar account (`stellar keys generate` or your organisation's
provisioning), fund it with XLM for `use_call` fees, and store the seed in the
secret manager. It must never be committed: `.env*` and `.keylease/` are
git-ignored for this reason.

### 4.2 Verify access and permissions before touching anything

```bash
# New key: derives and prints the public address (run in packages/proxy).
cd packages/proxy
node --input-type=module -e "import { Keypair } from '@stellar/stellar-sdk'; process.stdout.write(Keypair.fromSecret(process.env.NEW_GATEWAY_SECRET).publicKey() + '\n')"
# New key can pay fees: native SAC balance must be non-zero.
stellar contract invoke --id "$KEYLEASE_ESCROW_TOKEN" --network "$KEYLEASE_NETWORK" \
  --send=no --source-account "$READ_ONLY_SOURCE" -- balance --id "$NEW_GATEWAY_PUBLIC_KEY"
# You can still act as admin: get_config.admin must be an account you control.
stellar contract invoke --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" \
  --send=no --source-account "$READ_ONLY_SOURCE" -- get_config
```

Import the **admin** seed into the local keystore (hidden prompt) so the
on-chain step can sign:

```bash
stellar keys add admin-ops --secret-key
```

### 4.3 Perform the rotation

1. Point the contract at the new gateway (admin-signed, on-chain):

   ```bash
   stellar contract invoke --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" \
     --source-account admin-ops -- set_gateway --gateway "$NEW_GATEWAY_PUBLIC_KEY"
   ```

2. Confirm it landed by reading, not by the command's output:

   ```bash
   stellar contract invoke --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" \
     --send=no --source-account "$READ_ONLY_SOURCE" -- get_config
   ```

   `gateway` must be the new address. The contract also emits a `gateway` event.

3. Update `KEYLEASE_GATEWAY_SECRET` in the secret store and roll the proxy with
   the graceful procedure in [§5](#5-restarting-without-losing-calls). From
   step 1 until the last instance is restarted, every `use_call` is rejected
   with `Error(Contract, #14)` and logged as
   `on-chain quota commit failed; calls requeued`; counts are requeued and
   retried (≤ 5 attempts) and flushed on shutdown, so a short window is
   recoverable but not free. Reconcile after rollout if the window was long
   enough for retries to be exhausted.

### 4.4 Verify the new key works

Send one authorized request, wait for a flush (≤ `KEYLEASE_QUOTA_FLUSH_MS` or
`KEYLEASE_QUOTA_BATCH` calls), and confirm `callsUsed` increased (1.7). No new
`on-chain quota commit failed` warnings should appear.

### 4.5 Confirm the old key is no longer used

* `get_config.gateway` is the new address.
* No running instance still has the old seed configured — a stale instance
  logs `#14` commit failures and its counts stop reaching the chain.
* Remove the old seed from the secret store only after the last instance is
  replaced *and* you are sure no rollback needs it (see 4.6).

### 4.6 Rollback

Rollback differs by layer — be precise in the incident record:

* **Configuration rollback** (restore the previous `KEYLEASE_GATEWAY_SECRET`
  and restart) only restores the ability to commit if the on-chain gateway is
  *still* the old address. It is the right rollback when the new key was bad
  before `set_gateway` landed, or when `set_gateway` itself failed.
* **On-chain rollback** is a second on-chain change: after a successful
  `set_gateway`, the contract only accepts the new gateway, so restoring an old
  environment variable changes nothing. To go back you must call
  `set_gateway` again with the old address, signed by the admin — another
  transaction, another failure window, and a decision that needs the same
  authority as the forward change.
* **Compromised key**: rotate forward to a *new* key, never back to the
  compromised one, and reconcile the affected leases before settlement.

Admin rotation is a separate, two-step handover (`propose_admin` then
`accept_admin` by the nominee). It is not reversible by environment variables
either, and a typo cannot lock you out of rotation because nothing changes until
the nominee accepts.

### 4.7 Monitor after rotation

Watch for `on-chain quota commit failed; calls requeued` (and `#14` in the
wrapped error), compare each active lease's `calls_used` with your evidence,
and reconcile per [§3](#3-quota-drift-and-crash-recovery) before the earliest
expiry.

---

## 5. Restarting without losing calls

### 5.1 What a restart does

In-memory state is gone: local counters, the lease cache and the pending commit
map. The chain keeps every committed call. A clean restart therefore loses
nothing that was already committed, and can lose the uncommitted window
(3.4). The proxy itself is stateless between restarts — there is no queue, WAL
or spool file.

### 5.2 Graceful shutdown is supported

`SIGTERM`/`SIGINT` run `drain()` in `index.ts`:

```
received SIGTERM; draining in-flight requests...
shutdown complete: drained          # exit 0
shutdown complete: timed_out        # exit 1
```

Order: wait for in-flight requests (`drainProxyServer`, bounded by
`KEYLEASE_SHUTDOWN_TIMEOUT_MS`, default 10 000 ms) → close the server → stop the
quota timer → one final flush of pending counts. A **second** signal forces
`exit(1)` immediately, cutting in-flight requests and skipping the final flush.
Send exactly one signal and wait.

`startProxy()` also exposes `drain()` programmatically; `close()` stops the
quota sink and closes Fastify for embedded/test use.

### 5.3 How in-flight calls are handled

A call is consumed at admission, **before** forwarding. It stays consumed even
if the client disconnects or the upstream fails. During a drain, accepted
requests run to completion; new connections are refused once the server starts
closing; requests still running at the timeout are terminated (the client sees
an aborted connection). Nothing is refunded.

### 5.4 Safe restart procedure

1. Stop routing new traffic to the instance (load balancer / edge), so the
   drain has a finite set to finish.
2. `kill -TERM <pid>` **once**. Check the pid you own; never use pattern kills.
3. Wait for `shutdown complete: drained` and exit status 0.
4. Note the wall-clock time. Any counts pending at that moment were either
   flushed by `close()` or lost if the flush failed — the log shows a failed
   commit as `on-chain quota commit failed; calls requeued`, but there is no
   log for a successful final flush, so verify against the chain.
5. Reconcile per §3 if the instance had been serving traffic during failures.
6. Start the new process, run the startup checks (1.1–1.6), and prove one call
   reaches the chain (1.7).
7. Re-add the instance to the load balancer.

### 5.5 Running more than one instance

* Run **every** instance with `KEYLEASE_GATEWAY_SECRET`. Instances without it
  enforce quota only locally, and two of them will together serve more calls
  than the lease allows.
* With the key configured, all instances share the single on-chain gateway and
  each commit is an independent transaction that saturates at `calls_limit`;
  two instances can still both admit a call inside the cache TTL window (30 s
  by default). That is a soft over-delivery, not a double charge.
* Reduce `KEYLEASE_CACHE_TTL_MS` if that window matters more than RPC load.

### 5.6 Avoiding duplicate settlement and duplicate quota consumption

* Settlement is guarded on chain: a second `settle` on a settled lease fails
  with `Error(Contract, #9)` (`AlreadySettled`), and a settled lease also
  rejects `use_call` with `#6`. A payout cannot happen twice.
* `settle` only succeeds after expiry or exhaustion; before that it fails with
  `Error(Contract, #8)` (`LeaseNotSettleable`). That error is expected, not a
  bug.
* Reconcile **before** settling. Settlement is where under-reported quota turns
  into an under-payment, and it cannot be undone.
* Duplicate quota consumption comes from re-submitting a reconciliation
  (§3.6/3.7), not from restarts.

### 5.7 Recovery after an unclean stop

`kill -9`, an OOM kill or a crash skips the drain:

1. Start the proxy again with the same configuration. Its local counters reset;
   chain state (through the cache) governs admission.
2. Assume the last batch window was lost. Do not assume it was committed — read
   `calls_used`.
3. Reconcile per §3, before expiry if possible.
4. Record the incident: what was lost, what evidence you used, and the
   reconciliation transaction hashes. If the outcome is ambiguous, follow 3.7
   and leave the chain alone rather than guessing upward.

---

## Appendix: configuration reference

| Variable | Required | Default | Operational note |
| --- | --- | --- | --- |
| `KEYLEASE_UPSTREAM_URL` | yes | – | Base URL; path prefixes are preserved |
| `KEYLEASE_CONTRACT_ID` | yes | – | `keylease-core` id |
| `KEYLEASE_NETWORK` | no | `testnet` | `testnet` \| `mainnet` \| `local` |
| `KEYLEASE_RPC_URL` | no | network default | Point at your provider; verify in 1.4 |
| `KEYLEASE_GATEWAY_SECRET` | production | – | Enables `use_call` commits; secret |
| `KEYLEASE_QUOTA_BATCH` | no | `50` | Calls buffered before a commit |
| `KEYLEASE_QUOTA_FLUSH_MS` | no | `10000` | Periodic commit interval |
| `KEYLEASE_CACHE_TTL_MS` | no | `30000` | Lease-state cache; also bounds `Retry-After` (≤ 30 s) and RPC outage tolerance |
| `KEYLEASE_MAX_BODY_BYTES` | no | `33554432` | 32 MiB; hard ceiling 1 GiB |
| `KEYLEASE_TRUST_PROXY` | no | `false` | Required behind a load balancer for correct `x-forwarded-*` |
| `KEYLEASE_MAX_INFLIGHT` | no | `1024` | Excess gets `503 overloaded`; `0` disables |
| `KEYLEASE_FORWARD_AUTH` | no | `false` | Forward the caller's bearer token upstream |
| `KEYLEASE_METRICS_ENABLED` | no | `false` | `/metrics` |
| `KEYLEASE_SHUTDOWN_TIMEOUT_MS` | no | `10000` | Drain budget for §5 |
| `PORT` / `HOST` | no | `8080` / `0.0.0.0` | Listen address |

The per-request upstream timeout (15 s) is a `buildProxyServer` option, not an
environment variable in this version.
