#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::{Address as _, Events, Ledger}, Address, Bytes, BytesN, Env, FromVal, Symbol, token};

#[test]
fn test_vesting_flow() {
    let e = Env::default();
    e.mock_all_auths();
    
    // Setup
    let funder = Address::generate(&e);
    let beneficiary = Address::generate(&e);
    let clawback_admin = Address::generate(&e);
    let upgrade_admin = Address::generate(&e);
    let contract_id = e.register(VestingContract, ());
    let client = VestingContractClient::new(&e, &contract_id);
    
    // Setup Token
    let token_admin = Address::generate(&e);
    let token_contract = e.register_stellar_asset_contract_v2(token_admin.clone()).address();
    let token_client = token::Client::new(&e, &token_contract);
    let token_admin_client = token::StellarAssetClient::new(&e, &token_contract);
    
    // Mint tokens to funder
    token_admin_client.mint(&funder, &10000);
    
    let start_time = e.ledger().timestamp();
    let cliff_seconds = 100;
    let duration_seconds = 1000;
    let amount = 10000;
    
    // Initialize
    client.initialize(
        &funder,
        &beneficiary,
        &token_contract,
        &start_time,
        &cliff_seconds,
        &duration_seconds,
        &amount,
        &clawback_admin,
        &upgrade_admin,
    );

    // Verify init state
    let config = client.get_config();
    assert_eq!(config.total_amount, amount);
    assert_eq!(config.is_active, true);
    
    // Check contract balance
    assert_eq!(token_client.balance(&contract_id), 10000);
    assert_eq!(token_client.balance(&funder), 0);
    
    // 1. Check before cliff (time = start)
    assert_eq!(client.get_vested_amount(), 0);
    assert_eq!(client.get_claimable_amount(), 0);
    
    // 2. Advance time past cliff (time = start + 200)
    // 200 / 1000 = 20% vested
    e.ledger().set_timestamp(start_time + 200);
    
    let vested = client.get_vested_amount();
    let expected_vested = 10000 * 200 / 1000; // 2000
    assert_eq!(vested, expected_vested);
    assert_eq!(client.get_claimable_amount(), expected_vested);
    
    // 3. Claim
    client.claim();
    
    // Verify claim
    assert_eq!(token_client.balance(&beneficiary), expected_vested);
    assert_eq!(client.get_claimable_amount(), 0);
    let config_after_claim = client.get_config();
    assert_eq!(config_after_claim.claimed_amount, expected_vested);
    
    // 4. Advance time more (time = start + 500)
    // 500 / 1000 = 50% vested (total 5000)
    e.ledger().set_timestamp(start_time + 500);
    
    let vested_2 = client.get_vested_amount();
    assert_eq!(vested_2, 5000);
    // Claimable = 5000 - 2000 (already claimed) = 3000
    assert_eq!(client.get_claimable_amount(), 3000);
    
    // 5. Clawback
    // Admin revokes remaining
    // Vested so far = 5000. Unvested = 5000.
    // Contract balance = 10000 - 2000 (claimed) = 8000.
    // Clawback should send 5000 to admin.
    // Contract should keep 3000 (claimable).
    
    client.clawback();
    
    // Check admin balance
    assert_eq!(token_client.balance(&clawback_admin), 5000);
    
    // Check contract balance: 8000 - 5000 = 3000
    assert_eq!(token_client.balance(&contract_id), 3000);
    
    // Verify config update
    let config_revoked = client.get_config();
    assert_eq!(config_revoked.is_active, false);
    assert_eq!(config_revoked.total_amount, 5000); // Capped at vested amount
    
    // 6. Advance time to end
    e.ledger().set_timestamp(start_time + 2000);
    
    // Vested should still be 5000 (capped)
    assert_eq!(client.get_vested_amount(), 5000);
    
    // Beneficiary can claim the rest of vested tokens (3000)
    client.claim();
    assert_eq!(token_client.balance(&beneficiary), 2000 + 3000);
    assert_eq!(token_client.balance(&contract_id), 0);
}

// ── Upgradeability ────────────────────────────────────────────────────────────

/// The contract the upgrade tests upgrade *to*. See
/// `test_fixtures/README.md` for how the WASM is produced.
mod upgraded_vesting {
    soroban_sdk::contractimport!(file = "test_fixtures/upgraded_vesting.wasm");
}

const HOUR: u64 = 60 * 60;

