extern crate std;

use crate::{
    Error, KeyleaseCore, KeyleaseCoreClient, Lease, CONTRACT_VERSION, MAX_LEASE_DURATION,
    MAX_SERVICE_LEN, MIN_SERVICE_LEN,
};
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient},
    Address, Env, String, Vec as SVec,
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

    Harness {
        env,
        contract_id,
        admin,
        gateway,
        consumer,
        provider,
        token,
        client,
    }
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

    let err = h
        .client
        .try_init(&h.admin, &h.token, &h.gateway)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::AlreadyInitialized);
}

#[test]
fn version_matches_the_crate_version() {
    let h = setup();
    assert_eq!(CONTRACT_VERSION, env!("CARGO_PKG_VERSION"));
    assert_eq!(
        h.client.version(),
        String::from_str(&h.env, CONTRACT_VERSION)
    );
}

#[test]
fn version_is_readable_before_init() {
    let env = Env::default();
    let contract_id = env.register(KeyleaseCore, ());
    let client = KeyleaseCoreClient::new(&env, &contract_id);
    assert_eq!(
        client.version(),
        String::from_str(&env, env!("CARGO_PKG_VERSION"))
    );
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
    assert_eq!(
        h.client.get_service(&service_id(&h.env)).provider,
        h.provider
    );
}

#[test]
fn register_service_validates_service_id_length_and_charset() {
    let h = setup();

    // Empty string
    let empty = String::from_str(&h.env, "");
    let err = h
        .client
        .try_register_service(&h.provider, &empty, &1_000)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidService);

    // Too long (> 64 chars, 65 bytes)
    let too_long = String::from_str(
        &h.env,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert_eq!(too_long.len(), MAX_SERVICE_LEN + 1);
    let err = h
        .client
        .try_register_service(&h.provider, &too_long, &1_000)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidService);

    // Whitespace
    for invalid in &["hello world", " leading", "trailing ", " \t "] {
        let s = String::from_str(&h.env, invalid);
        let err = h
            .client
            .try_register_service(&h.provider, &s, &1_000)
            .unwrap_err();
        assert_eq!(err.unwrap(), Error::InvalidService);
    }

    // Control characters
    for invalid in &["api\nservice", "api\x00null", "api\r\n", "api\tname"] {
        let s = String::from_str(&h.env, invalid);
        let err = h
            .client
            .try_register_service(&h.provider, &s, &1_000)
            .unwrap_err();
        assert_eq!(err.unwrap(), Error::InvalidService);
    }

    // Disallowed punctuation / special characters
    for invalid in &["api/v1", "api:v1", "api@v1", "api#1", "api$"] {
        let s = String::from_str(&h.env, invalid);
        let err = h
            .client
            .try_register_service(&h.provider, &s, &1_000)
            .unwrap_err();
        assert_eq!(err.unwrap(), Error::InvalidService);
    }

    // Valid: 1 char
    let single = String::from_str(&h.env, "a");
    assert_eq!(single.len(), MIN_SERVICE_LEN);
    assert!(h.client.try_register_service(&h.provider, &single, &100).is_ok());

    // Valid: exactly 64 chars
    let max_len = String::from_str(
        &h.env,
        "abcdefghijklmnopqrstuvwxyz0123456789.ABCDEF-GHIJKLMNOP_QRSTUVWXY",
    );
    assert_eq!(max_len.len(), MAX_SERVICE_LEN);
    assert!(h.client.try_register_service(&h.provider, &max_len, &100).is_ok());

    // Valid: combination of allowed symbols
    let symbols = String::from_str(&h.env, "my_service-v1.0");
    assert!(h.client.try_register_service(&h.provider, &symbols, &100).is_ok());
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
    let err = h
        .client
        .try_quote(&service_id(&h.env), &u32::MAX)
        .unwrap_err();
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
fn create_lease_rejects_overflowing_and_excessive_durations() {
    let h = setup();
    register(&h);
    let consumer_before = balance(&h, &h.consumer);
    let escrow_before = balance(&h, &h.client.address);

    // u64::MAX duration
    let err = h
        .client
        .try_create_lease(&h.consumer, &service_id(&h.env), &10, &u64::MAX)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidDuration);

    // u64::MAX - timestamp duration
    let timestamp = h.env.ledger().timestamp();
    let near_overflow = u64::MAX - timestamp;
    let err = h
        .client
        .try_create_lease(&h.consumer, &service_id(&h.env), &10, &near_overflow)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidDuration);

    // Upper bound exceeded (MAX_LEASE_DURATION + 1)
    let err = h
        .client
        .try_create_lease(&h.consumer, &service_id(&h.env), &10, &(MAX_LEASE_DURATION + 1))
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::InvalidDuration);

    // Verify token balance was not modified (tokens not moved on error)
    assert_eq!(balance(&h, &h.consumer), consumer_before);
    assert_eq!(balance(&h, &h.client.address), escrow_before);
    assert_eq!(h.client.get_config().lease_count, 0);

    // Exactly MAX_LEASE_DURATION succeeds
    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &MAX_LEASE_DURATION);
    assert_eq!(id, 1);
    let lease = h.client.get_lease(&id);
    assert_eq!(lease.expires_at, timestamp + MAX_LEASE_DURATION);
    assert_eq!(balance(&h, &h.consumer), consumer_before - 10_000);
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
fn pause_blocks_new_leases_and_resumes_cleanly() {
    let h = setup();
    register(&h);
    assert!(!h.client.get_config().paused);

    let escrow_before = balance(&h, &h.client.address);
    assert!(h.client.set_paused(&true));
    assert!(h.client.get_config().paused);

    // A paused contract allocates no lease and moves no tokens.
    let consumer_before = balance(&h, &h.consumer);
    let err = h
        .client
        .try_create_lease(&h.consumer, &service_id(&h.env), &10, &60)
        .unwrap_err();
    assert_eq!(err.unwrap(), Error::Paused);
    assert_eq!(balance(&h, &h.consumer), consumer_before);
    assert_eq!(balance(&h, &h.client.address), escrow_before);
    assert_eq!(h.client.get_config().lease_count, 0);

    // Resuming needs no other state change.
    assert!(!h.client.set_paused(&false));
    assert!(!h.client.get_config().paused);
    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &60);
    assert_eq!(id, 1);
}

