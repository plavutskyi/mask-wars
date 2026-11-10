// MASK CHECK on OutLayer: "should I send money to this NEAR account?", asked over HTTPS by any agent or app, answered
// inside a TEE. The check itself is packages/check, carried here rule for rule (check.rs): the same signals and
// levels, testnet and mainnet, two independent RPC providers that must agree on mainnet.
//
// Three answers, told apart by what the call attached for the project's author. OutLayer says it, never the caller:
// `USD_PAYMENT` of an HTTPS call (its `X-Attached-Deposit`) or `ATTACHED_USD` of a call from a contract, in
// millionths of a dollar, and only for the kind of call `OUTLAYER_EXECUTION_TYPE` names.
// - nothing attached: a preview. The verdict and the block it was read at, without reasons, evidence or a signature.
// - `PRICE_USD_MICRO` or more: the whole answer, signed with the project's key. The key comes from a seed OutLayer
//   generated inside the TEE (`PROTECTED_CHECK_SEED`), so only this project's code signs with it.
// - something, but less than the price: the preview, with a note on what the signed answer costs.
//
// A call that attached anything is always answered. OutLayer keeps what a call attached whatever the module says, so
// a refusal would take the money and give nothing.

pub mod account;
pub mod check;
pub mod encode;
pub mod http;
pub mod list;
pub mod network;
pub mod rpc;
pub mod sign;
pub mod time;

use check::{mask_check, CheckError, CheckResult, Options};
use network::Network;
use rpc::{Reader, Transport};
use serde::Serialize;
use serde_json::{json, Map, Value};

/// A signed verdict: $0.01, in millionths of a dollar as OutLayer counts them.
pub const PRICE_USD_MICRO: u64 = 10_000;

/// How far back the age and code-change signals look, in hours.
pub const WINDOW_HOURS: u32 = 24;

/// The version of this module, as Cargo.toml names it.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// What decides an answer, as one sha256: this module's sources, its dependency lock and the two shared lists
/// (build.rs). Every signed message states it, so a signature names the rules it was made by.
pub const RULES: &str = env!("MASKWARS_CHECK_RULES");

/// The first field of every signed message, and the shape that follows it. 2: the module names itself (`module`).
pub const MESSAGE_VERSION: u64 = 2;

/// How the call reached OutLayer, as the worker says it in `OUTLAYER_EXECUTION_TYPE`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Execution {
    /// Over OutLayer's HTTPS API: what the call attached for the author is `USD_PAYMENT`.
    Https,
    /// From a contract, through OutLayer's own contract: what it attached is `ATTACHED_USD`.
    Near,
    /// Neither: the module is not on OutLayer, or the worker does not say. Nothing counts as paid.
    Unknown,
}

/// What the run was given besides its input: facts OutLayer sets, never the caller.
#[derive(Clone, Debug)]
pub struct Run {
    pub execution: Execution,
    /// What the call attached for the project's author, in millionths of a dollar.
    pub attached_usd_micro: u64,
    /// `PROTECTED_CHECK_SEED`: 32 bytes in hex, generated inside the TEE.
    pub seed: Option<String>,
    /// The time of the run, milliseconds since the Unix epoch.
    pub now_ms: i64,
}

impl Run {
    /// The run's facts from its environment. A payment is read only from the variable of the run's own kind:
    /// `USD_PAYMENT` when OutLayer says HTTPS, `ATTACHED_USD` when it says NEAR. The same name anywhere else is not a
    /// payment, so nothing a caller could set counts unless the worker also says the call is of that kind. (The
    /// worker takes every system name out of a caller's secrets before it writes its own; the README names the line.)
    pub fn from_env(var: impl Fn(&str) -> Option<String>, now_ms: i64) -> Run {
        let set = |name: &str| var(name).filter(|v| !v.is_empty());
        let execution = match set("OUTLAYER_EXECUTION_TYPE").as_deref() {
            Some("HTTPS") => Execution::Https,
            Some("NEAR") => Execution::Near,
            _ => Execution::Unknown,
        };
        // Digits only, as the worker writes it; an amount past u64 is still paid in full.
        let amount = |name: &str| {
            let v = set(name)?;
            let digits = !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit());
            digits.then(|| v.parse::<u64>().unwrap_or(u64::MAX))
        };
        let attached_usd_micro = match execution {
            Execution::Https => amount("USD_PAYMENT"),
            Execution::Near => amount("ATTACHED_USD"),
            Execution::Unknown => None,
        };
        Run { execution, attached_usd_micro: attached_usd_micro.unwrap_or(0), seed: set("PROTECTED_CHECK_SEED"), now_ms }
    }

    fn signer(&self) -> Option<sign::Signer> {
        self.seed.as_deref().and_then(sign::Signer::from_seed)
    }
}

