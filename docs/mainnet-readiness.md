# Mainnet readiness checklist

Go/no-go gates for using this software with **mainnet value at risk**.

`SECURITY.md` states the policy: the software is pre-1.0, has not been
independently audited, and must not hold mainnet value until an audit is
announced. This document turns that policy into concrete, evidence-backed gates
with named roles and a sign-off. It does not replace or relax the policy — it
defines what "ready" would have to mean.

> **Current status: NO-GO.** No gate below has recorded evidence or sign-off.
> The checkboxes describe what must be true, not what has been done. Owner
> columns are roles; they are assigned by the release owner before a readiness
> review and are not claims that a person has signed anything.

How to use it: copy the gate tables into the release issue, fill the `Status`
and `Evidence` columns, attach the drill artefacts, then hold the sign-off in
§6. Any mandatory gate that is not `Done` is a NO-GO, regardless of how much
work has gone into the others.

Roles used throughout:

| Role | Responsibility |
| --- | --- |
| Release owner | Runs the readiness review, owns the GO/NO-GO decision record |
| Contract maintainer | `contracts/keylease-core`: correctness, build reproducibility, ABI version |
| Security reviewer | Audit intake, findings triage, threat-model review, risk acceptance |
| Infrastructure operator | Deployment, RPC configuration, monitoring, on-call tooling |
| Key custodian | Admin, gateway, provider and consumer key material and custody records |
| Incident response lead | Runbook drills, escalation paths, post-incident review |

---

## 1. Technical gates

| ID | Gate (mandatory unless marked) | Owner role | Required evidence | Status |
| --- | --- | --- | --- | --- |
| T1 | Independent security audit of `keylease-core`, `@keylease/cli` and `@keylease/proxy` completed | Security reviewer | Audit report (scope, commit hash, auditor, date) | Not started |
| T2 | All critical and high audit findings resolved, or explicitly accepted through §3 | Contract maintainer + Security reviewer | Finding-by-finding disposition table with links to fixes or accepted-risk records | Not started |
| T3 | Contract correctness review: escrow maths, authorisation on every entry point, quota saturation, TTL extension | Contract maintainer | Review notes; `cargo test` output for `contracts/keylease-core` | Not started |
| T4 | Deployment verification: wasm hash, contract ABI `version()`, `get_config` contents match the reviewed build | Contract maintainer | `stellar contract build` output, wasm SHA-256, `deployments.json`, tx hashes for upload/create/init | Not started |
| T5 | RPC reliability: at least two independent providers, documented failover, measured error/latency budget | Infrastructure operator | Provider list, failover drill log, observed `verification_unavailable` rate under failover | Not started |
| T6 | Monitoring and alerting: `/healthz`, `/readyz`, `/metrics`, 5xx classes, denial reasons, quota commit failures | Infrastructure operator | Dashboard and alert definitions, a fired-and-acknowledged test alert | Not started |
| T7 | Escrow solvency verified with the procedure in §4 | Key custodian + Infrastructure operator | Balance/liability reconciliation output and sign-off | Not started |
| T8 | Settlement correctness: `payable`/`refund` split verified for partial use, full use and zero use | Contract maintainer | Drill transactions from §5 with balances before/after | Not started |
| T9 | Refund path verified: `revoke` by the consumer and `settle` refund for the unused remainder | Contract maintainer | Drill transactions and consumer balance deltas | Not started |
| T10 | Operational recovery readiness: the runbook procedures have been exercised, not just read | Incident response lead | Drill log referencing `docs/runbook.md` sections and outcomes | Not started |

Notes that matter for these gates:

* The proxy's guards are **fail-closed but cached**: a lease may be admitted for
  up to `KEYLEASE_CACHE_TTL_MS` after it expires on chain, and RPC outages are
  survived only from cache. T5/T6 must measure that behaviour rather than
  assume instant enforcement.
* Two proxy instances can both admit a call inside the cache window even with
  the gateway key configured. Capacity planning must account for that soft
  over-delivery.
* `remaining_calls` and the proxy read the same `Lease` struct; an ABI change
  invalidates both (§T4).

---

## 2. Operational gates