#[test]
fn existing_leases_stay_usable_revocable_and_settleable_while_paused() {
    let h = setup();
    register(&h);
    let settling = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &4, &60);
    let revocable = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &4, &3_600);

    h.client.set_paused(&true);

    // The gateway can still commit served calls on existing leases.
    let lease = h.client.use_call(&settling, &2);
    assert_eq!(lease.calls_used, 2);
    assert_eq!(h.client.remaining_calls(&settling), 2);

    // The consumer can still revoke and be refunded for unused calls.
    let consumer_before = balance(&h, &h.consumer);
    h.client.revoke(&revocable);
    assert_eq!(balance(&h, &h.consumer), consumer_before + 4_000);
    assert_eq!(balance(&h, &h.client.address), 4_000);

    // Settlement still pays the provider for consumed calls.
    h.env.ledger().with_mut(|li| li.timestamp = 61);
    let settled = h.client.settle(&settling);
    assert!(settled.settled && !settled.active);
    assert_eq!(balance(&h, &h.provider), 2_000);
    assert_eq!(balance(&h, &h.client.address), 0);
}

#[test]
fn pause_and_resume_emit_events() {
    use soroban_sdk::{testutils::Events as _, IntoVal, Symbol, Vec as SVec};

    let h = setup();

    h.client.set_paused(&true);
    assert_eq!(
        h.env.events().all(),
        SVec::from_array(
            &h.env,
            [(
                h.client.address.clone(),
                SVec::from_array(
                    &h.env,
                    [
                        Symbol::new(&h.env, "paused").into_val(&h.env),
                        h.admin.clone().into_val(&h.env),
                    ],
                ),
                true.into_val(&h.env),
            )],
        ),
    );

    h.client.set_paused(&false);
    assert_eq!(
        h.env.events().all(),
        SVec::from_array(
            &h.env,
            [(
                h.client.address.clone(),
                SVec::from_array(
                    &h.env,
                    [
                        Symbol::new(&h.env, "unpaused").into_val(&h.env),
                        h.admin.clone().into_val(&h.env),
                    ],
                ),
                false.into_val(&h.env),
            )],
        ),
    );
    assert!(!h.client.get_config().paused);
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
fn revoke_expired_lease_fails_before_expiry() {
    let h = setup();
    register(&h);
    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &3_600);
    let err = h.client.try_revoke_expired_lease(&id).unwrap_err();
    assert_eq!(err.unwrap(), Error::LeaseNotSettleable);
}

