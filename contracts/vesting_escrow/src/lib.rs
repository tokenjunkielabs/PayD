#![no_std]
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, token, Address, BytesN, Env,
};
use common::CommonError;

// ── Errors ────────────────────────────────────────────────────────────────────

/// Codes 1-3 mirror `common::CommonError` so they mean the same thing here as
/// in the other contracts in this workspace.
#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq)]
#[repr(u32)]
pub enum ContractError {
    AlreadyInitialized    = 1,
    NotInitialized        = 2,
    Unauthorized          = 3,
    UpgradeAlreadyPending = 4,
    NoPendingUpgrade      = 5,
    TimelockNotExpired                 = 6,
    TimestampOverflow                  = 7,
    ClaimUnavailableAfterClawback      = 8,
    ClawbackUnavailableAfterFullClaim  = 9,
}

impl From<CommonError> for ContractError {
    fn from(e: CommonError) -> Self {
        match e {
            CommonError::AlreadyInitialized => ContractError::AlreadyInitialized,
            CommonError::NotInitialized => ContractError::NotInitialized,
            CommonError::Unauthorized => ContractError::Unauthorized,
        }
    }
}

// ── Events ────────────────────────────────────────────────────────────────────

#[contractevent]
pub struct UpgradeProposedEvent {
    pub wasm_hash: BytesN<32>,
    pub proposed_at: u64,
    pub executable_at: u64,
}

#[contractevent]
pub struct UpgradeExecutedEvent {
    pub wasm_hash: BytesN<32>,
    pub executed_at: u64,
}

#[contractevent]
pub struct UpgradeCancelledEvent {
    pub wasm_hash: BytesN<32>,
    pub cancelled_at: u64,
}

// ── Storage types ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub struct VestingConfig {
    pub beneficiary: Address,
    pub token: Address,
    pub start_time: u64,
    pub cliff_seconds: u64,
    pub duration_seconds: u64,
    pub total_amount: i128,
    pub claimed_amount: i128,
    pub clawback_admin: Address,
    pub is_active: bool,
}

/// An upgrade that has been proposed but is still inside its timelock window.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingUpgrade {
    pub wasm_hash: BytesN<32>,
    pub proposed_at: u64,
    /// Earliest ledger timestamp at which `execute_upgrade` may run.
    pub executable_at: u64,
}

#[contracttype]
pub enum DataKey {
    Config,
    /// Address allowed to propose, cancel and execute WASM upgrades. Distinct
    /// from `VestingConfig::clawback_admin`, which only governs revocation.
    UpgradeAdmin,
    PendingUpgrade,
}

/// Mandatory delay between proposing an upgrade and executing it: 48 hours.
/// Ledger timestamps are Unix seconds (UTC), so this delay is wall-clock exact
/// regardless of the proposer's local timezone.
pub const UPGRADE_TIMELOCK_SECONDS: u64 = 48 * 60 * 60;

/// TTL bump applied when an upgrade is pending, so the proposal (and the rest
/// of the instance state) cannot be archived out from under the 48h window.
/// ~7 days at 5 s/ledger, comfortably longer than the timelock.
const UPGRADE_TTL_LEDGERS: u32 = 120_960;

// ── Contract ──────────────────────────────────────────────────────────────────

#[contract]
pub struct VestingContract;

#[contractimpl]
impl VestingContract {
    pub fn initialize(
        e: Env,
        funder: Address,
        beneficiary: Address,
        token: Address,
        start_time: u64,
        cliff_seconds: u64,
        duration_seconds: u64,
        amount: i128,
        clawback_admin: Address,
        upgrade_admin: Address,
    ) {
        if e.storage().instance().has(&DataKey::Config) {
            panic!("Already initialized");
        }
        
        funder.require_auth();

        if duration_seconds < cliff_seconds {
            panic!("Duration must be greater than or equal to cliff");
        }
        
        if amount <= 0 {
             panic!("Amount must be positive");
        }

        let config = VestingConfig {
            beneficiary: beneficiary.clone(),
            token: token.clone(),
            start_time,
            cliff_seconds,
            duration_seconds,
            total_amount: amount,
            claimed_amount: 0,
            clawback_admin,
            is_active: true,
        };

        e.storage().instance().set(&DataKey::Config, &config);
        e.storage().instance().set(&DataKey::UpgradeAdmin, &upgrade_admin);
        
        // Transfer tokens from funder to contract
        let client = token::Client::new(&e, &token);
        client.transfer(&funder, &e.current_contract_address(), &amount);
    }