| ID | Gate | Owner role | Required evidence | Status |
| --- | --- | --- | --- | --- |
| O1 | Production deployment procedure written and rehearsed (build from a signed tag, pin the wasm, no testnet seeds anywhere) | Infrastructure operator | Deployment runbook, two-person dry run, artefact hashes | Not started |
| O2 | Gateway key custody documented: who holds it, where, how it is used, break-glass path | Key custodian | Custody record, access list, secret-store configuration | Not started |
| O3 | Key rotation readiness: admin and gateway rotation rehearsed on testnet, including rollback | Key custodian + Contract maintainer | Drill record following [`docs/runbook.md` §4](./runbook.md#4-gateway-key-rotation) | Not started |
| O4 | RPC failover procedure documented and drilled, including `KEYLEASE_RPC_URL` switch and cache-window behaviour | Infrastructure operator | Failover timeline, error rates, recovery time | Not started |
| O5 | Incident response ownership: named lead, escalation path, severity definitions, customer comms | Incident response lead | On-call rota, escalation document | Not started |
| O6 | On-call responsibilities cover quota reconciliation and settlement timing | Incident response lead | Rota entry and checklist referencing [runbook §3](./runbook.md#3-quota-drift-and-crash-recovery) | Not started |
| O7 | Logging and monitoring retained for dispute resolution (request ids, denials, commit failures) | Infrastructure operator | Retention policy and a sample query for one lease's traffic | Not started |
| O8 | Backup and recovery: deployment record, wasm, configs, key custody. On-chain state is the accounting source of truth | Infrastructure operator | Restore drill: rebuild from tag, redeploy proxy, verify `get_config`/leases | Not started |
| O9 | Proxy restart and quota reconciliation readiness, including unclean-stop recovery | Infrastructure operator | Drill record following [runbook §5](./runbook.md#5-restarting-without-losing-calls) | Not started |

The proxy persists nothing locally: there is no database to back up. "Backup"
for this system means the deployment record (`deployments.json`), the wasm and
its hash, the reviewed source tag, the proxy configuration and the key custody
records — plus the ability to read chain state after a total host loss.

---

## 3. Security gates

| ID | Gate | Owner role | Required evidence | Status |
| --- | --- | --- | --- | --- |
| S1 | Independent audit completed and reviewed by someone who did not write the code | Security reviewer | Audit report plus review minutes | Not started |
| S2 | Critical/high findings resolved or accepted through an authorised process: written rationale, compensating control, expiry, and approval by the release owner and security reviewer | Security reviewer + Release owner | Findings register with approvals | Not started |
| S3 | Key custody documented and least-privilege access enforced: separate admin, gateway, provider and consumer accounts; no shared or reused keys; no admin key on proxy hosts | Key custodian | Access matrix, account inventory, host inventory | Not started |
| S4 | Secrets handling: seeds only in the secret store, injected as `KEYLEASE_GATEWAY_SECRET`; no seeds in git, images, logs or shell history; `.env*` and `.keylease/` remain untracked | Key custodian + Infrastructure operator | Secret-store policy, repository scan result | Not started |
| S5 | Threat-model review against the in-scope list in `SECURITY.md` (token forgery/replay, quota bypass, escrow payout, authorisation gaps, RPC spoofing, secret leakage, header/smuggling) | Security reviewer | Review notes and the residual-risk statement | Not started |
| S6 | Emergency containment procedure documented and rehearsed. The contract has **no pause or kill switch** — see the note below | Incident response lead | Containment runbook and drill record | Not started |
| S7 | Refund path tested end to end (consumer `revoke`, permissionless `settle` refund) | Contract maintainer | §5 drill artefacts | Not started |
| S8 | Account-level signer configuration reviewed for the accounts that authorise `set_gateway`/`propose_admin` (standard Stellar thresholds apply to an account address's authorisation); confirm in the drill whether multisig is in place | Key custodian | Account signer/threshold configuration snapshot | Not started |

**Containment, accurately described.** `keylease-core` implements no global
pause. The levers that exist:

* A provider can `set_service_active(provider, service, false)`, which blocks
  **new leases** for that service. Existing leases keep working at the proxy
  until they expire or are revoked — the proxy does not consult the service
  flag.
* A consumer can `revoke` a lease, refunding unused calls immediately.
* The operator can stop the proxy or remove it from the load balancer, which
  stops serving but consumes nothing.
* The admin can `set_gateway` to an address nobody controls. That stops every
  `use_call`, so on-chain quota reporting stops while the proxy (from cache and
  local counters) may keep admitting calls. It is a blunt instrument with an
  accounting cost and should be rehearsed before it is ever needed.

Do not describe any of these as "pausing the contract" in customer or incident
communications.

---

## 4. Escrow solvency checks

### 4.1 The accounting model

`create_lease` transfers `price_paid = calls × price_per_call` of the configured
SAC token from the consumer into the contract. That amount is the only collateral
behind a lease, and it can leave the contract through exactly two paths:

* `settle(lease_id)` once the lease expired or is exhausted:
  `payable = price_paid × calls_used / calls_limit` → provider,
  `refund = price_paid − payable` → consumer.
* `revoke(lease_id)` by the consumer:
  `refund = price_paid × (calls_limit − calls_used) / calls_limit` → consumer,
  provider gets nothing.

Integer division floors. In `settle` the consumer receives
`price_paid − payable`, so the rounding dust goes to the consumer; in `revoke`
the refund itself is floored, so a few stroops stay in the contract with no way
to withdraw them. Both paths mark the lease `settled` and cannot run twice
(`AlreadySettled`). There is **no
admin withdrawal or sweep entry point**: the contract can only pay providers and
consumers, so any surplus in the contract is stuck and is itself a finding.

### 4.2 The solvency invariant

For every lease that is not yet `settled`, the contract owes at most
`price_paid`. Therefore:

```
balance_of_contract_in_escrow_token  ==  Σ price_paid over all unsettled leases
```

is the expected state. `>` means funds nobody can withdraw (investigate: revoke rounding dust, a
settled lease incorrectly counted, wrong token, or an out-of-band transfer).
`<` means the contract cannot honour its obligations — **hard blocker**.

### 4.3 Procedure

```bash
export KEYLEASE_NETWORK=<network>
export KEYLEASE_CONTRACT_ID=<keylease-core id>
export READ_ONLY_SOURCE=<funded account public key on the same network>

# 1. token + lease_count
stellar contract invoke --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" \
  --send=no --source-account "$READ_ONLY_SOURCE" -- get_config
# -> {"admin":"…","gateway":"…","lease_count":N,"token":"CDLZ…"}

# 2. every lease, unsettled ones sum their price_paid
for id in $(seq 1 "$LEASE_COUNT"); do
  stellar contract invoke --id "$KEYLEASE_CONTRACT_ID" --network "$KEYLEASE_NETWORK" \
    --send=no --source-account "$READ_ONLY_SOURCE" -- get_lease --lease_id "$id"
done

# 3. the contract's balance in the escrow token
stellar contract invoke --id "$KEYLEASE_ESCROW_TOKEN" --network "$KEYLEASE_NETWORK" \
  --send=no --source-account "$READ_ONLY_SOURCE" -- balance --id "$KEYLEASE_CONTRACT_ID"
```

`LEASE_COUNT` is the `lease_count` from step 1; `KEYLEASE_ESCROW_TOKEN` is its
`token`. The token balance is in the token's smallest unit (stroops for the
native SAC), the same unit as `price_paid`.

Worked example from the current testnet deployment (2026-11-19): `lease_count`
is 2, both leases unsettled with `price_paid` 25 000 and 2 000, and the
contract's native-SAC balance reads `"27000"` — exactly equal, so the invariant
holds.

### 4.4 Per-lease liability projection

For each unsettled lease also record `calls_used`, `calls_limit` and expiry, then
compute the current `payable`/`refund` split. This is the number the provider
and consumer will actually receive at settlement, and the sum across leases is
the expected payout obligation. Take the projection twice, before and after the
settlement drill, and attach both.

### 4.5 Launch blockers

Any of the following is a NO-GO on its own:

* Contract balance below the sum of unsettled `price_paid`.
* Any lease whose `get_lease` cannot be read (state/ABI drift).
* `get_config.token` is not the intended SAC, or `admin`/`gateway` is not the
  account the custody record names.
* Any settled lease still counted in the liability total.
* A surplus that cannot be explained (there is no way to withdraw it).

---

## 5. Testnet settlement drill (mandatory)

Run on testnet only, with fresh accounts, against the exact artefact proposed
for mainnet: the same tag, wasm hash and proxy build. Do not reuse accounts or
keys from earlier drills.

### 5.1 Preconditions

* Reviewed build: record `git rev-parse HEAD`, `stellar contract build` output,
  wasm SHA-256, and the contract's `version()`.
* Fresh admin, gateway, provider and consumer accounts, funded from friendbot;
  seeds stored outside the repository.
* A registered service with a known `price_per_call` and an `active: true`
  state.
* The proxy built and started with `KEYLEASE_GATEWAY_SECRET` for the gateway
  account (`onChainQuotaCommits: true`), `/healthz` and `/readyz` good.
* The baseline solvency snapshot from §4 taken **before** the drill.

### 5.2 Representative successful settlement

1. Acquire a small lease (5 calls, short duration) and keep the consumer seed
   available only to the drill operator:

   ```bash
   keylease acquire --service <service> --calls 5 --duration 600 \
     --secret "$DRILL_CONSUMER_SEED" --network testnet --contract "$KEYLEASE_CONTRACT_ID"
   keylease env --service <service> --file /tmp/drill.env
   ```

2. Serve calls through the proxy until the quota is exhausted (or wait for
   expiry). Confirm one call reaches the chain after a flush interval:

   ```bash
   keylease status --lease <id> --json --network testnet --contract "$KEYLEASE_CONTRACT_ID"
   ```

3. Negative check: `settle` on the still-active, non-exhausted lease must fail
   with `Error(Contract, #8)` (`LeaseNotSettleable`). Record the output.
4. Capture provider and consumer token balances, then settle:

   ```bash
   keylease settle --lease <id> --secret "$DRILL_SEED" --network testnet --contract "$KEYLEASE_CONTRACT_ID"
   ```

5. Verify: provider balance increased by
   `floor(price_paid × calls_used / calls_limit)`, consumer balance increased by
   the remainder, the contract balance decreased by exactly `price_paid`, the
   lease reads `settled: true, active: false`, and a second `settle` fails with
   `#9` (`AlreadySettled`). Keep both.
   Also reconcile any uncommitted calls *before* this step if the proxy was
   restarted during the drill — settlement is what turns under-reported quota
   into an under-payment.

### 5.3 Refund scenario

1. Acquire a new lease (5 calls), serve two, then revoke from the consumer:
   `keylease revoke --lease <id> --secret "$DRILL_CONSUMER_SEED" …`
2. Verify the consumer receives
   `floor(price_paid × (calls_limit − calls_used) / calls_limit)`, the provider
   receives nothing, the lease is `settled`/inactive, and `use_call` on it now
   fails with `#6` (`LeaseInactive`).
3. Verify the contract-balance delta equals the refund exactly.

### 5.4 Failure and recovery scenario

1. With traffic running, `kill -9` the proxy so the pending batch is lost.
   Restart it and confirm from the chain that `calls_used` is behind the calls
   the client received (`x-keylease-calls-remaining` shows the gap).
2. Reconcile with the [runbook §3](./runbook.md#3-quota-drift-and-crash-recovery)
   procedure: preview, submit once, verify by re-reading, keep the tx hash.
3. Settle and confirm the provider is paid for the reconciled count.
4. Repeat with an RPC outage: point `KEYLEASE_RPC_URL` at a black-hole endpoint
   and confirm new leases get `503 verification_unavailable` (fail closed) while
   cached leases keep working for up to `KEYLEASE_CACHE_TTL_MS`; restore and
   confirm recovery.
5. Re-run the solvency snapshot (§4) and compare with the baseline.

### 5.5 Evidence to retain

* `git rev-parse HEAD`, wasm SHA-256, contract `version()`, `deployments.json`.
* Every transaction hash: `create_lease`, `use_call` (batch and reconciliation),
  `settle`, `revoke` — with explorer links.
* Before/after balances for consumer, provider and contract (raw JSON).
* `get_lease` output before and after each action, including `calls_used`.
* Proxy logs for the drill window (startup config line with
  `onChainQuotaCommits: true`, drain/shutdown lines, any commit-failure
  warnings), plus the `x-request-id`s used.
* The solvency reconciliation from §4 before and after.
* Drill date, environment, and the names of the operator and the reviewer who
  checked the evidence.

---

## 6. GO/NO-GO decision

**GO requires all of the following:**

1. Every mandatory gate in §1–§3 is `Done` with evidence attached.
2. Blocking audit findings (critical/high) are resolved, or accepted through the
   authorised §3 process with a compensating control and an expiry.
3. Escrow solvency is confirmed against the invariant in §4 on the deployment
   that will hold value.
4. The testnet settlement drill in §5 succeeded, including the refund and the
   failure/recovery scenario, with evidence retained.
5. Explicit sign-off below from every named owner.

**Any unresolved mandatory gate is a NO-GO.** A gate cannot be skipped because
it is inconvenient, and "will monitor closely" is not a compensating control.
Deferring a gate is a release-owner decision that must be recorded with the
gate left open and the deployment scoped so it cannot hold value.

### Sign-off

| Field | Value |
| --- | --- |
| Release / version / commit | |
| Deployment (network, contract id, wasm hash) | |
| Gate table completed by | |
| Contract maintainer | |
| Security reviewer | |
| Infrastructure operator | |
| Key custodian | |
| Incident response lead | |
| Release owner | |
| Decision (`GO` / `NO-GO`) | |
| Date | |

No sign-off may be filled in prospectively: this document records decisions
after the evidence exists. Nothing in this repository currently records such a
decision.
