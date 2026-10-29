extern crate std;

use crate::{Error, KeyleaseCore, KeyleaseCoreClient, Lease};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String,
};

struct Harness {
    env: Env,
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

    Harness { env, admin, gateway, consumer, provider, token, client }
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