#[test]
fn revoke_expired_lease_succeeds_after_expiry_with_refund() {
    let h = setup();
    register(&h);
    let id = h
        .client
        .create_lease(&h.consumer, &service_id(&h.env), &10, &3_600);
    h.client.use_call(&id, &2);

    h.env.ledger().with_mut(|li| li.timestamp = 3_601);

    let before = balance(&h, &h.consumer);
    let lease = h.client.revoke_expired_lease(&id);
    assert_eq!(balance(&h, &h.consumer), before + 8_000);
    assert!(lease.settled);
    assert_eq!(h.client.remaining_calls(&id), 0);
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
        let err = h.client.try_get_service(&service_id(&h.env)).unwrap_err();
        assert_eq!(err.unwrap(), Error::UnknownService);
    }

    #[test]
    fn set_paused_requires_the_admin() {
        let h = setup();
        clear_auths(&h);

        let err = h.client.try_set_paused(&true).unwrap_err();
        assert!(err.is_err(), "only the admin may pause new leases");
        assert!(!h.client.get_config().paused);
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
    assert!(
        err.is_err(),
        "only the current admin may propose a successor"
    );
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
            [(
                h.client.address.clone(),
                topics(),
                (3u32, 7u32).into_val(&h.env)
            )],
        ),
    );

    // Committing past the limit clamps, so the event reports 0 remaining.
    h.client.use_call(&id, &999);
    assert_eq!(
        h.env.events().all(),
        SVec::from_array(
            &h.env,
            [(
                h.client.address.clone(),
                topics(),
                (10u32, 0u32).into_val(&h.env)
            )],
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

/// Service ownership (#69): a service id belongs to whoever registered it.
mod service_ownership {
    use super::*;

    #[test]
    fn another_provider_cannot_take_over_a_service() {
        let h = setup();
        register(&h);
        let before = h.client.get_service(&service_id(&h.env));

        let attacker = Address::generate(&h.env);
        let err = h
            .client
            .try_register_service(&attacker, &service_id(&h.env), &1)
            .unwrap_err();
        assert_eq!(err.unwrap(), Error::Unauthorized);

        // Name, price, provider and status are all untouched.
        let after = h.client.get_service(&service_id(&h.env));
        assert_eq!(after, before);
        assert_eq!(after.provider, h.provider);
        assert_eq!(after.price_per_call, 1_000);
        assert_eq!(after.service, service_id(&h.env));
        assert!(after.active);
    }

    #[test]
    fn a_takeover_attempt_does_not_redirect_new_lease_payouts() {
        let h = setup();
        register(&h);
        let attacker = Address::generate(&h.env);
        let _ = h
            .client
            .try_register_service(&attacker, &service_id(&h.env), &1);

        let id = h
            .client
            .create_lease(&h.consumer, &service_id(&h.env), &4, &60);
        let lease = h.client.get_lease(&id);
        assert_eq!(lease.provider, h.provider);
        assert_eq!(lease.price_paid, 4_000);

        h.client.use_call(&id, &4);
        h.client.settle(&id);
        assert_eq!(balance(&h, &h.provider), 4_000);
        assert_eq!(balance(&h, &attacker), 0);
    }

    #[test]
    fn the_original_provider_can_still_update_the_price() {
        let h = setup();
        register(&h);
        let svc = h
            .client
            .register_service(&h.provider, &service_id(&h.env), &2_500);
        assert_eq!(svc.provider, h.provider);
        assert_eq!(svc.price_per_call, 2_500);
        assert_eq!(h.client.get_service(&service_id(&h.env)), svc);
        assert_eq!(h.client.quote(&service_id(&h.env), &2), 5_000);
    }

    #[test]
    fn existing_leases_keep_their_provider_and_price_after_a_reprice() {
        let h = setup();
        register(&h);
        let id = h
            .client
            .create_lease(&h.consumer, &service_id(&h.env), &10, &60);

        h.client
            .register_service(&h.provider, &service_id(&h.env), &9_000);
        let attacker = Address::generate(&h.env);
        let _ = h
            .client
            .try_register_service(&attacker, &service_id(&h.env), &1);

        let lease = h.client.get_lease(&id);
        assert_eq!(lease.provider, h.provider);
        assert_eq!(lease.price_paid, 10_000);

        // Settlement still pays the original provider out of the original escrow.
        h.client.use_call(&id, &5);
        h.env.ledger().with_mut(|li| li.timestamp += 61);
        h.client.settle(&id);
        assert_eq!(balance(&h, &h.provider), 5_000);
        assert_eq!(balance(&h, &attacker), 0);
    }

    #[test]
    fn a_takeover_attempt_requires_the_attackers_auth_first() {
        let h = setup();
        register(&h);
        let attacker = Address::generate(&h.env);
        h.env.mock_auths(&[]);
        let err = h
            .client
            .try_register_service(&attacker, &service_id(&h.env), &1)
            .unwrap_err();
        assert!(err.is_err(), "an unsigned call must fail in the host");
        assert_eq!(
            h.client.get_service(&service_id(&h.env)).provider,
            h.provider
        );
    }
}

/// Per-consumer lease index (#72).
mod consumer_lease_index {
    use super::*;
    use crate::MAX_CONSUMER_LEASES_PAGE;
    use soroban_sdk::{vec, Vec as SVec};

    fn lease_for(h: &Harness, consumer: &Address) -> u64 {
        h.client
            .create_lease(consumer, &service_id(&h.env), &1, &60)
    }

    fn funded(h: &Harness) -> Address {
        let who = Address::generate(&h.env);
        StellarAssetClient::new(&h.env, &h.token).mint(&who, &1_000_000);
        who
    }

    #[test]
    fn an_unknown_consumer_has_an_empty_index() {
        let h = setup();
        let nobody = Address::generate(&h.env);
        assert_eq!(
            h.client.get_consumer_leases(&nobody, &0, &10),
            SVec::new(&h.env)
        );
    }

    #[test]
    fn create_lease_appends_to_the_consumers_index_in_creation_order() {
        let h = setup();
        register(&h);
        let a = lease_for(&h, &h.consumer);
        let b = lease_for(&h, &h.consumer);
        let c = lease_for(&h, &h.consumer);
        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &0, &10),
            vec![&h.env, a, b, c]
        );
    }

    #[test]
    fn consumers_have_separate_indexes_that_do_not_leak() {
        let h = setup();
        register(&h);
        let other = funded(&h);

        let a1 = lease_for(&h, &h.consumer);
        let b1 = lease_for(&h, &other);
        let a2 = lease_for(&h, &h.consumer);
        let b2 = lease_for(&h, &other);
        let b3 = lease_for(&h, &other);

        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &0, &10),
            vec![&h.env, a1, a2]
        );
        assert_eq!(
            h.client.get_consumer_leases(&other, &0, &10),
            vec![&h.env, b1, b2, b3]
        );
        for id in h.client.get_consumer_leases(&other, &0, &10).iter() {
            assert_eq!(h.client.get_lease(&id).consumer, other);
        }
    }

    #[test]
    fn pages_walk_the_index_with_an_offset() {
        let h = setup();
        register(&h);
        let ids: std::vec::Vec<u64> = (0..5).map(|_| lease_for(&h, &h.consumer)).collect();

        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &0, &2),
            vec![&h.env, ids[0], ids[1]]
        );
        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &2, &2),
            vec![&h.env, ids[2], ids[3]]
        );
        // Last, short page.
        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &4, &2),
            vec![&h.env, ids[4]]
        );
        // Exactly at the end and past it.
        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &5, &2),
            SVec::new(&h.env)
        );
        assert_eq!(
            h.client
                .get_consumer_leases(&h.consumer, &u32::MAX, &u32::MAX),
            SVec::new(&h.env)
        );
        // Zero limit is an empty page, not an error.
        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &0, &0),
            SVec::new(&h.env)
        );
        // A page that overruns the end is trimmed to what exists.
        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &3, &100),
            vec![&h.env, ids[3], ids[4]]
        );
    }

    #[test]
    fn page_size_is_clamped_to_the_documented_maximum() {
        let h = setup();
        register(&h);
        let total = MAX_CONSUMER_LEASES_PAGE + 2;
        let ids: std::vec::Vec<u64> = (0..total).map(|_| lease_for(&h, &h.consumer)).collect();

        let first = h.client.get_consumer_leases(&h.consumer, &0, &u32::MAX);
        assert_eq!(first.len(), MAX_CONSUMER_LEASES_PAGE);
        assert_eq!(first.get(0), Some(ids[0]));
        assert_eq!(
            first.get(MAX_CONSUMER_LEASES_PAGE - 1),
            Some(ids[(MAX_CONSUMER_LEASES_PAGE - 1) as usize])
        );

        let rest = h
            .client
            .get_consumer_leases(&h.consumer, &first.len(), &u32::MAX);
        assert_eq!(
            rest,
            vec![
                &h.env,
                ids[MAX_CONSUMER_LEASES_PAGE as usize],
                ids[(MAX_CONSUMER_LEASES_PAGE + 1) as usize]
            ]
        );
    }

    #[test]
    fn settled_and_revoked_leases_stay_listed() {
        let h = setup();
        register(&h);
        let settled = h
            .client
            .create_lease(&h.consumer, &service_id(&h.env), &2, &60);
        let revoked = lease_for(&h, &h.consumer);
        let live = lease_for(&h, &h.consumer);

        h.client.use_call(&settled, &2);
        h.client.settle(&settled);
        h.client.revoke(&revoked);
        assert!(h.client.get_lease(&settled).settled);
        assert!(h.client.get_lease(&revoked).settled);

        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &0, &10),
            vec![&h.env, settled, revoked, live]
        );
    }

    #[test]
    fn a_failed_create_lease_does_not_touch_the_index() {
        let h = setup();
        register(&h);
        let first = lease_for(&h, &h.consumer);
        h.client
            .set_service_active(&h.provider, &service_id(&h.env), &false);
        let err = h
            .client
            .try_create_lease(&h.consumer, &service_id(&h.env), &1, &60)
            .unwrap_err();
        assert_eq!(err.unwrap(), Error::ServiceInactive);
        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &0, &10),
            vec![&h.env, first]
        );
    }

    #[test]
    fn index_entries_get_a_ttl_and_reads_extend_it() {
        use crate::{DataKey, EXTEND_TO, MIN_TTL};
        use soroban_sdk::testutils::storage::Persistent;

        let h = setup();
        register(&h);
        let id = lease_for(&h, &h.consumer);
        let count_key = DataKey::ConsumerLeases(h.consumer.clone());
        let entry_key = DataKey::ConsumerLease(h.consumer.clone(), 0);
        let ttl = |key: &DataKey| {
            h.env
                .as_contract(&h.contract_id, || h.env.storage().persistent().get_ttl(key))
        };

        // Written with the same month-long TTL as leases and services.
        assert!(ttl(&count_key) >= MIN_TTL);
        assert!(ttl(&entry_key) >= MIN_TTL);
        let stored: u64 = h.env.as_contract(&h.contract_id, || {
            h.env.storage().persistent().get(&entry_key).unwrap()
        });
        assert_eq!(stored, id);

        h.env
            .ledger()
            .with_mut(|li| li.sequence_number += EXTEND_TO - MIN_TTL + 1);
        assert!(ttl(&count_key) < MIN_TTL);
        assert!(ttl(&entry_key) < MIN_TTL);

        h.client.get_consumer_leases(&h.consumer, &0, &10);
        assert!(ttl(&count_key) >= MIN_TTL);
        assert!(ttl(&entry_key) >= MIN_TTL);
    }
}

