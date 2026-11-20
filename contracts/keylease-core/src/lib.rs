#![no_std]
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
    contract, contracterror, contractimpl, contracttype, token, Address, Env, Symbol,
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

/// Minimum allowed service identifier length in characters/bytes.
pub const MIN_SERVICE_LEN: u32 = 1;
/// Maximum allowed service identifier length in characters/bytes.
pub const MAX_SERVICE_LEN: u32 = 64;

/// Minimum allowed lease duration in seconds (1 second).
pub const MIN_LEASE_DURATION: u64 = 1;
/// Maximum allowed lease duration in seconds (365 days).
pub const MAX_LEASE_DURATION: u64 = 365 * 24 * 3600;

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
    /// `register_service` was called with an invalid service id (length or charset).
    InvalidService = 16,
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
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Service {
    pub provider: Address,
    pub service: soroban_sdk::String,
    /// Price of a single API call, in token smallest units.
    pub price_per_call: i128,
    pub active: bool,
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
    env.storage().persistent().extend_ttl(key, MIN_TTL, EXTEND_TO);
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

#[contractimpl]
impl KeyleaseCore {
    /// One-time setup. `token` is the SEP-41 asset used for escrow and
    /// `gateway` the account allowed to commit served calls on chain.
    pub fn init(env: Env, admin: Address, token: Address, gateway: Address) -> Result<(), Error> {
        if env.storage().instance().has(&config_key()) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        store_config(
            &env,
            &Config {
                admin: admin.clone(),
                token,
                gateway,
                lease_count: 0,
            },
        );
        env.events().publish(
            (Symbol::new(&env, "init"), admin),
            env.ledger().timestamp(),
        );
        Ok(())
    }

    /// Admin-only: rotate the account that commits on-chain quota.
    pub fn set_gateway(env: Env, gateway: Address) -> Result<(), Error> {
        let mut config = load_config(&env)?;
        config.admin.require_auth();
        config.gateway = gateway.clone();
        store_config(&env, &config);
        env.events()
            .publish((Symbol::new(&env, "gateway"), gateway), env.ledger().timestamp());
        Ok(())
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
        env.events().publish(
            (Symbol::new(&env, "admin_proposed"), config.admin, new_admin),
            env.ledger().timestamp(),
        );
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
        env.events().publish(
            (Symbol::new(&env, "admin_changed"), pending),
            env.ledger().timestamp(),
        );
        Ok(())
    }

    /// Provider-only: register or update a priced service.
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
        let stored = Service {
            provider: provider.clone(),
            service: service.clone(),
            price_per_call,
            active: true,
        };
        let key = DataKey::Service(service.clone());
        env.storage().persistent().set(&key, &stored);
        bump_persistent_ttl(&env, &key);
        env.events().publish(
            (Symbol::new(&env, "service_registered"), provider),
            (service, price_per_call),
        );
        Ok(stored)
    }

    /// Provider-only: pause or resume a service.
    pub fn set_service_active(
        env: Env,
        provider: Address,
        service: soroban_sdk::String,
        active: bool,
    ) -> Result<Service, Error> {
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
        if calls == 0 {
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
        let stored = load_service(&env, &service)?;
        if !stored.active {
            return Err(Error::ServiceInactive);
        }

        let amount = stored
            .price_per_call
            .checked_mul(calls as i128)
            .ok_or(Error::InvalidAmount)?;

        token::Client::new(&env, &config.token).transfer(
            &consumer,
            &env.current_contract_address(),
            &amount,
        );

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
    /// `(calls_used, remaining)` so indexers do not need a second read.
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

        lease.calls_used = lease.calls_used.saturating_add(count).min(lease.calls_limit);
        store_lease(&env, &lease);
        let remaining = lease.calls_limit.saturating_sub(lease.calls_used);
        env.events().publish(
            (Symbol::new(&env, "calls_committed"), lease.consumer.clone(), lease_id),
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
        let refund = lease.price_paid
            * (lease.calls_limit.saturating_sub(lease.calls_used) as i128)
            / (lease.calls_limit as i128);

        if refund > 0 {
            token::Client::new(&env, &config.token).transfer(
                &env.current_contract_address(),
                &lease.consumer,
                &refund,
            );
        }

        lease.active = false;
        lease.settled = true;
        store_lease(&env, &lease);
        env.events().publish(
            (Symbol::new(&env, "lease_revoked"), lease.consumer.clone(), lease_id),
            refund,
        );
        Ok(lease)
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

        let payable = lease.price_paid * (lease.calls_used as i128) / (lease.calls_limit as i128);
        let refund = lease.price_paid - payable;

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
            (Symbol::new(&env, "lease_settled"), lease.provider.clone(), lease_id),
            (payable, refund),
        );
        Ok(lease)
    }

    /// Live lease state.
    pub fn get_lease(env: Env, lease_id: u64) -> Result<Lease, Error> {
        load_lease(&env, lease_id)
    }

    /// Registered service, including its price per call.
    pub fn get_service(env: Env, service: soroban_sdk::String) -> Result<Service, Error> {
        load_service(&env, &service)
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
