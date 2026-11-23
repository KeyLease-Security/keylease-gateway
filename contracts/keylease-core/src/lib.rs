#![no_std]
#![allow(deprecated)]
//! # keylease-core
//!
//! Soroban lease registry that backs the KeyLease gateway. Everything a lease
//! needs to be enforceable lives on chain:
//!
//! * **Services** are registered by their provider with a price per call.
//! * **Leases** are prepaid: `create_lease` pulls the full price
//!   (`calls * price_per_call`) of a SEP-41 / Stellar Asset Contract token from
//!   the consumer into this contract's escrow.
//! * **Quota** is consumed on chain: the registered `gateway` account commits
//!   served calls with `use_call`, so running more than one proxy instance
//!   cannot mint extra quota out of a local counter.
//! * **Settlement** is permissionless once a lease expired or ran out of
//!   calls: the provider is paid for consumed calls and the consumer is
//!   refunded the rest. `revoke` is the consumer's early exit.
//!
//! Amounts are in the token's smallest unit (stroops for the native SAC).

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN,
    ContractExecutable, Env, Symbol, Vec,
};

/// Contract ABI version burned into the wasm. Taken from `Cargo.toml` at
/// compile time so the two can never drift.
///
/// Compatibility policy (semver on the contract ABI):
/// * patch — internal fixes, no change to entry points, types or errors;
/// * minor — additive only (new entry points, views, error variants or
///   events); existing callers keep working;
/// * major — breaking (removed/renamed entry points, changed argument or
///   storage layouts). Clients should refuse a major they do not know.
pub const CONTRACT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Ledgers are ~5s; keep long-lived entries alive for a month at a time.
const DAY_IN_LEDGERS: u32 = 17_280;
/// Extend an entry when it has less than a week of TTL left.
const MIN_TTL: u32 = DAY_IN_LEDGERS * 7;
/// Extend it to a month.
const EXTEND_TO: u32 = DAY_IN_LEDGERS * 30;

/// Largest page `get_consumer_leases` returns. A larger `limit` is clamped to
/// this value, so one call reads at most this many index entries (plus the
/// count) and stays well inside the per-transaction read budget.
pub const MAX_CONSUMER_LEASES_PAGE: u32 = 50;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    UnknownService = 3,
    ServiceInactive = 4,
    LeaseNotFound = 5,
    LeaseInactive = 6,
    LeaseExpired = 7,
    LeaseNotSettleable = 8,
    AlreadySettled = 9,
    InvalidCalls = 10,
    InvalidDuration = 11,
    InvalidPrice = 12,
    InvalidAmount = 13,
    Unauthorized = 14,
    /// `create_lease` was called with the contract itself as consumer.
    InvalidConsumer = 15,
    /// `settle_many` was called with more IDs than `MAX_SETTLE_BATCH`.
    BatchTooLarge = 16,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Config {
    pub admin: Address,
    /// SEP-41 token used for escrow (the native SAC on most deployments).
    pub token: Address,
    /// Account allowed to commit served calls (`use_call`).
    pub gateway: Address,
    pub lease_count: u64,
    /// Emergency switch for new leases. While `true`, `create_lease` fails
    /// with [`Error::Paused`]; existing leases keep being served, revoked and
    /// settled, and escrow is never touched.
    pub paused: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Service {
    pub provider: Address,
    pub service: soroban_sdk::String,
    /// Price of a single API call, in token smallest units.
    pub price_per_call: i128,
    pub active: bool,
    /// Number of leases ever created for this service.
    pub lease_count: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Lease {
    pub id: u64,
    pub service: soroban_sdk::String,
    pub provider: Address,
    pub consumer: Address,
    pub calls_limit: u32,
    pub calls_used: u32,
    /// Unix seconds.
    pub expires_at: u64,
    pub active: bool,
    pub settled: bool,
    /// Escrowed amount in token smallest units.
    pub price_paid: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Config,
    /// Admin nominated by the current admin, awaiting `accept_admin`.
    PendingAdmin,
    Service(soroban_sdk::String),
    Lease(u64),
    /// Number of leases ever created by a consumer (`u32`). Together with
    /// `ConsumerLease` this forms the consumer's append-only lease index.
    ConsumerLeases(Address),
    /// Lease id at zero-based `position` in a consumer's index (`u64`).
    /// One entry per lease keeps `create_lease` O(1) and page reads
    /// O(limit) no matter how many leases a consumer accumulates.
    ConsumerLease(Address, u32),
}

/// Published by `upgrade`: topics `(contract_updated, admin)`, data
/// `new_wasm_hash`. Same wire shape as the other events in this contract.
#[contractevent(topics = ["contract_updated"], data_format = "single-value")]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContractUpdated {
    #[topic]
    pub admin: Address,
    pub new_wasm_hash: BytesN<32>,
}

#[contract]
pub struct KeyleaseCore;

fn config_key() -> DataKey {
    DataKey::Config
}

/// Bump the TTL of an entry that was just read.
///
/// Reads are the hot path (`get_lease` is simulated by the proxy on every
/// request), so an entry that is only ever read must still stay alive.
/// `extend_ttl` is a no-op while the entry is above `MIN_TTL`, so the common
/// case costs one storage access and no write.
fn bump_instance_ttl(env: &Env) {
    env.storage().instance().extend_ttl(MIN_TTL, EXTEND_TO);
}

fn bump_persistent_ttl(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, MIN_TTL, EXTEND_TO);
}