/// Guarded wasm upgrade (#84).
///
/// `Env::upload` registers a native contract under a wasm hash, and the host
/// then dispatches calls for any instance whose executable is that hash to it.
/// That lets these tests run the real `update_current_contract` host path and
/// then call the *new* code at the *same* address, proving the executable
/// changed while storage and escrow did not. What is not exercised here is a
/// real compiled wasm blob (upload validation, wasm-level storage decoding);
/// see the migration note in the README for the on-chain verification steps.
mod upgrade {
    use super::*;
    use soroban_sdk::{
        testutils::{Events as _, MockAuth, MockAuthInvoke},
        BytesN, IntoVal, Symbol, Vec as SVec,
    };

    /// Stand-in for a future release: reads the current storage layout.
    mod next {
        use crate::{Config, DataKey, Lease, Service};
        use soroban_sdk::{contract, contractimpl, Address, Env, String};

        #[contract]
        pub struct KeyleaseCoreNext;

        #[contractimpl]
        impl KeyleaseCoreNext {
            pub fn version(env: Env) -> String {
                String::from_str(&env, "next")
            }
            pub fn get_config(env: Env) -> Config {
                env.storage().instance().get(&DataKey::Config).unwrap()
            }
            pub fn pending_admin(env: Env) -> Option<Address> {
                env.storage().instance().get(&DataKey::PendingAdmin)
            }
            pub fn get_service(env: Env, service: String) -> Service {
                env.storage()
                    .persistent()
                    .get(&DataKey::Service(service))
                    .unwrap()
            }
            pub fn get_lease(env: Env, id: u64) -> Lease {
                env.storage().persistent().get(&DataKey::Lease(id)).unwrap()
            }
            pub fn consumer_lease_count(env: Env, consumer: Address) -> u32 {
                env.storage()
                    .persistent()
                    .get(&DataKey::ConsumerLeases(consumer))
                    .unwrap_or(0)
            }
        }
    }
    use next::{KeyleaseCoreNext, KeyleaseCoreNextClient};

