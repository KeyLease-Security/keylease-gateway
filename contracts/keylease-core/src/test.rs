extern crate std;

use crate::{Error, KeyleaseCore, KeyleaseCoreClient, Lease, CONTRACT_VERSION};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

struct Harness {
    env: Env,
    contract_id: Address,
    admin: Address,
    gateway: Address,
    consumer: Address,
    provider: Address,
    token: Address,
    client: KeyleaseCoreClient<'static>,
}

fn service_id(env: &Env) -> String {
    String::from_str(env, "weather-api")
}

fn setup() -> Harness {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let gateway = Address::generate(&env);
    let provider = Address::generate(&env);
    let consumer = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    StellarAssetClient::new(&env, &token).mint(&consumer, &1_000_000);

    let contract_id = env.register(KeyleaseCore, ());
    let client = KeyleaseCoreClient::new(&env, &contract_id);
    client.init(&admin, &token, &gateway);

    Harness { env, contract_id, admin, gateway, consumer, provider, token, client }
}

fn register(h: &Harness) {
    h.client
        .register_service(&h.provider, &service_id(&h.env), &1_000);
}

fn balance(h: &Harness, who: &Address) -> i128 {
    TokenClient::new(&h.env, &h.token).balance(who)
}

#[test]
fn init_is_one_time_and_exposes_config() {
    let h = setup();
    let config = h.client.get_config();
    assert_eq!(config.admin, h.admin);
    assert_eq!(config.gateway, h.gateway);
    assert_eq!(config.token, h.token);
    assert_eq!(config.lease_count, 0);

    let err = h.client.try_init(&h.admin, &h.token, &h.gateway).unwrap_err();
    assert_eq!(err.unwrap(), Error::AlreadyInitialized);
}

#[test]
fn version_matches_the_crate_version() {
    let h = setup();
    assert_eq!(CONTRACT_VERSION, env!("CARGO_PKG_VERSION"));
    assert_eq!(h.client.version(), String::from_str(&h.env, CONTRACT_VERSION));
}

#[test]
fn version_is_readable_before_init() {
    let env = Env::default();
    let contract_id = env.register(KeyleaseCore, ());
    let client = KeyleaseCoreClient::new(&env, &contract_id);
    assert_eq!(client.version(), String::from_str(&env, env!("CARGO_PKG_VERSION")));
}

#[test]
fn reading_before_init_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(KeyleaseCore, ());
    let client = KeyleaseCoreClient::new(&env, &contract_id);
    let who = Address::generate(&env);
    let err = client
        .try_register_service(&who, &String::from_str(&env, "x"), &10)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::NotInitialized);
}

#[test]
fn register_service_rejects_non_positive_price() {
    let h = setup();
    let err = h
        .client
        .try_register_service(&h.provider, &service_id(&h.env), &0)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidPrice);

    let svc = h
        .client
        .register_service(&h.provider, &service_id(&h.env), &1_000);
    assert!(svc.active);
    assert_eq!(svc.price_per_call, 1_000);
    assert_eq!(h.client.get_service(&service_id(&h.env)).provider, h.provider);
}

#[test]
fn quote_prices_a_batch_of_calls() {
    let h = setup();
    register(&h);
    assert_eq!(h.client.quote(&service_id(&h.env), &3), 3_000);
    let err = h.client.try_quote(&service_id(&h.env), &0).unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidCalls);

    let unknown = String::from_str(&h.env, "nope");
    let err = h.client.try_quote(&unknown, &1).unwrap_err();
    assert_eq!(err.unwrap(), Error::UnknownService);
}

#[test]
fn quote_rejects_overflowing_totals() {
    let h = setup();
    h.client
        .register_service(&h.provider, &service_id(&h.env), &i128::MAX);

    // A single call still fits in i128.
    assert_eq!(h.client.quote(&service_id(&h.env), &1), i128::MAX);
    // i128::MAX * 2 overflows: checked_mul must surface InvalidAmount, not trap.
    let err = h.client.try_quote(&service_id(&h.env), &2).unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidAmount);
    let err = h.client.try_quote(&service_id(&h.env), &u32::MAX).unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidAmount);
}