fn load_config(env: &Env) -> Result<Config, Error> {
    let config = env
        .storage()
        .instance()
        .get(&config_key())
        .ok_or(Error::NotInitialized)?;
    bump_instance_ttl(env);
    Ok(config)
}

fn store_config(env: &Env, config: &Config) {
    env.storage().instance().set(&config_key(), config);
    bump_instance_ttl(env);
}

/// Validates that a service identifier is non-empty, at most `MAX_SERVICE_LEN` bytes,
/// and contains only ASCII alphanumeric characters, hyphens, underscores, or dots.
pub fn validate_service_id(service: &soroban_sdk::String) -> Result<(), Error> {
    let len = service.len();
    if !(MIN_SERVICE_LEN..=MAX_SERVICE_LEN).contains(&len) {
        return Err(Error::InvalidService);
    }
    let mut buf = [0u8; MAX_SERVICE_LEN as usize];
    let slice = &mut buf[..len as usize];
    service.copy_into_slice(slice);
    for &b in slice.iter() {
        let is_allowed = matches!(b, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.');
        if !is_allowed {
            return Err(Error::InvalidService);
        }
    }
    Ok(())
}

fn load_service(env: &Env, service: &soroban_sdk::String) -> Result<Service, Error> {
    let key = DataKey::Service(service.clone());
    let stored = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::UnknownService)?;
    bump_persistent_ttl(env, &key);
    Ok(stored)
}

fn load_lease(env: &Env, lease_id: u64) -> Result<Lease, Error> {
    let key = DataKey::Lease(lease_id);
    let lease = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::LeaseNotFound)?;
    bump_persistent_ttl(env, &key);
    Ok(lease)
}

fn store_lease(env: &Env, lease: &Lease) {
    let key = DataKey::Lease(lease.id);
    env.storage().persistent().set(&key, lease);
    bump_persistent_ttl(env, &key);
}

/// Number of entries in `consumer`'s lease index (`0` if they never leased).
fn consumer_lease_count(env: &Env, consumer: &Address) -> u32 {
    let key = DataKey::ConsumerLeases(consumer.clone());
    match env.storage().persistent().get::<_, u32>(&key) {
        Some(count) => {
            bump_persistent_ttl(env, &key);
            count
        }
        None => 0,
    }
}

/// Appends `lease_id` to `consumer`'s index: one new position entry plus the
/// updated count. Runs inside `create_lease`, so it commits or rolls back
/// together with the lease itself.
fn append_consumer_lease(env: &Env, consumer: &Address, lease_id: u64) -> Result<(), Error> {
    let position = consumer_lease_count(env, consumer);
    let next = position.checked_add(1).ok_or(Error::InvalidAmount)?;

    let entry = DataKey::ConsumerLease(consumer.clone(), position);
    env.storage().persistent().set(&entry, &lease_id);
    bump_persistent_ttl(env, &entry);

    let count = DataKey::ConsumerLeases(consumer.clone());
    env.storage().persistent().set(&count, &next);
    bump_persistent_ttl(env, &count);
    Ok(())
}