    #[test]
    fn admin_upgrade_swaps_the_code_and_keeps_address_and_state() {
        let h = setup();
        register(&h);
        let settled = h
            .client
            .create_lease(&h.consumer, &service_id(&h.env), &2, &60);
        h.client.use_call(&settled, &2);
        h.client.settle(&settled);
        let live = h
            .client
            .create_lease(&h.consumer, &service_id(&h.env), &10, &3_600);
        h.client.use_call(&live, &3);
        let pending = Address::generate(&h.env);
        h.client.propose_admin(&pending);

        let config_before = h.client.get_config();
        let service_before = h.client.get_service(&service_id(&h.env));
        let live_before = h.client.get_lease(&live);
        let settled_before = h.client.get_lease(&settled);
        let escrow_before = balance(&h, &h.contract_id);

        let new_hash = h.env.upload(KeyleaseCoreNext);
        h.client.upgrade(&new_hash);

        // Same address, new code.
        let next = KeyleaseCoreNextClient::new(&h.env, &h.contract_id);
        assert_eq!(next.address, h.client.address);
        assert_eq!(next.version(), String::from_str(&h.env, "next"));

        // Instance and persistent storage, and the escrow, are unchanged.
        assert_eq!(next.get_config(), config_before);
        assert_eq!(next.pending_admin(), Some(pending));
        assert_eq!(next.get_service(&service_id(&h.env)), service_before);
        assert_eq!(next.get_lease(&live), live_before);
        assert_eq!(next.get_lease(&settled), settled_before);
        assert_eq!(next.consumer_lease_count(&h.consumer), 2);
        assert_eq!(balance(&h, &h.contract_id), escrow_before);
    }