struct UpgradeFixture {
    e: Env,
    client: VestingContractClient<'static>,
    contract_id: Address,
    upgrade_admin: Address,
    beneficiary: Address,
    clawback_admin: Address,
    token: Address,
    start_time: u64,
}

/// A funded, initialized vesting contract with 10_000 tokens vesting linearly
/// over 1_000 seconds behind a 100 second cliff.
fn setup_upgradeable() -> UpgradeFixture {
    let e = Env::default();
    e.mock_all_auths();

    let funder = Address::generate(&e);
    let beneficiary = Address::generate(&e);
    let clawback_admin = Address::generate(&e);
    let upgrade_admin = Address::generate(&e);

    let contract_id = e.register(VestingContract, ());
    let client = VestingContractClient::new(&e, &contract_id);

    let token_admin = Address::generate(&e);
    let token = e.register_stellar_asset_contract_v2(token_admin).address();
    token::StellarAssetClient::new(&e, &token).mint(&funder, &10_000);

    let start_time = e.ledger().timestamp();
    client.initialize(
        &funder,
        &beneficiary,
        &token,
        &start_time,
        &100u64,
        &1_000u64,
        &10_000i128,
        &clawback_admin,
        &upgrade_admin,
    );

    UpgradeFixture {
        e,
        client,
        contract_id,
        upgrade_admin,
        beneficiary,
        clawback_admin,
        token,
        start_time,
    }
}

#[test]
fn test_claim_after_full_clawback_returns_clear_error() {
    let f = setup_upgradeable();

    // Before the cliff, clawback is full because nothing has vested.
    f.client.clawback();

    assert_eq!(
        f.client.try_claim(),
        Err(Ok(ContractError::ClaimUnavailableAfterClawback))
    );

    let config = f.client.get_config();
    assert_eq!(config.total_amount, 0);
    assert_eq!(config.claimed_amount, 0);
    assert!(!config.is_active);
}

#[test]
fn test_clawback_after_full_claim_returns_clear_error() {
    let f = setup_upgradeable();
    let token_client = token::Client::new(&f.e, &f.token);

    f.e.ledger().set_timestamp(f.start_time + 1_000);
    f.client.claim();
    assert_eq!(token_client.balance(&f.beneficiary), 10_000);

    assert_eq!(
        f.client.try_clawback(),
        Err(Ok(ContractError::ClawbackUnavailableAfterFullClaim))
    );

    let config = f.client.get_config();
    assert_eq!(config.claimed_amount, 10_000);
    assert_eq!(config.total_amount, 10_000);
    assert!(config.is_active);
}

#[test]
fn test_partial_claim_before_clawback_preserves_remaining_vested_claim() {
    let f = setup_upgradeable();
    let token_client = token::Client::new(&f.e, &f.token);

    f.e.ledger().set_timestamp(f.start_time + 200);
    f.client.claim();
    assert_eq!(token_client.balance(&f.beneficiary), 2_000);

    f.e.ledger().set_timestamp(f.start_time + 500);
    f.client.clawback();

    let frozen = f.client.get_config();
    assert_eq!(frozen.claimed_amount, 2_000);
    assert_eq!(frozen.total_amount, 5_000);
    assert!(!frozen.is_active);
    assert_eq!(token_client.balance(&f.clawback_admin), 5_000);

    // The 3_000 that vested before clawback remains claimable.
    f.client.claim();
    assert_eq!(token_client.balance(&f.beneficiary), 5_000);
    assert_eq!(
        f.client.try_claim(),
        Err(Ok(ContractError::ClaimUnavailableAfterClawback))
    );
}

fn new_wasm_hash(e: &Env) -> BytesN<32> {
    e.deployer()
        .upload_contract_wasm(Bytes::from_slice(e, upgraded_vesting::WASM))
}

fn has_event(e: &Env, contract_addr: &Address, event_name: &str) -> bool {
    let target = Symbol::new(e, event_name);
    e.events().all().iter().any(|(addr, topics, _data)| {
        addr == *contract_addr && topics.iter().any(|t| Symbol::from_val(e, &t) == target)
    })
}

#[test]
fn test_initialize_records_upgrade_admin() {
    let f = setup_upgradeable();

    assert_eq!(f.client.get_upgrade_admin(), f.upgrade_admin);
    // The upgrade admin is a distinct role from the clawback admin.
    assert_ne!(f.client.get_upgrade_admin(), f.clawback_admin);
    assert_eq!(f.client.get_upgrade_timelock(), 48 * HOUR);
    assert_eq!(f.client.get_pending_upgrade(), None);
}