#[contractimpl]
impl KeyleaseCore {
    /// One-time setup. `token` is the SEP-41 asset used for escrow and
    /// `gateway` the account allowed to commit served calls on chain.
    pub fn init(env: Env, admin: Address, token: Address, gateway: Address) -> Result<(), Error> {
        if env.storage().instance().has(&config_key()) {
            return Err(Error::AlreadyInitialized);
        }
        if admin == gateway {
            return Err(Error::SameAdminAndGateway);
        }
        admin.require_auth();
        store_config(
            &env,
            &Config {
                admin: admin.clone(),
                token,
                gateway,
                lease_count: 0,
                paused: false,
            },
        );
        env.events()
            .publish((Symbol::new(&env, "init"), admin), env.ledger().timestamp());
        Ok(())
    }

    /// Admin-only: rotate the account that commits on-chain quota.
    pub fn set_gateway(env: Env, gateway: Address) -> Result<(), Error> {
        let mut config = load_config(&env)?;
        config.admin.require_auth();
        config.gateway = gateway.clone();
        store_config(&env, &config);
        env.events().publish(
            (Symbol::new(&env, "gateway"), gateway),
            env.ledger().timestamp(),
        );
        Ok(())
    }

    /// Admin-only: pause or resume new leases.
    ///
    /// The pause is deliberately narrow: `create_lease` is rejected with
    /// `Error::Paused` before any tokens move, while `use_call`, `revoke`,
    /// `settle` and every view keep working so prepaid leases can still be
    /// redeemed and paid out. Escrow balances are never modified here.
    ///
    /// Emits `paused` or `unpaused`, topic `(event, admin)`, payload `paused`.
    pub fn set_paused(env: Env, paused: bool) -> Result<bool, Error> {
        let mut config = load_config(&env)?;
        config.admin.require_auth();
        config.paused = paused;
        store_config(&env, &config);
        let event = if paused { "paused" } else { "unpaused" };
        env.events()
            .publish((Symbol::new(&env, event), config.admin.clone()), paused);
        Ok(paused)
    }