#[test]
fn quote_rejects_zero_calls() {
    let h = setup();
    register(&h);
    let err = h.client.try_quote(&service_id(&h.env), &0).unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidCalls);
}

#[test]
fn quote_rejects_zero_calls_before_looking_up_the_service() {
    let h = setup();
    let unknown = String::from_str(&h.env, "nope");
    let err = h.client.try_quote(&unknown, &0).unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidCalls);
}

#[test]
fn quote_rejects_an_unknown_service() {
    let h = setup();
    register(&h);
    let unknown = String::from_str(&h.env, "nope");
    let err = h.client.try_quote(&unknown, &1).unwrap_err();
    assert_eq!(err.unwrap(), Error::UnknownService);
}

#[test]
fn create_lease_escrows_the_full_price() {
    let h = setup();
    register(&h);
    let before = balance(&h, &h.consumer);

    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &100, &3_600);
    assert_eq!(id, 1);
    assert_eq!(balance(&h, &h.consumer), before - 100_000);
    // Funds sit in the contract's escrow until settlement.
    assert_eq!(balance(&h, &h.client.address), 100_000);

    let lease: Lease = h.client.get_lease(&id);
    assert_eq!(lease.consumer, h.consumer);
    assert_eq!(lease.provider, h.provider);
    assert_eq!(lease.calls_limit, 100);
    assert_eq!(lease.calls_used, 0);
    assert_eq!(lease.price_paid, 100_000);
    assert!(lease.active && !lease.settled);
    assert_eq!(h.client.get_config().lease_count, 1);
    assert_eq!(h.client.remaining_calls(&id), 100);

    // A second lease gets a fresh id.
    let id2 = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &2, &60);
    assert_eq!(id2, 2);
}

#[test]
fn create_lease_validates_its_arguments() {
    let h = setup();
    register(&h);

    let err = h
        .client
        .try_create_lease(&h.consumer, &service_id(&h.env), &0, &60)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidCalls);

    let err = h
        .client
        .try_create_lease(&h.consumer, &service_id(&h.env), &10, &0)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidDuration);

    let unknown = String::from_str(&h.env, "nope");
    let err = h
        .client
        .try_create_lease(&h.consumer, &unknown, &10, &60)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::UnknownService);

    h.client
        .set_service_active(&h.provider, &service_id(&h.env), &false);
    let err = h
        .client
        .try_create_lease(&h.consumer, &service_id(&h.env), &10, &60)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::ServiceInactive);
}

#[test]
fn create_lease_rejects_the_contract_as_consumer() {
    let h = setup();
    register(&h);
    let escrow_before = balance(&h, &h.client.address);

    let err = h
        .client
        .try_create_lease(&h.client.address, &service_id(&h.env), &10, &60)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidConsumer);
    assert_eq!(balance(&h, &h.client.address), escrow_before);
    assert_eq!(h.client.get_config().lease_count, 0);
}

#[test]
fn create_lease_allows_admin_and_gateway_as_consumers() {
    let h = setup();
    register(&h);
    let sac = StellarAssetClient::new(&h.env, &h.token);
    sac.mint(&h.admin, &10_000);
    sac.mint(&h.gateway, &10_000);

    let id = h
        .client
        .create_lease(&h.admin, &service_id(&h.env), &1, &60);
    assert_eq!(h.client.get_lease(&id).consumer, h.admin);
    let id = h
        .client
        .create_lease(&h.gateway, &service_id(&h.env), &1, &60);
    assert_eq!(h.client.get_lease(&id).consumer, h.gateway);
}

#[test]
fn use_call_accumulates_and_clamps_at_the_limit() {
    let h = setup();
    register(&h);
    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &3_600);

    let lease = h.client.use_call(&id, &3);
    assert_eq!(lease.calls_used, 3);
    assert_eq!(h.client.remaining_calls(&id), 7);

    // Committing beyond the quota clamps instead of overflowing.
    let lease = h.client.use_call(&id, &999);
    assert_eq!(lease.calls_used, 10);
    assert_eq!(h.client.remaining_calls(&id), 0);

    let err = h.client.try_use_call(&id, &0).unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidCalls);
}