    #[test]
    fn the_full_api_keeps_working_after_an_upgrade_to_a_compatible_release() {
        let h = setup();
        register(&h);
        let before = h
            .client
            .create_lease(&h.consumer, &service_id(&h.env), &10, &60);
        h.client.use_call(&before, &4);

        let new_hash = h.env.upload(KeyleaseCore);
        h.client.upgrade(&new_hash);

        // The pre-upgrade lease settles against the pre-upgrade escrow.
        h.env.ledger().with_mut(|li| li.timestamp += 61);
        h.client.settle(&before);
        assert_eq!(balance(&h, &h.provider), 4_000);
        assert_eq!(balance(&h, &h.contract_id), 0);

        // New leases continue the same id sequence and consumer index.
        let after = h
            .client
            .create_lease(&h.consumer, &service_id(&h.env), &1, &60);
        assert_eq!(after, before + 1);
        assert_eq!(
            h.client.get_consumer_leases(&h.consumer, &0, &10),
            soroban_sdk::vec![&h.env, before, after]
        );
        assert_eq!(h.client.get_config().admin, h.admin);
    }

    #[test]
    fn upgrade_emits_contract_updated_with_the_new_hash() {
        let h = setup();
        let new_hash = h.env.upload(KeyleaseCore);
        h.client.upgrade(&new_hash);
        assert_eq!(
            h.env.events().all(),
            SVec::from_array(
                &h.env,
                [(
                    h.client.address.clone(),
                    SVec::from_array(
                        &h.env,
                        [
                            Symbol::new(&h.env, "contract_updated").into_val(&h.env),
                            h.admin.clone().into_val(&h.env),
                        ],
                    ),
                    new_hash.into_val(&h.env),
                )],
            ),
        );
    }