/// What the module writes to stdout: OutLayer hands it back as the call's `output`.
#[derive(Serialize, Debug)]
pub struct Output {
    pub success: bool,
    pub output: Value,
    pub error: Option<String>,
}

impl Output {
    fn ok(output: Value) -> Self {
        Output { success: true, output, error: None }
    }

    fn refused(error: impl Into<String>) -> Self {
        Output { success: false, output: Value::Null, error: Some(error.into()) }
    }
}

const BAD_INPUT: &str = r#"input: {"account": "<NEAR account id>", "network": "mainnet" | "testnet", "signed": true}; only account is required"#;

/// The header that buys a signed verdict over HTTPS, exactly as a caller sets it.
pub fn header() -> String {
    format!("X-Attached-Deposit: {PRICE_USD_MICRO}")
}

/// How a call of this kind buys a signed verdict. A contract cannot set a header, so it is not told to.
fn how_to_pay(execution: Execution) -> String {
    let near = format!(r#"attach it in request_execution: params.attached_usd "{PRICE_USD_MICRO}""#);
    match execution {
        Execution::Https => format!("Set the header {}", header()),
        Execution::Near => format!("From a contract, {near}"),
        Execution::Unknown => format!("Over HTTPS set the header {}; from a contract, {near}", header()),
    }
}

/// Millionths of a dollar as dollars: `10000` is `0.01`.
pub fn usd(micro: u64) -> String {
    let frac = format!("{:06}", micro % 1_000_000);
    let frac = frac.trim_end_matches('0');
    if frac.is_empty() {
        (micro / 1_000_000).to_string()
    } else {
        format!("{}.{frac}", micro / 1_000_000)
    }
}

fn price() -> Value {
    json!({ "usd": usd(PRICE_USD_MICRO), "usd_micro": PRICE_USD_MICRO, "header": header(), "attached_usd": PRICE_USD_MICRO.to_string() })
}

/// Which version of the module answered and by which rules.
fn module() -> Value {
    json!({ "version": VERSION, "rules": RULES })
}

/// What the module is and what it costs: free, and how a caller learns the key the verdicts are signed with.
fn about(run: &Run) -> Output {
    Output::ok(json!({
        "service": "MASK CHECK",
        "asks": "Should I send money to this NEAR account? allow, warn or block.",
        "module": module(),
        "tiers": {
            "preview": { "usd": "0", "gives": "the verdict and the block it was read at" },
            "signed": {
                "usd": usd(PRICE_USD_MICRO),
                "header": header(),
                "attached_usd": PRICE_USD_MICRO.to_string(),
                "gives": "every reason with its evidence, signed with the key below",
            },
        },
        "key": run.signer().map(|s| s.public_key()),
        "networks": {
            "mainnet": { "rpc": Network::Mainnet.rpc(), "cross_check": true },
            "testnet": { "rpc": Network::Testnet.rpc(), "cross_check": false },
        },
    }))
}

/// One call: the input OutLayer passed, the facts of the run, and HTTPS.
pub fn answer(input: Option<Value>, run: &Run, transport: &dyn Transport) -> Output {
    let Some(input) = input.as_ref().and_then(Value::as_object) else {
        return Output::refused(BAD_INPUT);
    };
    match input.get("action").filter(|a| !a.is_null()) {
        None => {}
        Some(Value::String(a)) if a == "check" => {}
        Some(Value::String(a)) if a == "about" => return about(run),
        Some(_) => return Output::refused("action: check or about"),
    }
    let Some(account) = input.get("account").and_then(Value::as_str).filter(|a| (1..=64).contains(&a.chars().count())) else {
        return Output::refused("account: a NEAR account id, e.g. intents.near or alice.testnet");
    };
    let network = match input.get("network").filter(|n| !n.is_null()) {
        None => Network::of(account),
        Some(n) => match n.as_str().and_then(Network::parse) {
            Some(network) => network,
            None => return Output::refused("network: testnet or mainnet"),
        },
    };
    let wants_signed = match input.get("signed").filter(|s| !s.is_null()) {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return Output::refused("signed: true or false"),
    };

    let attached = run.attached_usd_micro;
    let paid = attached >= PRICE_USD_MICRO;
    if wants_signed && attached == 0 {
        // Said before anything is read, and only to a call that attached nothing: it learns how to pay without
        // waiting for the chain, and no money is taken for a refusal.
        return Output {
            success: false,
            output: json!({ "payment": { "required_usd_micro": PRICE_USD_MICRO, "attached_usd_micro": attached, "header": header(), "attached_usd": PRICE_USD_MICRO.to_string() } }),
            error: Some(format!(
                "payment required: a signed verdict costs ${}, this call attached ${}. {}",
                usd(PRICE_USD_MICRO),
                usd(attached),
                how_to_pay(run.execution)
            )),
        };
    }

    let list = match list::shared(network) {
        Ok(list) => list,
        Err(why) => return Output::refused(why),
    };
    let mut reader = Reader::new(network.rpc(), network.archival(), network.cross_check(), transport);
    let options = Options { list: &list, network, window_hours: WINDOW_HOURS, now_ms: run.now_ms };
    let check = match mask_check(account, &mut reader, &options) {
        Ok(check) => check,
        Err(CheckError::InvalidAccount(why)) => return Output::refused(why),
        Err(CheckError::Failed(why)) => return Output::refused(format!("the check failed: {why}")),
    };
    if !paid {
        let mut out = json!({
            "tier": "preview",
            "check": { "account": check.account, "network": check.network, "verdict": check.verdict, "block": check.block, "checked_at": check.checked_at },
            "signed": null,
            "module": module(),
            "price": price(),
        });
        if attached > 0 {
            // Short of the price: the money is gone to OutLayer either way, so the caller at least has the verdict.
            out["payment"] = json!({
                "required_usd_micro": PRICE_USD_MICRO,
                "attached_usd_micro": attached,
                "note": format!(
                    "A signed verdict costs ${}; this call attached ${}, so it is answered as a preview. OutLayer keeps what a call attached; it does not come back. {}",
                    usd(PRICE_USD_MICRO),
                    usd(attached),
                    how_to_pay(run.execution)
                ),
            });
        }
        return Output::ok(out);
    }
    match run.signer() {
        Some(signer) => Output::ok(json!({
            "tier": "signed",
            "check": check,
            "signed": signer.sign(&message(&check)),
            "module": module(),
            "price": price(),
            "attached_usd_micro": attached,
        })),
        // Paid in full on a deployment that holds no key: everything that was bought except the signature, said so.
        None => Output::ok(json!({
            "tier": "unsigned",
            "check": check,
            "signed": null,
            "note": "Paid in full: this is the whole answer. It is not signed, because this deployment holds no signing key (PROTECTED_CHECK_SEED). Ask {\"action\":\"about\"} first: it names the key once there is one.",
            "module": module(),
            "price": price(),
            "attached_usd_micro": attached,
        })),
    }
}

/// The text the key signs: one line of JSON. First `maskwars_check`, a field no other message of this key starts
/// with; then `module`, the version and the rules that made the answer; then the answer itself. The module writes
/// every byte of it; nothing a caller sends is signed as it came.
pub fn message(check: &CheckResult) -> String {
    let mut m = Map::new();
    m.insert("maskwars_check".into(), json!(MESSAGE_VERSION));
    m.insert("module".into(), module());
    if let Ok(Value::Object(fields)) = serde_json::to_value(check) {
        m.extend(fields);
    }
    Value::Object(m).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn writes_dollars_from_millionths() {
        for (micro, text) in [(0, "0"), (10_000, "0.01"), (5_000, "0.005"), (1, "0.000001"), (1_000_000, "1"), (12_500_000, "12.5")] {
            assert_eq!(usd(micro), text);
        }
        assert_eq!(header(), "X-Attached-Deposit: 10000");
    }

    fn run_of(env: &[(&str, &str)]) -> Run {
        let env: HashMap<String, String> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Run::from_env(|name| env.get(name).cloned(), 0)
    }

    #[test]
    fn a_payment_counts_only_in_the_variable_of_the_runs_own_kind() {
        let attached = |env: &[(&str, &str)]| (run_of(env).execution, run_of(env).attached_usd_micro);
        assert_eq!(attached(&[("OUTLAYER_EXECUTION_TYPE", "HTTPS"), ("USD_PAYMENT", "10000")]), (Execution::Https, 10_000));
        assert_eq!(attached(&[("OUTLAYER_EXECUTION_TYPE", "NEAR"), ("ATTACHED_USD", "10000")]), (Execution::Near, 10_000));
        // The worker writes "0" into the variable of the other kind; a value there is not a payment.
        assert_eq!(attached(&[("OUTLAYER_EXECUTION_TYPE", "NEAR"), ("USD_PAYMENT", "10000"), ("ATTACHED_USD", "0")]), (Execution::Near, 0));
        assert_eq!(attached(&[("OUTLAYER_EXECUTION_TYPE", "HTTPS"), ("ATTACHED_USD", "10000"), ("USD_PAYMENT", "0")]), (Execution::Https, 0));
        // No word from OutLayer on the kind of call: nothing is a payment, whatever the variables hold.
        for kind in [None, Some(""), Some("https"), Some("HTTP"), Some("near"), Some("HTTPS ")] {
            let mut env = vec![("USD_PAYMENT", "10000"), ("ATTACHED_USD", "10000"), ("NEAR_PAYMENT_YOCTO", "1000000000000000000000000")];
            env.extend(kind.map(|k| ("OUTLAYER_EXECUTION_TYPE", k)));
            assert_eq!(attached(&env), (Execution::Unknown, 0), "{kind:?}");
        }
    }

    #[test]
    fn an_amount_is_digits_and_nothing_else() {
        let https = |v: &str| run_of(&[("OUTLAYER_EXECUTION_TYPE", "HTTPS"), ("USD_PAYMENT", v)]).attached_usd_micro;
        assert_eq!(https("9999"), 9_999);
        assert_eq!(https("0"), 0);
        for not_an_amount in ["", " 10000", "10000 ", "+10000", "-1", "1e4", "10000.0", "0x2710", "ten"] {
            assert_eq!(https(not_an_amount), 0, "{not_an_amount:?}");
        }
        // More than fits is still paid in full.
        assert_eq!(https("340282366920938463463374607431768211455"), u64::MAX);
    }

    #[test]
    fn the_seed_is_the_runs_and_an_empty_one_is_none() {
        assert_eq!(run_of(&[("PROTECTED_CHECK_SEED", "")]).seed, None);
        assert_eq!(run_of(&[("PROTECTED_CHECK_SEED", "ab")]).seed.as_deref(), Some("ab"));
        assert!(run_of(&[("PROTECTED_CHECK_SEED", "ab")]).signer().is_none());
    }

    #[test]
    fn a_contract_is_never_told_to_set_a_header() {
        assert_eq!(how_to_pay(Execution::Https), "Set the header X-Attached-Deposit: 10000");
        assert_eq!(how_to_pay(Execution::Near), r#"From a contract, attach it in request_execution: params.attached_usd "10000""#);
        assert!(!how_to_pay(Execution::Near).contains("header"));
        assert!(how_to_pay(Execution::Unknown).contains("X-Attached-Deposit: 10000") && how_to_pay(Execution::Unknown).contains("attached_usd"));
    }

    #[test]
    fn the_module_names_its_version_and_its_rules() {
        assert_eq!(VERSION, env!("CARGO_PKG_VERSION"));
        assert!(RULES.len() == 64 && RULES.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{RULES}");
        assert_eq!(module(), json!({ "version": VERSION, "rules": RULES }));
    }
}