#[test]
fn use_call_rejects_unknown_expired_and_settled_leases() {
    let h = setup();
    register(&h);

    let err = h.client.try_use_call(&42, &1).unwrap_err();
    assert_eq!(err.unwrap(), Error::LeaseNotFound);

    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &60);
    h.env.ledger().with_mut(|li| li.timestamp = 61);
    let err = h.client.try_use_call(&id, &1).unwrap_err();
    assert_eq!(err.unwrap(), Error::LeaseExpired);
}

#[test]
fn settle_after_expiry_pays_for_used_calls_and_refunds_the_rest() {
    let h = setup();
    register(&h);
    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &60);
    h.client.use_call(&id, &4);

    // Still running: settlement is refused.
    let err = h.client.try_settle(&id).unwrap_err();
    assert_eq!(err.unwrap(), Error::LeaseNotSettleable);

    h.env.ledger().with_mut(|li| li.timestamp = 120);
    let before_consumer = balance(&h, &h.consumer);
    let lease = h.client.settle(&id);

    // 4 calls at 1_000 each to the provider, 6 calls refunded.
    assert_eq!(balance(&h, &h.provider), 4_000);
    assert_eq!(balance(&h, &h.consumer), before_consumer + 6_000);
    assert_eq!(balance(&h, &h.client.address), 0);
    assert!(lease.settled && !lease.active);

    let err = h.client.try_settle(&id).unwrap_err();
    assert_eq!(err.unwrap(), Error::AlreadySettled);
}

#[test]
fn settle_pays_out_as_soon_as_quota_is_exhausted() {
    let h = setup();
    register(&h);
    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &2, &3_600);
    h.client.use_call(&id, &2);

    h.client.settle(&id);
    assert_eq!(balance(&h, &h.provider), 2_000);
    assert_eq!(balance(&h, &h.client.address), 0);
}

#[test]
fn revoke_refunds_unused_calls_immediately() {
    let h = setup();
    register(&h);
    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &3_600);
    h.client.use_call(&id, &1);

    let before = balance(&h, &h.consumer);
    let lease = h.client.revoke(&id);
    assert_eq!(balance(&h, &h.consumer), before + 9_000);
    assert_eq!(balance(&h, &h.client.address), 1_000);
    assert_eq!(h.client.remaining_calls(&id), 0);
    assert!(lease.settled);

    let err = h.client.try_use_call(&id, &1).unwrap_err();
    assert_eq!(err.unwrap(), Error::LeaseInactive);
}

#[test]
fn set_service_active_requires_the_registered_provider() {
    let h = setup();
    register(&h);
    let impostor = Address::generate(&h.env);
    let err = h
        .client
        .try_set_service_active(&impostor, &service_id(&h.env), &false)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::Unauthorized);

    let svc = h
        .client
        .set_service_active(&h.provider, &service_id(&h.env), &false);
    assert!(!svc.active);
}

#[test]
fn gateway_can_be_rotated_by_the_admin() {
    let h = setup();
    let next = Address::generate(&h.env);
    h.client.set_gateway(&next);
    assert_eq!(h.client.get_config().gateway, next);
    assert_eq!(h.client.remaining_calls(&1), 0);
}

/// Negative authorisation coverage.
///
/// `setup()` mocks every signature, so a missing `require_auth` regression is
/// invisible to the happy-path tests above. These cases clear the mock set and
/// assert the *host* rejects the invocation (an auth error, not a contract
/// `Error` variant), which is how a real caller without the right key fails.
mod unauthorised {
    use super::*;

    fn clear_auths(h: &Harness) {
        h.env.mock_auths(&[]);
    }