    pub fn claim(e: Env) -> Result<(), ContractError> {
        let mut config: VestingConfig = e.storage().instance().get(&DataKey::Config).expect("Not initialized");

        config.beneficiary.require_auth();

        let vested = Self::calc_vested(&e, &config);
        let claimable = vested - config.claimed_amount;

        if claimable <= 0 {
            // Once clawback has capped the schedule, an exhausted grant is a
            // terminal state rather than a silent no-op. This is what a claim
            // observes when a full clawback wins the race.
            if !config.is_active {
                return Err(ContractError::ClaimUnavailableAfterClawback);
            }
            return Ok(());
        }

        config.claimed_amount += claimable;
        e.storage().instance().set(&DataKey::Config, &config);

        let client = token::Client::new(&e, &config.token);
        client.transfer(&e.current_contract_address(), &config.beneficiary, &claimable);
        Ok(())
    }

    pub fn clawback(e: Env) -> Result<(), ContractError> {
        let mut config: VestingConfig = e.storage().instance().get(&DataKey::Config).expect("Not initialized");

        config.clawback_admin.require_auth();

        if !config.is_active {
            panic!("Already revoked/inactive");
        }

        // If a full claim wins the race there is nothing left for the admin to
        // recover. Surface that terminal state explicitly instead of silently
        // deactivating an already-settled grant.
        if config.claimed_amount >= config.total_amount {
            return Err(ContractError::ClawbackUnavailableAfterFullClaim);
        }

        let vested = Self::calc_vested(&e, &config);
        let unvested = config.total_amount - vested;

        // Freeze vesting at the amount earned when clawback lands. Anything
        // already vested but not yet claimed remains beneficiary-owned.
        config.total_amount = vested;
        config.is_active = false;
        e.storage().instance().set(&DataKey::Config, &config);

        if unvested > 0 {
            let client = token::Client::new(&e, &config.token);
            client.transfer(&e.current_contract_address(), &config.clawback_admin, &unvested);
        }

        Ok(())
    }

    pub fn get_vested_amount(e: Env) -> i128 {
        let config: VestingConfig = e.storage().instance().get(&DataKey::Config).expect("Not initialized");
        Self::calc_vested(&e, &config)
    }
    
    pub fn get_claimable_amount(e: Env) -> i128 {
        let config: VestingConfig = e.storage().instance().get(&DataKey::Config).expect("Not initialized");
        let vested = Self::calc_vested(&e, &config);
        vested - config.claimed_amount
    }
    
    pub fn get_config(e: Env) -> VestingConfig {
        e.storage().instance().get(&DataKey::Config).expect("Not initialized")
    }

    // ── Upgradeability ────────────────────────────────────────────────────────

    /// Propose an upgrade to `new_wasm_hash`. Admin-only.
    ///
    /// The upgrade does not take effect immediately: it becomes executable only
    /// once `UPGRADE_TIMELOCK_SECONDS` have elapsed, giving beneficiaries a
    /// 48-hour window to observe the proposal and exit if they disagree with it.
    /// Returns the timestamp at which the upgrade becomes executable.
    ///
    /// A second proposal is rejected while one is pending; cancel it first so
    /// that replacing a proposal always restarts the full timelock.
    pub fn propose_upgrade(e: Env, new_wasm_hash: BytesN<32>) -> Result<u64, ContractError> {
        common::require_admin(&e, &DataKey::UpgradeAdmin).map_err(ContractError::from)?;

        if e.storage().instance().has(&DataKey::PendingUpgrade) {
            return Err(ContractError::UpgradeAlreadyPending);
        }

        let proposed_at = e.ledger().timestamp();
        let executable_at = proposed_at
            .checked_add(UPGRADE_TIMELOCK_SECONDS)
            .ok_or(ContractError::TimestampOverflow)?;

        let pending = PendingUpgrade {
            wasm_hash: new_wasm_hash.clone(),
            proposed_at,
            executable_at,
        };
        e.storage().instance().set(&DataKey::PendingUpgrade, &pending);
        e.storage()
            .instance()
            .extend_ttl(UPGRADE_TTL_LEDGERS, UPGRADE_TTL_LEDGERS);

        UpgradeProposedEvent {
            wasm_hash: new_wasm_hash,
            proposed_at,
            executable_at,
        }
        .publish(&e);

        Ok(executable_at)
    }