    /// Admin-only: nominate the next admin. The handover only takes effect
    /// once the nominee calls `accept_admin`, so a typo in the new address
    /// cannot permanently lock out admin rotation.
    pub fn propose_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        let config = load_config(&env)?;
        config.admin.require_auth();
        env.storage()
            .instance()
            .set(&DataKey::PendingAdmin, &new_admin);
        bump_instance_ttl(&env);
        events::emit_admin_proposed(&env, &config.admin, &new_admin);
        Ok(())
    }

    /// Completes a handover started by `propose_admin`. Requires the nominee's
    /// auth and clears the pending entry, so accepting twice fails with
    /// `Unauthorized` (there is no proposal left to accept).
    pub fn accept_admin(env: Env) -> Result<(), Error> {
        let mut config = load_config(&env)?;
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .ok_or(Error::Unauthorized)?;
        pending.require_auth();
        config.admin = pending.clone();
        env.storage().instance().remove(&DataKey::PendingAdmin);
        store_config(&env, &config);
        events::emit_admin_changed(&env, &pending);
        Ok(())
    }

    /// Admin-only: replace this contract's wasm with `new_wasm_hash`.
    ///
    /// The contract address, its instance storage (config, pending admin) and
    /// every persistent entry (services, leases, consumer lease indexes, and
    /// the escrowed token balance) stay where they are: only the executable
    /// changes. The new wasm must already be uploaded to the ledger, otherwise
    /// the host traps and nothing changes. The swap takes effect once this
    /// invocation completes successfully, so the `contract_updated` event
    /// (`(contract_updated, admin)` topics, `new_wasm_hash` data) is only ever
    /// observed for an upgrade that actually happened.
    ///
    /// Only a plain wasm hash is accepted: executable references are not, so
    /// an upgrade can never hand control of the code to another account.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), Error> {
        let config = load_config(&env)?;
        config.admin.require_auth();
        env.deployer()
            .update_current_contract(ContractExecutable::Wasm(new_wasm_hash.clone()));
        ContractUpdated {
            admin: config.admin,
            new_wasm_hash,
        }
        .publish(&env);
        Ok(())
    }

    /// Provider-only: register a new priced service or re-price your own.
    ///
    /// A service id belongs to the provider that first registered it. Calling
    /// this for an id registered by a *different* provider fails with
    /// `Unauthorized` and leaves the stored service untouched, so nobody can
    /// take over another provider's name, price or future lease payouts. The
    /// owner may call it again to update the price (which also marks the
    /// service active, as before). Existing leases are never touched: each one
    /// snapshots its provider and escrowed price at creation.
    pub fn register_service(
        env: Env,
        provider: Address,
        service: soroban_sdk::String,
        price_per_call: i128,
    ) -> Result<Service, Error> {
        load_config(&env)?;
        provider.require_auth();
        validate_service_id(&service)?;
        if price_per_call <= 0 {
            return Err(Error::InvalidPrice);
        }
        let key = DataKey::Service(service.clone());
        if let Some(existing) = env.storage().persistent().get::<_, Service>(&key) {
            if existing.provider != provider {
                return Err(Error::Unauthorized);
            }
        }
        let stored = Service {
            provider: provider.clone(),
            service: service.clone(),
            price_per_call,
            active: true,
            lease_count,
        };
        env.storage().persistent().set(&key, &stored);
        bump_persistent_ttl(&env, &key);

        if is_new {
            let mut list = load_service_list(&env);
            list.push_back(service.clone());
            store_service_list(&env, &list);
        }

        env.events().publish(
            (Symbol::new(&env, "service_registered"), provider),
            (service, price_per_call),
        );
        Ok(stored)
    }

    /// Returns a paginated list of registered service IDs.
    ///
    /// Service IDs are append-only and returned in registration order.
    /// The page size is clamped to `MAX_SERVICE_PAGE_SIZE = 50`.
    pub fn list_services(
        env: Env,
        start: u32,
        limit: u32,
    ) -> soroban_sdk::Vec<soroban_sdk::String> {
        let list = load_service_list(&env);
        let limit = limit.min(MAX_SERVICE_PAGE_SIZE);
        let total = list.len();
        let mut result = soroban_sdk::Vec::new(&env);
        if start >= total || limit == 0 {
            return result;
        }
        let end = (start + limit).min(total);
        for i in start..end {
            result.push_back(list.get(i).unwrap());
        }
        result
    }

    /// Provider-only: pause or resume a service.
    pub fn set_service_active(
        env: Env,
        provider: Address,
        service: soroban_sdk::String,
        active: bool,
    ) -> Result<Service, Error> {
        load_config(&env)?;
        provider.require_auth();
        let mut stored = load_service(&env, &service)?;
        if stored.provider != provider {
            // Only the account that registered the service may mutate it.
            return Err(Error::Unauthorized);
        }
        stored.active = active;
        let key = DataKey::Service(service);
        env.storage().persistent().set(&key, &stored);
        bump_persistent_ttl(&env, &key);
        Ok(stored)
    }

    /// Price of `calls` calls on `service`, in token smallest units.
    pub fn quote(env: Env, service: soroban_sdk::String, calls: u32) -> Result<i128, Error> {
        if calls == 0 {
            return Err(Error::InvalidCalls);
        }
        let stored = load_service(&env, &service)?;
        stored
            .price_per_call
            .checked_mul(calls as i128)
            .ok_or(Error::InvalidAmount)
    }

    /// Prepays a lease: transfers `calls * price_per_call` from `consumer`
    /// into escrow and returns the new lease id.
    ///
    /// The consumer may not be this contract: escrow would move from the
    /// contract to itself and the refund could never reach a real account
    /// (`InvalidConsumer`). The admin and gateway are deliberately allowed —
    /// they are ordinary accounts that can receive refunds, and an operator
    /// leasing their own service for smoke tests is a legitimate use.
    pub fn create_lease(
        env: Env,
        consumer: Address,
        service: soroban_sdk::String,
        calls: u32,
        duration: u64,
    ) -> Result<u64, Error> {
        if consumer == env.current_contract_address() {
            return Err(Error::InvalidConsumer);
        }
        consumer.require_auth();
        if calls == 0 || calls > MAX_CALLS {
            return Err(Error::InvalidCalls);
        }
        if duration == 0 || duration > MAX_LEASE_DURATION {
            return Err(Error::InvalidDuration);
        }
        let expires_at = env
            .ledger()
            .timestamp()
            .checked_add(duration)
            .ok_or(Error::InvalidDuration)?;

        let mut config = load_config(&env)?;
        let mut stored = load_service(&env, &service)?;
        if !stored.active {
            return Err(Error::ServiceInactive);
        }
        stored.lease_count = stored.lease_count.saturating_add(1);
        let service_key = DataKey::Service(service.clone());
        env.storage().persistent().set(&service_key, &stored);
        bump_persistent_ttl(&env, &service_key);

        let amount = stored
            .price_per_call
            .checked_mul(calls as i128)
            .ok_or(Error::InvalidAmount)?;

        let contract_address = env.current_contract_address();
        token::Client::new(&env, &config.token).transfer(&consumer, &contract_address, &amount);

        let id = config.lease_count + 1;
        config.lease_count = id;
        store_config(&env, &config);

        let lease = Lease {
            id,
            service: service.clone(),
            provider: stored.provider,
            consumer: consumer.clone(),
            calls_limit: calls,
            calls_used: 0,
            expires_at,
            active: true,
            settled: false,
            price_paid: amount,
        };
        store_lease(&env, &lease);
        append_consumer_lease(&env, &consumer, id)?;

        env.events().publish(
            (Symbol::new(&env, "lease_created"), consumer, id),
            (service, calls, amount),
        );
        Ok(id)
    }

    /// Gateway-only: commit `count` served calls against a lease. Committing
    /// more calls than are left clamps at `calls_limit` instead of overflowing.
    ///
    /// The `calls_committed` event keeps its
    /// `(calls_committed, consumer, lease_id)` topic tuple and publishes
    /// `(1, calls_used, remaining)` so indexers do not need a second read.
    pub fn use_call(env: Env, lease_id: u64, count: u32) -> Result<Lease, Error> {
        let config = load_config(&env)?;
        config.gateway.require_auth();
        if count == 0 {
            return Err(Error::InvalidCalls);
        }

        let mut lease = load_lease(&env, lease_id)?;
        if !lease.active || lease.settled {
            return Err(Error::LeaseInactive);
        }
        if lease.expires_at <= env.ledger().timestamp() {
            return Err(Error::LeaseExpired);
        }

        lease.calls_used = lease
            .calls_used
            .saturating_add(count)
            .min(lease.calls_limit);
        store_lease(&env, &lease);
        let remaining = lease.calls_limit.saturating_sub(lease.calls_used);
        env.events().publish(
            (
                Symbol::new(&env, "calls_committed"),
                lease.consumer.clone(),
                lease_id,
            ),
            (lease.calls_used, remaining),
        );
        Ok(lease)
    }

    /// Consumer-only: end a lease early and refund the unused calls.
    pub fn revoke(env: Env, lease_id: u64) -> Result<Lease, Error> {
        let mut lease = load_lease(&env, lease_id)?;
        lease.consumer.require_auth();
        if lease.settled {
            return Err(Error::AlreadySettled);
        }
        let config = load_config(&env)?;
        let (_payable, refund) =
            calculate_payout(lease.price_paid, lease.calls_used, lease.calls_limit);

        if refund > 0 {
            let contract_address = env.current_contract_address();
            token::Client::new(&env, &config.token).transfer(
                &contract_address,
                &lease.consumer,
                &refund,
            );
        }

        lease.active = false;
        lease.settled = true;
        store_lease(&env, &lease);
        env.events().publish(
            (
                Symbol::new(&env, "lease_revoked"),
                lease.consumer.clone(),
                lease_id,
            ),
            refund,
        );
        Ok(lease)
    }

    /// Consumer exit for expired leases: refunds unused calls and closes the lease.
    pub fn revoke_expired_lease(env: Env, lease_id: u64) -> Result<Lease, Error> {
        let lease = load_lease(&env, lease_id)?;
        if lease.expires_at > env.ledger().timestamp() {
            return Err(Error::LeaseNotSettleable);
        }
        Self::revoke(env, lease_id)
    }

    /// Permissionless: settle an expired or exhausted lease. The provider is
    /// paid for consumed calls, the consumer gets the remainder back.
    pub fn settle(env: Env, lease_id: u64) -> Result<Lease, Error> {
        let mut lease = load_lease(&env, lease_id)?;
        if lease.settled {
            return Err(Error::AlreadySettled);
        }
        let expired = lease.expires_at <= env.ledger().timestamp();
        let exhausted = lease.calls_used >= lease.calls_limit;
        if lease.active && !expired && !exhausted {
            return Err(Error::LeaseNotSettleable);
        }

        let config = load_config(&env)?;
        let token_client = token::Client::new(&env, &config.token);
        let escrow = env.current_contract_address();

        let (payable, refund) =
            calculate_payout(lease.price_paid, lease.calls_used, lease.calls_limit);

        if payable > 0 {
            token_client.transfer(&escrow, &lease.provider, &payable);
        }
        if refund > 0 {
            token_client.transfer(&escrow, &lease.consumer, &refund);
        }

        lease.active = false;
        lease.settled = true;
        store_lease(&env, &lease);
        env.events().publish(
            (
                Symbol::new(&env, "lease_settled"),
                lease.provider.clone(),
                lease_id,
            ),
            (payable, refund),
        );
        Ok(lease)
    }

    /// Permissionless: settle a batch of expired or exhausted leases.
    ///
    /// Bounded by `MAX_SETTLE_BATCH = 50`. Returns a list of settled leases.
    /// Leases that are not yet settleable (active and unexpired) or already
    /// settled are skipped so valid settlements in the batch still succeed.
    pub fn settle_many(
        env: Env,
        ids: soroban_sdk::Vec<u64>,
    ) -> Result<soroban_sdk::Vec<Lease>, Error> {
        if ids.len() > MAX_SETTLE_BATCH {
            return Err(Error::BatchTooLarge);
        }
        let mut settled = soroban_sdk::Vec::new(&env);
        for id in ids.iter() {
            if let Ok(lease) = Self::settle(env.clone(), id) {
                settled.push_back(lease);
            }
        }
        Ok(settled)
    }

    /// Live lease state.
    pub fn get_lease(env: Env, lease_id: u64) -> Result<Lease, Error> {
        load_lease(&env, lease_id)
    }

    /// Registered service, including its price per call.
    pub fn get_service(env: Env, service: soroban_sdk::String) -> Result<Service, Error> {
        load_service(&env, &service)
    }

    /// One page of the lease ids `consumer` created, oldest first.
    ///
    /// * Ordering: ascending creation order, which is also ascending lease id.
    ///   The index is append-only, so a page never shifts once written.
    /// * `start` is a zero-based offset into that list; `limit` is the page
    ///   size. A `limit` above `MAX_CONSUMER_LEASES_PAGE` is clamped to it, and
    ///   `limit == 0` or a `start` at or past the end returns an empty page.
    ///   To walk everything, keep calling with `start += page.len()` until a
    ///   page comes back shorter than the requested (clamped) limit.
    /// * Settled and revoked leases stay listed; read `get_lease` for status.
    pub fn get_consumer_leases(env: Env, consumer: Address, start: u32, limit: u32) -> Vec<u64> {
        let mut page = Vec::new(&env);
        let total = consumer_lease_count(&env, &consumer);
        if start >= total {
            return page;
        }
        let end = start
            .saturating_add(limit.min(MAX_CONSUMER_LEASES_PAGE))
            .min(total);
        for position in start..end {
            let key = DataKey::ConsumerLease(consumer.clone(), position);
            if let Some(id) = env.storage().persistent().get::<_, u64>(&key) {
                bump_persistent_ttl(&env, &key);
                page.push_back(id);
            }
        }
        page
    }

    /// Contract configuration plus the number of leases ever created.
    pub fn get_config(env: Env) -> Result<Config, Error> {
        load_config(&env)
    }

    /// Contract ABI version (the crate version, e.g. `"0.2.0"`). Works before
    /// `init`, so deploy verification can check it in one simulated call.
    pub fn version(env: Env) -> soroban_sdk::String {
        soroban_sdk::String::from_str(&env, CONTRACT_VERSION)
    }

    /// Calls left on a lease (`0` for unknown or settled leases).
    pub fn remaining_calls(env: Env, lease_id: u64) -> u32 {
        match load_lease(&env, lease_id) {
            Ok(lease) if lease.active && !lease.settled => {
                lease.calls_limit.saturating_sub(lease.calls_used)
            }
            _ => 0,
        }
    }
}

#[cfg(test)]
mod test;