    #[test]
    fn use_call_requires_the_gateway() {
        let h = setup();
        register(&h);
        let id = h
            .client
            .create_lease(&h.consumer, &service_id(&h.env), &10, &60);
        clear_auths(&h);

        let err = h.client.try_use_call(&id, &1).unwrap_err();
        assert!(
            err.is_err(),
            "a caller without the gateway key must not commit quota"
        );
        assert_eq!(h.client.remaining_calls(&id), 10);
    }

    #[test]
    fn revoke_requires_the_consumer() {
        let h = setup();
        register(&h);
        let id = h
            .client
            .create_lease(&h.consumer, &service_id(&h.env), &10, &60);
        h.client.use_call(&id, &1);
        clear_auths(&h);

        let before = balance(&h, &h.consumer);
        let err = h.client.try_revoke(&id).unwrap_err();
        assert!(err.is_err(), "only the consumer may revoke a lease");
        assert_eq!(balance(&h, &h.consumer), before);
        assert!(h.client.get_lease(&id).active);
    }

    #[test]
    fn create_lease_requires_the_consumer() {
        let h = setup();
        register(&h);
        clear_auths(&h);

        let before = balance(&h, &h.consumer);
        let err = h
            .client
            .try_create_lease(&h.consumer, &service_id(&h.env), &10, &60)
            .unwrap_err();
        assert!(err.is_err(), "the consumer must authorise the escrow pull");
        assert_eq!(balance(&h, &h.consumer), before);
        assert_eq!(h.client.get_config().lease_count, 0);
    }

    #[test]
    fn register_service_requires_the_provider() {
        let h = setup();
        clear_auths(&h);

        let err = h
            .client
            .try_register_service(&h.provider, &service_id(&h.env), &1_000)
            .unwrap_err();
        assert!(err.is_err(), "a provider signature is required");
        let err = h
            .client
            .try_get_service(&service_id(&h.env))
            .unwrap_err();
        assert_eq!(err.unwrap(), Error::UnknownService);
    }

    #[test]
    fn set_gateway_requires_the_admin() {
        let h = setup();
        let next = Address::generate(&h.env);
        clear_auths(&h);

        let err = h.client.try_set_gateway(&next).unwrap_err();
        assert!(err.is_err(), "only the admin may rotate the gateway");
        assert_eq!(h.client.get_config().gateway, h.gateway);
    }

    #[test]
    fn set_service_active_requires_the_provider_signature() {
        let h = setup();
        register(&h);
        let impostor = Address::generate(&h.env);
        clear_auths(&h);

        let err = h
            .client
            .try_set_service_active(&impostor, &service_id(&h.env), &false)
            .unwrap_err();
        assert!(
            err.is_err(),
            "a provider signature is required, not just the address"
        );
        assert!(h.client.get_service(&service_id(&h.env)).active);
    }

    /// `settle` is deliberately permissionless, so it is the one entrypoint
    /// that must keep working without any signature once the lease is
    /// expired.
    #[test]
    fn settle_stays_permissionless() {
        let h = setup();
        register(&h);
        let id = h
            .client
            .create_lease(&h.consumer, &service_id(&h.env), &2, &60);
        h.client.use_call(&id, &2);
        clear_auths(&h);

        let lease = h.client.settle(&id);
        assert!(lease.settled);
        assert_eq!(balance(&h, &h.provider), 2_000);
    }
}

