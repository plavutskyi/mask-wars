//! Sandbox stand-ins for what the jobs and crews contracts talk to. One wasm, deployed as each of:
//!
//! - **OutLayer**: `request_execution` takes the judge's question the way OutLayer's contract does and yields, so the
//!   caller's callback waits. The test reads the question with `requests` and hands back the judge's stdout with
//!   `answer`, in two steps as OutLayer's own `submit_execution_output_and_resolve` does: the output is stored, the
//!   yield resumes with the request's number (a resume payload holds at most 1024 bytes, an output up to the 4096 the
//!   jobs contract reads), and the resumed callback returns the stored output. A request nobody answers times out
//!   after 200 blocks, and the caller sees a failed run, as on OutLayer;
//! - **a bounty contract**: `get(id)` answers with whatever the test put there with `set_round`, in the bounty
//!   contract's own shape;
//! - **a mask factory**: `get_mask(name)` answers `{account, owner}` for a mask the test registered with `set_mask`.
//!
//! Never deployed outside the sandbox.

use near_sdk::serde_json::{json, Value};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, Gas, GasWeight, PanicOnDefault, PromiseError};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Request {
    /// The judge's input, as the caller sent it.
    pub input: Option<String>,
    pub source: String,
    pub secrets: Option<String>,
    pub caller: AccountId,
    pub payer: Option<AccountId>,
    pub deposit: String,
    /// The yield's resumption id, hex.
    pub yield_id: String,
    pub answered: bool,
    /// The judge's stdout, stored before the yield resumes.
    pub output: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Stub {
    requests: Vec<Request>,
    rounds: LookupMap<String, String>,
    masks: LookupMap<String, AccountId>,
}

#[near]
impl Stub {
    #[init]
    pub fn new() -> Self {
        Self { requests: vec![], rounds: LookupMap::new(b"r"), masks: LookupMap::new(b"m") }
    }

    // OutLayer ---------------------------------------------------------------------------------------------------

    /// The same arguments OutLayer's contract takes.
    #[payable]
    #[allow(clippy::too_many_arguments, unused_variables)]
    pub fn request_execution(
        &mut self,
        source: Value,
        resource_limits: Option<Value>,
        input_data: Option<String>,
        secrets_ref: Option<Value>,
        response_format: Option<String>,
        payer_account_id: Option<AccountId>,
        params: Option<Value>,
    ) {
        let promise = env::promise_yield_create("on_answer", "{}", Gas::from_tgas(5), GasWeight(1), 0);
        let id = env::read_register(0).unwrap_or_else(|| env::panic_str("no yield id"));
        self.requests.push(Request {
            input: input_data,
            source: source.to_string(),
            secrets: secrets_ref.map(|s| s.to_string()),
            caller: env::predecessor_account_id(),
            payer: payer_account_id,
            deposit: env::attached_deposit().as_yoctonear().to_string(),
            yield_id: id.iter().map(|b| format!("{b:02x}")).collect(),
            answered: false,
            output: None,
        });
        env::promise_return(promise);
    }

    /// The yielded callback: it was resumed with the request's number, and the caller gets the output stored for it.
    #[private]
    pub fn on_answer(&mut self, #[callback_result] index: Result<u32, PromiseError>) -> Option<String> {
        index.ok().and_then(|i| self.requests.get(i as usize)).and_then(|r| r.output.clone())
    }

    /// Hands request `index` its answer, the judge's stdout: stored, then the yield resumed with the number.
    pub fn answer(&mut self, index: u32, output: Option<String>) {
        let r = self.requests.get_mut(index as usize).unwrap_or_else(|| env::panic_str("no such request"));
        let id: Vec<u8> =
            (0..r.yield_id.len()).step_by(2).map(|i| u8::from_str_radix(&r.yield_id[i..i + 2], 16).unwrap()).collect();
        let id: [u8; 32] = id.try_into().unwrap_or_else(|_| env::panic_str("bad yield id"));
        r.output = output;
        let data = near_sdk::serde_json::to_vec(&index).unwrap();
        if !env::promise_yield_resume(&id, data) {
            env::panic_str("the request is gone: answered or timed out");
        }
        r.answered = true;
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.clone()
    }

    // A bounty contract ------------------------------------------------------------------------------------------

    pub fn set_round(&mut self, id: String, bounty: Value) {
        self.rounds.insert(id, bounty.to_string());
    }

    pub fn get(&self, id: String) -> Option<Value> {
        self.rounds.get(&id).map(|s| near_sdk::serde_json::from_str(s).unwrap())
    }

    // A mask factory ---------------------------------------------------------------------------------------------

    pub fn set_mask(&mut self, name: String, owner: AccountId) {
        self.masks.insert(name, owner);
    }

    pub fn get_mask(&self, name: String) -> Option<Value> {
        let owner = self.masks.get(&name)?;
        Some(json!({ "name": name, "account": format!("{name}.{}", env::current_account_id()), "owner": owner }))
    }
}
