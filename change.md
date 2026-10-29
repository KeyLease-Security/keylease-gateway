I'm appealing the rejection of KeyLease-Security/keylease-gateway for the Stellar Wave Program.

The version you reviewed was a thin TypeScript wrapper: the lease contract lived in a different repository, leases were a registry write with no payment, and quota was enforced in a proxy's in-memory Map. Most of what the repo claimed was therefore neither implemented nor verifiable in it. That has changed substantially — the on-chain half of the product is now written, tested and deployed here.

WHAT CHANGED SINCE THE REJECTION

1. The Soroban contract is now part of this repository.
contracts/keylease-core (Rust, soroban-sdk 29, wasm32v1-none, 411 lines + 311 lines of tests) implements the whole lease model instead of a string registry: init, set_gateway, register_service, set_service_active, quote, create_lease, use_call, revoke, settle, get_lease, get_service, get_config and remaining_calls, with a 14-variant error enum, 7 event topics, per-role require_auth and TTL extension on persistent lease/service entries.

2. Access is prepaid, not recorded.
create_lease transfers calls × price_per_call of the configured SAC token (native XLM on testnet) from the consumer into the contract's escrow in the same transaction, before the lease exists. A lease cannot exist unpaid, and the account that pays is the account whose key signs session tokens.

3. Quota is enforced on chain.
use_call is gateway-authenticated and increments calls_used on chain. Previously quota lived only in the proxy's memory, so running a second proxy doubled a lease's quota. The proxy now batches served calls and commits them with use_call, so every instance reads the same remaining quota and settlement pays for real usage.

4. Escrow has a defined exit.
settle is permissionless once a lease expires or exhausts its calls: the provider receives price_paid × calls_used / calls_limit and the consumer is refunded the remainder, payable at most once. revoke lets the consumer exit early and get the unused calls back immediately. Both are covered by contract tests that assert token balances before and after.

5. The client and proxy were rewritten around the contract ABI.
Lease state is read by simulating get_lease/get_service/quote over Soroban RPC instead of reading a hard-coded storage key, so the client follows the ABI rather than the storage layout, and contract traps map to precise HTTP decisions (Error(Contract, #5) becomes 403 lease_not_found). The CLI gained settle and revoke commands. @stellar/stellar-sdk was upgraded to 17.x because 13.x cannot parse protocol-29 transaction meta, which meant no Soroban transaction could complete at all.

6. It is deployed and exercised on testnet.
Contract: CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC
Wasm sha256: b8c0874e05e61a49e5ea2ac9961289946f14260cc036fb34930440c0bc1a30bd (13,836 bytes)
Escrow token: native SAC CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
Every transaction — upload, create, init, register_service and the first prepaid lease — is listed with hashes in deployments.json.

I then ran the full flow end to end against that deployment: acquired lease 2 (2,000 stroops escrowed, tx 8a31154bc07776a68585f3a1978eee6b8f9aea94653e1df7ad9d5839514302b9), served one request through the proxy (200, x-keylease-calls-remaining: 1), rejected a tampered token (401), and then read calls: 1/2 back from the chain — so a request served by the proxy became on-chain state.

7. Tests and CI grew to cover the new behaviour.
124 tests in total: 14 Rust contract tests against a real registered SAC instance, 58 CLI tests and 52 proxy tests. CI gained a contract job that installs Rust and stellar-cli, runs cargo test, builds the wasm with stellar contract build and uploads the artifact. pnpm build, typecheck, lint and test all pass on the pushed commit.

8. The documentation was corrected rather than expanded.
The README now documents the contract entry points, the escrow and settlement maths, contract error codes, the real testnet addresses and transaction links, and states plainly that the proxy is not yet hosted and the CLI is not yet published.

VERIFYING IT

git clone https://github.com/KeyLease-Security/keylease-gateway
pnpm install && pnpm build && pnpm test          (110 TypeScript tests)
pnpm contract:test                               (14 Rust contract tests)
node packages/cli/dist/index.js status --lease 1 --contract CC2YHTV3ZOFZJGQ5ACJAZRY46JDAF4ZUWOBMFZTSMQAFIW4UOXDA3KRC

The last command reads the deployed lease over Soroban RPC, so the deployment is checkable in one step without trusting this message.

The point of the rework is that the repository is no longer a wrapper around someone else's contract: the product logic, the money flow and the quota enforcement are Soroban code in this repo, deployed and exercised on testnet. I would appreciate a second review.