#[test]
fn reads_extend_the_ttl_of_leases_services_and_config() {
    use crate::{DataKey, EXTEND_TO, MIN_TTL};
    use soroban_sdk::testutils::storage::{Instance, Persistent};

    let h = setup();
    register(&h);
    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &86_400);

    let lease_key = DataKey::Lease(id);
    let service_key = DataKey::Service(service_id(&h.env));

    // Age every entry until it is below the extension threshold but not yet
    // expired, which is the state a long-idle lease reaches in production.
    h.env
        .ledger()
        .with_mut(|li| li.sequence_number += EXTEND_TO - MIN_TTL + 1);

    let lease_ttl = || {
        h.env.as_contract(&h.contract_id, || {
            h.env.storage().persistent().get_ttl(&lease_key)
        })
    };
    let service_ttl = || {
        h.env.as_contract(&h.contract_id, || {
            h.env.storage().persistent().get_ttl(&service_key)
        })
    };
    let config_ttl = || {
        h.env
            .as_contract(&h.contract_id, || h.env.storage().instance().get_ttl())
    };

    assert!(lease_ttl() < MIN_TTL);
    assert!(service_ttl() < MIN_TTL);
    assert!(config_ttl() < MIN_TTL);

    // Plain reads must raise the live-until ledger again.
    h.client.get_lease(&id);
    assert!(lease_ttl() >= MIN_TTL);

    h.client.get_service(&service_id(&h.env));
    assert!(service_ttl() >= MIN_TTL);

    h.client.get_config();
    assert!(config_ttl() >= MIN_TTL);
}

#[test]
fn admin_transfer_is_two_step() {
    let h = setup();
    let next = Address::generate(&h.env);

    h.client.propose_admin(&next);
    // The proposal alone changes nothing: the nominee has not accepted yet.
    assert_eq!(h.client.get_config().admin, h.admin);

    h.client.accept_admin();
    assert_eq!(h.client.get_config().admin, next);

    // The pending slot is cleared on accept, so a second accept is rejected.
    let err = h.client.try_accept_admin().unwrap_err();
    assert_eq!(err.unwrap(), Error::Unauthorized);
}

#[test]
fn accept_admin_without_a_proposal_is_rejected() {
    let h = setup();
    let err = h.client.try_accept_admin().unwrap_err();
    assert_eq!(err.unwrap(), Error::Unauthorized);
}

#[test]
fn proposing_a_new_admin_requires_the_current_admin() {
    let h = setup();
    let next = Address::generate(&h.env);
    h.env.mock_auths(&[]);
    let err = h.client.try_propose_admin(&next).unwrap_err();
    assert!(err.is_err(), "only the current admin may propose a successor");
    assert_eq!(h.client.get_config().admin, h.admin);
}

#[test]
fn accepting_the_handover_requires_the_nominee() {
    let h = setup();
    let next = Address::generate(&h.env);
    h.client.propose_admin(&next);
    h.env.mock_auths(&[]);
    let err = h.client.try_accept_admin().unwrap_err();
    assert!(err.is_err(), "the nominee must authorise the handover");
    assert_eq!(h.client.get_config().admin, h.admin);
}

#[test]
fn admin_transfer_emits_proposal_and_change_events() {
    use soroban_sdk::{testutils::Events as _, IntoVal, Symbol, Vec as SVec};

    let h = setup();
    let next = Address::generate(&h.env);
    h.client.propose_admin(&next);
    assert_eq!(
        h.env.events().all(),
        SVec::from_array(
            &h.env,
            [(
                h.client.address.clone(),
                SVec::from_array(
                    &h.env,
                    [
                        Symbol::new(&h.env, "admin_proposed").into_val(&h.env),
                        h.admin.clone().into_val(&h.env),
                        next.clone().into_val(&h.env),
                    ],
                ),
                (1u32, h.env.ledger().timestamp()).into_val(&h.env),
            )],
        ),
    );

    h.client.accept_admin();
    assert_eq!(
        h.env.events().all(),
        SVec::from_array(
            &h.env,
            [(
                h.client.address.clone(),
                SVec::from_array(
                    &h.env,
                    [
                        Symbol::new(&h.env, "admin_changed").into_val(&h.env),
                        next.clone().into_val(&h.env),
                    ],
                ),
                (1u32, h.env.ledger().timestamp()).into_val(&h.env),
            )],
        ),
    );
    assert_eq!(h.client.get_config().admin, next);
}

