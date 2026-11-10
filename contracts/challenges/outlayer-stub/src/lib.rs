//! OutLayer for the local sandbox round. `request_execution` takes the judge's question the way OutLayer's contract
//! does and yields, so the caller's callback waits. The round reads the question with `requests`, runs the real judge
//! (services/judge) against the sandbox's own RPC, and hands the answer back with `answer`. A request nobody answers
//! times out after 200 blocks and the caller sees a failed run, as on OutLayer. Never deployed outside the sandbox.

use near_sdk::serde_json::Value;
use near_sdk::{env, near, AccountId, Gas, GasWeight, PromiseError};

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Request {
    /// The judge's input, as the caller sent it.
    pub input: Option<String>,
    pub caller: AccountId,
    /// The yield's resumption id, hex.
    pub yield_id: String,
    pub answered: bool,
}

#[near(contract_state)]
#[derive(Default)]
pub struct Stub {
    requests: Vec<Request>,
}

#[near]
impl Stub {
    /// The same arguments OutLayer's contract takes; only the input matters here.
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
            caller: env::predecessor_account_id(),
            yield_id: id.iter().map(|b| format!("{b:02x}")).collect(),
            answered: false,
        });
        env::promise_return(promise);
    }

    /// The yielded callback: what `answer` resumed it with is what the caller gets.
    #[private]
    pub fn on_answer(&mut self, #[callback_result] output: Result<Option<String>, PromiseError>) -> Option<String> {
        output.ok().flatten()
    }

    /// Hands request `index` its answer, the judge's stdout.
    pub fn answer(&mut self, index: u32, output: Option<String>) {
        let r = self.requests.get_mut(index as usize).unwrap_or_else(|| env::panic_str("no such request"));
        let id: Vec<u8> =
            (0..r.yield_id.len()).step_by(2).map(|i| u8::from_str_radix(&r.yield_id[i..i + 2], 16).unwrap()).collect();
        let id: [u8; 32] = id.try_into().unwrap_or_else(|_| env::panic_str("bad yield id"));
        let data = near_sdk::serde_json::to_vec(&output).unwrap();
        if !env::promise_yield_resume(&id, data) {
            env::panic_str("the request is gone: answered or timed out");
        }
        r.answered = true;
    }

    pub fn requests(&self) -> Vec<Request> {
        self.requests.clone()
    }
}