#[test]
fn test_admin_can_propose_upgrade() {
    let f = setup_upgradeable();
    let hash = new_wasm_hash(&f.e);
    let now = f.e.ledger().timestamp();

    let executable_at = f.client.propose_upgrade(&hash);

    // `Env::events()` only reports the most recent invocation, so assert on the
    // event before making any further contract calls.
    assert!(
        has_event(&f.e, &f.contract_id, "upgrade_proposed_event"),
        "UpgradeProposedEvent was not emitted"
    );

    assert_eq!(executable_at, now + 48 * HOUR);
    assert_eq!(
        f.client.get_pending_upgrade(),
        Some(PendingUpgrade {
            wasm_hash: hash,
            proposed_at: now,
            executable_at,
        })
    );
}

#[test]
fn test_non_admin_cannot_propose_upgrade() {
    let f = setup_upgradeable();
    let hash = new_wasm_hash(&f.e);

    // Nothing is authorised any more, so the admin's `require_auth` must fail.
    f.e.mock_auths(&[]);

    assert!(f.client.try_propose_upgrade(&hash).is_err());
    f.e.mock_all_auths();
    assert_eq!(f.client.get_pending_upgrade(), None);
}

#[test]
fn test_non_admin_cannot_execute_or_cancel_upgrade() {
    let f = setup_upgradeable();
    let hash = new_wasm_hash(&f.e);
    f.client.propose_upgrade(&hash);

    f.e.ledger().set_timestamp(f.start_time + 48 * HOUR);
    f.e.mock_auths(&[]);

    assert!(f.client.try_execute_upgrade().is_err());
    assert!(f.client.try_cancel_upgrade().is_err());

    // The proposal is untouched and still executable by the real admin.
    f.e.mock_all_auths();
    assert!(f.client.get_pending_upgrade().is_some());
    f.client.execute_upgrade();
}

#[test]
fn test_upgrade_cannot_execute_before_timelock() {
    let f = setup_upgradeable();
    let hash = new_wasm_hash(&f.e);
    let executable_at = f.client.propose_upgrade(&hash);

    // Immediately after proposing.
    assert_eq!(
        f.client.try_execute_upgrade(),
        Err(Ok(ContractError::TimelockNotExpired))
    );

    // One second before the timelock expires — the tightest failing case.
    f.e.ledger().set_timestamp(executable_at - 1);
    assert_eq!(
        f.client.try_execute_upgrade(),
        Err(Ok(ContractError::TimelockNotExpired))
    );

    // Still pending, and the contract is still running the original code.
    assert!(f.client.get_pending_upgrade().is_some());
    assert_eq!(f.client.get_upgrade_admin(), f.upgrade_admin);
}

#[test]
fn test_upgrade_executes_exactly_at_timelock_expiry() {
    let f = setup_upgradeable();
    let hash = new_wasm_hash(&f.e);
    let executable_at = f.client.propose_upgrade(&hash);

    // The boundary is inclusive: `now == executable_at` is allowed.
    f.e.ledger().set_timestamp(executable_at);
    f.client.execute_upgrade();

    assert_eq!(upgraded_vesting::Client::new(&f.e, &f.contract_id).version(), 2);
}

#[test]
fn test_execute_upgrade_preserves_vesting_storage() {
    let f = setup_upgradeable();
    let token_client = token::Client::new(&f.e, &f.token);

    // Vest and claim 20% before upgrading, so there is real in-flight state.
    f.e.ledger().set_timestamp(f.start_time + 200);
    f.client.claim();
    assert_eq!(token_client.balance(&f.beneficiary), 2_000);

    let config_before = f.client.get_config();

    let hash = new_wasm_hash(&f.e);
    let executable_at = f.client.propose_upgrade(&hash);
    f.e.ledger().set_timestamp(executable_at);
    f.client.execute_upgrade();

    // Talk to the contract through the *new* executable: decoding the config
    // through the upgraded client is what proves the layout survived.
    let upgraded = upgraded_vesting::Client::new(&f.e, &f.contract_id);
    assert_eq!(upgraded.version(), 2);

    let config_after = upgraded.get_config();
    assert_eq!(config_after.beneficiary, config_before.beneficiary);
    assert_eq!(config_after.token, config_before.token);
    assert_eq!(config_after.start_time, config_before.start_time);
    assert_eq!(config_after.cliff_seconds, config_before.cliff_seconds);
    assert_eq!(config_after.duration_seconds, config_before.duration_seconds);
    assert_eq!(config_after.total_amount, config_before.total_amount);
    assert_eq!(config_after.claimed_amount, 2_000);
    assert_eq!(config_after.clawback_admin, config_before.clawback_admin);
    assert!(config_after.is_active);

    // Admin and escrowed funds are preserved too.
    assert_eq!(upgraded.get_upgrade_admin(), f.upgrade_admin);
    assert_eq!(token_client.balance(&f.contract_id), 8_000);
}