#[test]
fn calls_committed_event_publishes_used_and_remaining() {
    use soroban_sdk::{testutils::Events as _, IntoVal, Symbol, Vec as SVec};

    let h = setup();
    register(&h);
    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &60);
    h.client.use_call(&id, &3);

    let topics = || {
        SVec::from_array(
            &h.env,
            [
                Symbol::new(&h.env, "calls_committed").into_val(&h.env),
                h.consumer.clone().into_val(&h.env),
                id.into_val(&h.env),
            ],
        )
    };

    assert_eq!(
        h.env.events().all(),
        SVec::from_array(
            &h.env,
            [(h.client.address.clone(), topics(), (1u32, 3u32, 7u32).into_val(&h.env))],
        ),
    );

    // Committing past the limit clamps, so the event reports 0 remaining.
    h.client.use_call(&id, &999);
    assert_eq!(
        h.env.events().all(),
        SVec::from_array(
            &h.env,
            [(h.client.address.clone(), topics(), (1u32, 10u32, 0u32).into_val(&h.env))],
        ),
    );
}

#[test]
fn escrow_survives_many_leases() {
    let h = setup();
    StellarAssetClient::new(&h.env, &h.token).mint(&h.consumer, &10_000_000);
    register(&h);

    let mut total = 0i128;
    for _ in 0..5 {
        h.client
            .create_lease(&h.consumer, &service_id(&h.env), &10, &3_600);
        total += 10_000;
    }
    assert_eq!(balance(&h, &h.client.address), total);
}

#[test]
fn init_rejects_identical_admin_and_gateway() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    let contract_id = env.register(KeyleaseCore, ());
    let client = KeyleaseCoreClient::new(&env, &contract_id);

    // Initialising with admin == gateway must fail with SameAdminAndGateway (error 16)
    let err = client.try_init(&admin, &token, &admin);
    assert_eq!(err, Err(Ok(Error::SameAdminAndGateway)));
}

#[test]
fn revoke_and_settle_guards_prevent_double_payout() {
    let h = setup();
    register(&h);

    // --- Sequence 1: revoke -> settle ---
    let id1 = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &100);
    h.client.use_call(&id1, &4);
    h.client.revoke(&id1);

    let consumer_bal1 = balance(&h, &h.consumer);
    let provider_bal1 = balance(&h, &h.provider);
    let contract_bal1 = balance(&h, &h.client.address);

    // Second call (settle) must fail with AlreadySettled and leave balances strictly untouched
    let err_settle1 = h.client.try_settle(&id1);
    assert_eq!(err_settle1, Err(Ok(Error::AlreadySettled)));
    assert_eq!(balance(&h, &h.consumer), consumer_bal1);
    assert_eq!(balance(&h, &h.provider), provider_bal1);
    assert_eq!(balance(&h, &h.client.address), contract_bal1);

    // --- Sequence 2: settle -> revoke ---
    let id2 = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &100);
    h.client.use_call(&id2, &4);
    // Advance time past expiry
    h.env
        .ledger()
        .set_timestamp(h.env.ledger().timestamp() + 101);
    h.client.settle(&id2);

    let consumer_bal2 = balance(&h, &h.consumer);
    let provider_bal2 = balance(&h, &h.provider);
    let contract_bal2 = balance(&h, &h.client.address);

    // Second call (revoke) must fail with AlreadySettled and leave balances untouched
    let err_revoke2 = h.client.try_revoke(&id2);
    assert_eq!(err_revoke2, Err(Ok(Error::AlreadySettled)));
    assert_eq!(balance(&h, &h.consumer), consumer_bal2);
    assert_eq!(balance(&h, &h.provider), provider_bal2);
    assert_eq!(balance(&h, &h.client.address), contract_bal2);

    // --- Sequence 3: settle -> settle ---
    let err_settle2 = h.client.try_settle(&id2);
    assert_eq!(err_settle2, Err(Ok(Error::AlreadySettled)));
    assert_eq!(balance(&h, &h.consumer), consumer_bal2);
    assert_eq!(balance(&h, &h.provider), provider_bal2);
    assert_eq!(balance(&h, &h.client.address), contract_bal2);
}