    /// Execute the pending upgrade once its timelock has expired. Admin-only.
    ///
    /// Only the contract's executable is swapped; every storage entry — the
    /// vesting config, claimed amounts and the admin — is left untouched, so
    /// in-flight vesting schedules keep running across the upgrade.
    pub fn execute_upgrade(e: Env) -> Result<(), ContractError> {
        common::require_admin(&e, &DataKey::UpgradeAdmin).map_err(ContractError::from)?;

        let pending: PendingUpgrade = e
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .ok_or(ContractError::NoPendingUpgrade)?;

        let now = e.ledger().timestamp();
        if now < pending.executable_at {
            return Err(ContractError::TimelockNotExpired);
        }

        // Consume the proposal before swapping the WASM so the new code never
        // starts life with a stale pending upgrade it could replay.
        e.storage().instance().remove(&DataKey::PendingUpgrade);

        UpgradeExecutedEvent {
            wasm_hash: pending.wasm_hash.clone(),
            executed_at: now,
        }
        .publish(&e);

        e.deployer().update_current_contract_wasm(pending.wasm_hash);
        Ok(())
    }

    /// Withdraw a pending upgrade before it is executed. Admin-only.
    pub fn cancel_upgrade(e: Env) -> Result<(), ContractError> {
        common::require_admin(&e, &DataKey::UpgradeAdmin).map_err(ContractError::from)?;

        let pending: PendingUpgrade = e
            .storage()
            .instance()
            .get(&DataKey::PendingUpgrade)
            .ok_or(ContractError::NoPendingUpgrade)?;

        e.storage().instance().remove(&DataKey::PendingUpgrade);

        UpgradeCancelledEvent {
            wasm_hash: pending.wasm_hash,
            cancelled_at: e.ledger().timestamp(),
        }
        .publish(&e);

        Ok(())
    }

    /// The pending upgrade, or `None` when no upgrade is queued.
    pub fn get_pending_upgrade(e: Env) -> Option<PendingUpgrade> {
        e.storage().instance().get(&DataKey::PendingUpgrade)
    }

    /// Address authorised to propose, cancel and execute upgrades.
    pub fn get_upgrade_admin(e: Env) -> Result<Address, ContractError> {
        e.storage()
            .instance()
            .get(&DataKey::UpgradeAdmin)
            .ok_or(ContractError::NotInitialized)
    }

    /// Length of the upgrade timelock, in seconds.
    pub fn get_upgrade_timelock(_e: Env) -> u64 {
        UPGRADE_TIMELOCK_SECONDS
    }

    fn calc_vested(e: &Env, config: &VestingConfig) -> i128 {
        let now = e.ledger().timestamp();
        
        if now < config.start_time + config.cliff_seconds {
            return 0;
        }
        
        if now >= config.start_time + config.duration_seconds || !config.is_active {
            return config.total_amount;
        }
        
        // Linear vesting
        let time_elapsed = now - config.start_time;
        
        // vested = total * elapsed / duration
        // We use i128 for calculation to avoid overflow
        let total = config.total_amount;
        let elapsed = time_elapsed as i128;
        let duration = config.duration_seconds as i128;
        
        total.checked_mul(elapsed).unwrap().checked_div(duration).unwrap()
    }
}

#[cfg(test)]
mod test;