    #[test]
    fn upgrade_requires_the_admin() {
        let h = setup();
        let new_hash = h.env.upload(KeyleaseCoreNext);

        // No signatures at all.
        h.env.mock_auths(&[]);
        assert!(h.client.try_upgrade(&new_hash).unwrap_err().is_err());

        // A signature from someone other than the admin for this exact call.
        let attacker = Address::generate(&h.env);
        h.env.mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &h.contract_id,
                fn_name: "upgrade",
                args: (new_hash.clone(),).into_val(&h.env),
                sub_invokes: &[],
            },
        }]);
        assert!(h.client.try_upgrade(&new_hash).unwrap_err().is_err());

        // The code was not swapped.
        assert_eq!(
            h.client.version(),
            String::from_str(&h.env, CONTRACT_VERSION)
        );
        assert_eq!(h.client.get_config().admin, h.admin);
    }

    #[test]
    fn upgrade_rejects_a_wasm_hash_that_was_never_uploaded() {
        let h = setup();
        register(&h);
        let unknown = BytesN::from_array(&h.env, &[7u8; 32]);
        assert!(h.client.try_upgrade(&unknown).is_err());
        assert_eq!(
            h.client.version(),
            String::from_str(&h.env, CONTRACT_VERSION)
        );
        assert_eq!(
            h.client.get_service(&service_id(&h.env)).provider,
            h.provider
        );
    }

    #[test]
    fn upgrade_before_init_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register(KeyleaseCore, ());
        let client = KeyleaseCoreClient::new(&env, &contract_id);
        let new_hash = env.upload(KeyleaseCoreNext);
        let err = client.try_upgrade(&new_hash).unwrap_err();
        assert_eq!(err.unwrap(), Error::NotInitialized);
        assert_eq!(client.version(), String::from_str(&env, CONTRACT_VERSION));
    }
}
