//! Sandbox stand-in for the arena (the bounty contract) and for a safe. Every call records who made it and who signed
//! it, so a test can see exactly what a mask's race keys can reach. `pay` sends the attached NEAR on, as a bounty pays
//! a winning mask. As the arena it also answers the three views the factory reads before it arms a mask (`get_safe`,
//! `get_round`, `get`), in the bounty contract's shape, for the rounds a test opens with `open_round`: whoever opens
//! one is its owner, the team.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault, Promise};

/// A round as the stand-in keeps it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Round {
    /// Who opened it, as the bounty contract names a round's team (`get`, `owner`).
    pub owner: AccountId,
    pub safe: AccountId,
    pub masks: Vec<AccountId>,
    pub commit_until: u64,
    pub state: String,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Call {
    pub method: String,
    pub predecessor: AccountId,
    pub signer: AccountId,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Stub {
    calls: Vector<Call>,
    rounds: LookupMap<String, Round>,
}

#[near]
impl Stub {
    #[init]
    pub fn new() -> Self {
        Self { calls: Vector::new(b"c"), rounds: LookupMap::new(b"r") }
    }

    /// Opens round `id` on `safe` for `masks`, its commit window `commit_minutes` long, in `state` (`open` unless
    /// said). Anyone may, as anyone may open a round on the bounty contract: the caller is the round's owner. Opening
    /// it again adds the masks and sets the rest.
    pub fn open_round(
        &mut self,
        id: String,
        safe: AccountId,
        masks: Vec<AccountId>,
        commit_minutes: u64,
        state: Option<String>,
    ) {
        let mut all = self.rounds.get(&id).map(|r| r.masks.clone()).unwrap_or_default();
        all.extend(masks.into_iter().filter(|m| !all.contains(m)).collect::<Vec<_>>());
        let commit_until = env::block_timestamp() + commit_minutes * 60_000_000_000;
        let state = state.unwrap_or_else(|| "open".into());
        self.rounds.insert(id, Round { owner: env::predecessor_account_id(), safe, masks: all, commit_until, state });
    }

    pub fn get_safe(&self, id: String) -> Option<Value> {
        let r = self.rounds.get(&id)?;
        Some(json!({ "safe": r.safe, "masks": r.masks, "min_loot": U128(10u128.pow(23)), "opened_ns": U64(0) }))
    }

    pub fn get_round(&self, id: String) -> Option<Value> {
        let r = self.rounds.get(&id)?;
        Some(json!({ "commit_until": U64(r.commit_until), "reveal_until": U64(r.commit_until + 3_600_000_000_000),
                     "deadline_ns": U64(r.commit_until + 7_200_000_000_000), "seals": [], "judging": [] }))
    }

    pub fn get(&self, id: String) -> Option<Value> {
        let r = self.rounds.get(&id)?;
        Some(json!({ "owner": r.owner, "amount": U128(10u128.pow(24)), "target": r.safe,
                     "deadline_ns": U64(r.commit_until + 7_200_000_000_000), "status": { "state": r.state } }))
    }

    pub fn commit(&mut self) {
        self.record("commit");
    }
    pub fn reveal(&mut self) {
        self.record("reveal");
    }
    pub fn claim_drain(&mut self) {
        self.record("claim_drain");
    }
    pub fn settle(&mut self) {
        self.record("settle");
    }
    pub fn set_owner(&mut self) {
        self.record("set_owner");
    }
    pub fn sweep(&mut self) {
        self.record("sweep");
    }
    /// A method no race key lists.
    pub fn other(&mut self) {
        self.record("other");
    }

    /// Sends the attached NEAR to `to`, as the bounty pays a winner.
    #[payable]
    pub fn pay(&mut self, to: AccountId) -> Promise {
        Promise::new(to).transfer(env::attached_deposit())
    }

    pub fn calls(&self) -> Vec<Call> {
        self.calls.iter().cloned().collect()
    }

    /// Accepts NEAR and does nothing with it.
    #[payable]
    pub fn take(&mut self) -> NearToken {
        env::attached_deposit()
    }
}

impl Stub {
    fn record(&mut self, method: &str) {
        self.calls.push(Call {
            method: method.into(),
            predecessor: env::predecessor_account_id(),
            signer: env::signer_account_id(),
        });
    }
}