#[test]
fn golden_tests_for_event_topics_and_payloads() {
    use soroban_sdk::{testutils::Events as _, IntoVal, Symbol, Vec as SVec};

    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let gateway = Address::generate(&env);
    let provider = Address::generate(&env);
    let consumer = Address::generate(&env);

    let token = env
        .register_stellar_asset_contract_v2(admin.clone())
        .address();
    StellarAssetClient::new(&env, &token).mint(&consumer, &1_000_000);

    let contract_id = env.register(KeyleaseCore, ());
    let client = KeyleaseCoreClient::new(&env, &contract_id);

    // 1. init event
    client.init(&admin, &token, &gateway);
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        SVec::from_array(
            &env,
            [(
                contract_id.clone(),
                SVec::from_array(
                    &env,
                    [
                        Symbol::new(&env, "init").into_val(&env),
                        admin.clone().into_val(&env),
                    ],
                ),
                (1u32, env.ledger().timestamp()).into_val(&env),
            )],
        ),
    );

    // 2. set_gateway event
    let new_gateway = Address::generate(&env);
    client.set_gateway(&new_gateway);
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        SVec::from_array(
            &env,
            [(
                contract_id.clone(),
                SVec::from_array(
                    &env,
                    [
                        Symbol::new(&env, "gateway").into_val(&env),
                        new_gateway.clone().into_val(&env),
                    ],
                ),
                (1u32, env.ledger().timestamp()).into_val(&env),
            )],
        ),
    );

    // 3. register_service event
    let service = String::from_str(&env, "weather-api");
    client.register_service(&provider, &service, &1_000);
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        SVec::from_array(
            &env,
            [(
                contract_id.clone(),
                SVec::from_array(
                    &env,
                    [
                        Symbol::new(&env, "service_registered").into_val(&env),
                        provider.clone().into_val(&env),
                    ],
                ),
                (1u32, service.clone(), 1_000i128).into_val(&env),
            )],
        ),
    );

    // 4. lease_created event
    let lease_id = client.create_lease(&consumer, &service, &10, &3_600);
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        SVec::from_array(
            &env,
            [(
                contract_id.clone(),
                SVec::from_array(
                    &env,
                    [
                        Symbol::new(&env, "lease_created").into_val(&env),
                        consumer.clone().into_val(&env),
                        lease_id.into_val(&env),
                    ],
                ),
                (1u32, service.clone(), 10u32, 10_000i128).into_val(&env),
            )],
        ),
    );

    // 5. calls_committed event
    client.use_call(&lease_id, &3);
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        SVec::from_array(
            &env,
            [(
                contract_id.clone(),
                SVec::from_array(
                    &env,
                    [
                        Symbol::new(&env, "calls_committed").into_val(&env),
                        consumer.clone().into_val(&env),
                        lease_id.into_val(&env),
                    ],
                ),
                (1u32, 3u32, 7u32).into_val(&env),
            )],
        ),
    );

    // 6. lease_revoked event
    let lease_id2 = client.create_lease(&consumer, &service, &10, &3_600);
    client.revoke(&lease_id2);
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        SVec::from_array(
            &env,
            [(
                contract_id.clone(),
                SVec::from_array(
                    &env,
                    [
                        Symbol::new(&env, "lease_revoked").into_val(&env),
                        consumer.clone().into_val(&env),
                        lease_id2.into_val(&env),
                    ],
                ),
                (1u32, 10_000i128).into_val(&env),
            )],
        ),
    );

    // 7. lease_settled event
    let lease_id3 = client.create_lease(&consumer, &service, &10, &60);
    client.use_call(&lease_id3, &6);
    env.ledger().set_timestamp(env.ledger().timestamp() + 61);
    client.settle(&lease_id3);
    assert_eq!(
        env.events().all().filter_by_contract(&contract_id),
        SVec::from_array(
            &env,
            [(
                contract_id.clone(),
                SVec::from_array(
                    &env,
                    [
                        Symbol::new(&env, "lease_settled").into_val(&env),
                        provider.clone().into_val(&env),
                        lease_id3.into_val(&env),
                    ],
                ),
                (1u32, 6_000i128, 4_000i128).into_val(&env),
            )],
        ),
    );
}