#[test]
fn test_execute_upgrade_emits_event_and_clears_pending() {
    let f = setup_upgradeable();
    let hash = new_wasm_hash(&f.e);
    let executable_at = f.client.propose_upgrade(&hash);

    f.e.ledger().set_timestamp(executable_at);
    f.client.execute_upgrade();

    assert!(
        has_event(&f.e, &f.contract_id, "upgrade_executed_event"),
        "UpgradeExecutedEvent was not emitted"
    );
    // The proposal must not survive into the new executable, or it could be
    // replayed against code that no longer expects it.
    assert!(!f.e.as_contract(&f.contract_id, || {
        f.e.storage().instance().has(&DataKey::PendingUpgrade)
    }));
}

#[test]
fn test_execute_upgrade_without_proposal_fails() {
    let f = setup_upgradeable();

    assert_eq!(
        f.client.try_execute_upgrade(),
        Err(Ok(ContractError::NoPendingUpgrade))
    );
    assert_eq!(
        f.client.try_cancel_upgrade(),
        Err(Ok(ContractError::NoPendingUpgrade))
    );
}

#[test]
fn test_second_proposal_rejected_while_one_is_pending() {
    let f = setup_upgradeable();
    let hash = new_wasm_hash(&f.e);
    let executable_at = f.client.propose_upgrade(&hash);

    // A silent overwrite here would let an admin swap the queued hash without
    // restarting the timelock, so it is rejected outright.
    assert_eq!(
        f.client.try_propose_upgrade(&hash),
        Err(Ok(ContractError::UpgradeAlreadyPending))
    );
    assert_eq!(f.client.get_pending_upgrade().unwrap().executable_at, executable_at);
}

#[test]
fn test_cancel_upgrade_restarts_the_full_timelock() {
    let f = setup_upgradeable();
    let hash = new_wasm_hash(&f.e);
    f.client.propose_upgrade(&hash);

    // Wait out most of the timelock, then cancel.
    f.e.ledger().set_timestamp(f.start_time + 47 * HOUR);
    f.client.cancel_upgrade();

    assert!(
        has_event(&f.e, &f.contract_id, "upgrade_cancelled_event"),
        "UpgradeCancelledEvent was not emitted"
    );
    assert_eq!(f.client.get_pending_upgrade(), None);

    // Re-proposing starts a fresh 48h window rather than inheriting the old one.
    let now = f.e.ledger().timestamp();
    let executable_at = f.client.propose_upgrade(&hash);
    assert_eq!(executable_at, now + 48 * HOUR);

    f.e.ledger().set_timestamp(executable_at - 1);
    assert_eq!(
        f.client.try_execute_upgrade(),
        Err(Ok(ContractError::TimelockNotExpired))
    );

    f.e.ledger().set_timestamp(executable_at);
    f.client.execute_upgrade();
    assert_eq!(upgraded_vesting::Client::new(&f.e, &f.contract_id).version(), 2);
}

#[test]
fn test_vesting_continues_across_upgrade() {
    let f = setup_upgradeable();
    let token_client = token::Client::new(&f.e, &f.token);

    let hash = new_wasm_hash(&f.e);
    let executable_at = f.client.propose_upgrade(&hash);

    // Vesting keeps accruing while the upgrade sits in its timelock.
    f.e.ledger().set_timestamp(f.start_time + 500);
    assert_eq!(f.client.get_claimable_amount(), 5_000);

    f.e.ledger().set_timestamp(executable_at);
    f.client.execute_upgrade();

    // The schedule is fully vested by now (48h ≫ the 1_000s duration) and the
    // beneficiary's balance is untouched by the upgrade itself.
    let config = upgraded_vesting::Client::new(&f.e, &f.contract_id).get_config();
    assert_eq!(config.total_amount, 10_000);
    assert_eq!(config.claimed_amount, 0);
    assert_eq!(token_client.balance(&f.contract_id), 10_000);
    assert_eq!(token_client.balance(&f.beneficiary), 0);
}
