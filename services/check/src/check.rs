// MASK CHECK: one question before an agent pays or calls a contract. In: an account. Out: allow, warn or block, with
// every reason and its evidence. This is packages/check/src/check.ts line for line: the same signals, the same levels,
// the same words. The vectors in packages/check/test/vectors.json hold both to the same answer.
//
// `allow` means only that no signal against the account was found. It says nothing about keys, servers or anything
// else that is not on the chain.

use crate::account::{account_ok, is_implicit, is_mainnet_name, is_testnet_name, trimmed};
use crate::list::{ArenaEntry, SharedList};
use crate::network::Network;
use crate::rpc::{host_of, AccountInfo, At, BlockInfo, ChainError, Kind, Reader, NO_CODE};
use crate::time::iso;
use serde::Serialize;
use serde_json::{json, Map, Value};

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Allow,
    Warn,
    Block,
}

impl Verdict {
    pub fn name(self) -> &'static str {
        match self {
            Verdict::Allow => "allow",
            Verdict::Warn => "warn",
            Verdict::Block => "block",
        }
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
    Block,
}

#[derive(Serialize, Clone, Debug)]
pub struct Reason {
    pub code: &'static str,
    pub level: Level,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Map<String, Value>>,
}

#[derive(Serialize, Clone, Debug)]
pub struct BlockRef {
    pub height: u64,
    pub hash: String,
    pub time: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct CheckResult {
    pub account: String,
    pub network: &'static str,
    pub verdict: Verdict,
    /// One line a person or an agent can show as is.
    pub summary: String,
    /// Strongest first.
    pub reasons: Vec<Reason>,
    /// The final block every chain reading was taken at; `null` when the chain could not be read.
    pub block: Option<BlockRef>,
    pub checked_at: String,
    pub rpc: Vec<String>,
}

/// Why no answer came out.
#[derive(Debug, PartialEq, Eq)]
pub enum CheckError {
    /// An id that cannot be an account, or a name of the other network.
    InvalidAccount(String),
    /// Something the check cannot read as it must: the list of another network, a contract's answer of another shape.
    Failed(String),
}

impl CheckError {
    pub fn message(&self) -> &str {
        match self {
            CheckError::InvalidAccount(m) | CheckError::Failed(m) => m,
        }
    }
}

/// What stops the reading of the chain: an RPC error, which becomes a reason, or a failure, which ends the check.
enum Stop {
    Chain(ChainError),
    Failed(String),
}

impl From<ChainError> for Stop {
    fn from(e: ChainError) -> Self {
        Stop::Chain(e)
    }
}

pub struct Options<'l> {
    /// The shared list of `network`.
    pub list: &'l SharedList,
    pub network: Network,
    /// How far back the age and code-change signals look. 24 hours as the check is served.
    pub window_hours: u32,
    /// The time of the check, milliseconds since the Unix epoch.
    pub now_ms: i64,
}

fn reason(code: &'static str, level: Level, text: impl Into<String>) -> Reason {
    Reason { code, level, text: text.into(), evidence: None }
}

fn with(mut r: Reason, evidence: Value) -> Reason {
    r.evidence = evidence.as_object().cloned();
    r
}

/// What JavaScript takes for false: a view that answered nothing.
fn falsy(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::Bool(b) => !*b,
        Value::Number(n) => n.as_f64() == Some(0.0),
        Value::String(s) => s.is_empty(),
        Value::Array(_) | Value::Object(_) => false,
    }
}

/// A value of a contract's answer as JavaScript writes it into a text (`${value}`): a field that is not there reads
/// `undefined`, `null` reads `null`. Numbers are written as JSON writes them.
fn js_text(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => js_join(items, ","),
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(other) => other.to_string(),
    }
}

/// A list as JavaScript's `join` writes it: `null` is an empty place.
fn js_join(items: &[Value], between: &str) -> String {
    let texts: Vec<String> = items.iter().map(|v| if v.is_null() { String::new() } else { js_text(Some(v)) }).collect();
    texts.join(between)
}

/// yoctoNEAR as NEAR with up to three decimals, cut, not rounded.
fn near(yocto: &str) -> Result<String, Stop> {
    let n: u128 = yocto.parse().map_err(|_| Stop::Failed(format!("not an amount: {yocto}")))?;
    let (whole, frac) = (n / 10u128.pow(24), n % 10u128.pow(24) / 10u128.pow(21));
    let frac = format!("{frac:03}");
    let frac = frac.trim_end_matches('0');
    Ok(if frac.is_empty() { whole.to_string() } else { format!("{whole}.{frac}") })
}

/// The closest block at or below `height` that the nodes still have, trying a few heights for skipped ones.
fn block_at_or_below(reader: &mut Reader, height: i64) -> Result<Option<BlockInfo>, ChainError> {
    let mut h = height;
    while h > height - 4 && h > 0 {
        if let Some(b) = reader.block(h as u64)? {
            return Ok(Some(b));
        }
        h -= 1;
    }
    Ok(None)
}

fn arena_reasons(reader: &mut Reader, entry: &ArenaEntry, at: At, explorer: &str) -> Result<Vec<Reason>, Stop> {
    let place = json!({ "contract": entry.contract, "race": entry.race });
    let read = |reader: &mut Reader| -> Result<(Value, Value), ChainError> {
        let bounty = reader.view(&entry.contract, "get", &json!({ "id": entry.race }), at)?;
        let race = if falsy(&bounty) { Value::Null } else { reader.view(&entry.contract, "get_safe", &json!({ "id": entry.race }), at)? };
        Ok((bounty, race))
    };
    let (bounty, race) = match read(reader) {
        Ok(views) => views,
        Err(e) if e.kind == Kind::Contract => {
            let text = format!("The arena contract {} did not answer for {}: {}", entry.contract, entry.race, e.message);
            return Ok(vec![with(reason("arena_unreadable", Level::Info, text), place)]);
        }
        Err(e) => return Err(e.into()),
    };
    if falsy(&bounty) {
        let text = format!("Listed for {} on the arena, but that race is not open on chain yet.", entry.race);
        return Ok(vec![with(reason("arena_pending", Level::Info, text), place)]);
    }
    if falsy(&race) || race.get("safe").and_then(Value::as_str) != Some(entry.safe.as_str()) {
        let mut evidence = place.clone();
        evidence["safe_on_chain"] = race.get("safe").cloned().unwrap_or(Value::Null);
        return Ok(vec![with(reason("arena_pending", Level::Info, format!("{} on chain is not a live race on this safe.", entry.race)), evidence)]);
    }
    // Each state reads only the fields it tells about, as the TypeScript check does: a drained race needs no masks
    // and no bounty to be a block. A field a state does need and cannot read ends the check.
    let unreadable = |what: &str| Stop::Failed(format!("{}: {what} of {} has another shape", entry.contract, entry.race));
    let s = bounty.get("status").filter(|s| !s.is_null()).ok_or_else(|| unreadable("the status"))?;
    let state = s.get("state").and_then(Value::as_str).unwrap_or("");
    if state == "drained" {
        let (winner, tx_hash) = (s.get("winner"), s.get("tx_hash"));
        let text = format!(
            "Drained on the MASK WARS arena: mask {} took the safe through its planted hole in {}, and the judge confirmed the drain on chain. Whoever controls it now is not its original owner.",
            js_text(winner),
            entry.race
        );
        let mut evidence = place.clone();
        evidence["winner"] = winner.cloned().unwrap_or(Value::Null);
        evidence["tx_hash"] = tx_hash.cloned().unwrap_or(Value::Null);
        evidence["tx"] = json!(tx_hash.filter(|h| !falsy(h)).map(|h| format!("{explorer}/txns/{}", js_text(Some(h)))));
        return Ok(vec![with(reason("arena_drained", Level::Block, text), evidence)]);
    }
    let owner = match reader.view(&entry.safe, "get_owner", &json!({}), at) {
        Ok(owner) => owner,
        Err(e) if e.kind == Kind::Contract => Value::Null,
        Err(e) => return Err(e.into()),
    };
    let mut out = vec![];
    if !falsy(&owner) && owner.as_str() != Some(entry.owner_at_open.as_str()) {
        let text = format!(
            "Taken over on the MASK WARS arena: the safe's owner is now {}, not {}. A mask got in through the planted hole in {}; the drain is not judged yet.",
            js_text(Some(&owner)),
            entry.owner_at_open,
            entry.race
        );
        let mut evidence = place.clone();
        evidence["owner"] = owner;
        evidence["owner_at_open"] = json!(entry.owner_at_open);
        out.push(with(reason("arena_taken_over", Level::Block, text), evidence));
    }
    if state == "open" || state == "judging" {
        let masks = race.get("masks").and_then(Value::as_array).ok_or_else(|| unreadable("the masks"))?;
        let amount = bounty.get("amount").and_then(Value::as_str).ok_or_else(|| unreadable("the bounty"))?;
        let deadline: u64 =
            bounty.get("deadline_ns").and_then(Value::as_str).and_then(|d| d.parse().ok()).ok_or_else(|| unreadable("the deadline"))?;
        let text = format!(
            "A live target on the MASK WARS arena right now: {} masks race to drain it in {} (a training safe with a planted hole). Bounty {} NEAR.",
            masks.len(),
            entry.race,
            near(amount)?
        );
        let mut evidence = place.clone();
        evidence["masks"] = json!(js_join(masks, ", "));
        evidence["deadline"] = json!(iso((deadline / 1_000_000) as i64));
        out.push(with(reason("arena_target", Level::Warn, text), evidence));
    } else if state == "refunded" {
        let text = format!("Withstood {} on the MASK WARS arena: no mask drained it before the deadline.", entry.race);
        out.push(with(reason("arena_withstood", Level::Info, text), place));
    }
    Ok(out)
}

fn history_reasons(reader: &mut Reader, account_id: &str, head: &BlockInfo, now: &AccountInfo, window_hours: u32) -> Result<Vec<Reason>, ChainError> {
    // Where every read is cross-checked, a window nobody could read is a warning: without it a new account or new
    // code would pass as an old one, and one provider can bring that about by saying it no longer keeps the block.
    let unread = if reader.cross_check { Level::Warn } else { Level::Info };
    // Block time drifts, so measure it on the last 10 000 blocks and step back that many blocks for the window.
    let sample = block_at_or_below(reader, head.height as i64 - 10_000)?;
    let ns_per_block = match &sample {
        // The difference first, in whole nanoseconds: one timestamp alone does not fit a float exactly.
        Some(s) => (i128::from(head.timestamp_ns) - i128::from(s.timestamp_ns)) as f64 / (head.height as i64 - s.height as i64) as f64,
        None => 0.0,
    };
    let reference = if ns_per_block > 0.0 {
        let back = ((f64::from(window_hours) * 3_600e9) / ns_per_block).ceil();
        block_at_or_below(reader, head.height as i64 - back as i64)?
    } else {
        None
    };
    let Some(reference) = reference else {
        let text = format!("No RPC node keeps the block from {window_hours} h ago; age and code changes were not checked.");
        return Ok(vec![reason("history_unavailable", unread, text)]);
    };
    let time = iso(reference.time_ms());
    let since = json!({ "block_height": reference.height, "block_time": time });
    let then = match reader.account(account_id, At::Height(reference.height)) {
        Ok(then) => then,
        Err(e) if e.kind == Kind::UnknownBlock => {
            let text = format!("No RPC node keeps the state from {window_hours} h ago; age and code changes were not checked.");
            return Ok(vec![reason("history_unavailable", unread, text)]);
        }
        Err(e) => return Err(e),
    };
    let at = format!("(block {}, {time})", reference.height);
    let Some(then) = then else {
        let text = format!("New account: it did not exist {window_hours} h ago {at}.");
        return Ok(vec![with(reason("young_account", Level::Warn, text), since)]);
    };
    let mut out = vec![];
    if then.code_hash != now.code_hash {
        let mut evidence = since.clone();
        if then.code_hash == NO_CODE {
            evidence["code_hash"] = json!(now.code_hash);
            out.push(with(reason("code_deployed", Level::Warn, format!("A contract was deployed here within the last {window_hours} h.")), evidence));
        } else {
            evidence["code_hash_before"] = json!(then.code_hash);
            evidence["code_hash_now"] = json!(now.code_hash);
            let what = if now.code_hash == NO_CODE { "was removed" } else { "changed" };
            out.push(with(reason("code_changed", Level::Warn, format!("The contract's code {what} within the last {window_hours} h.")), evidence));
        }
    }
    out.push(with(reason("account_age", Level::Info, format!("The account already existed {window_hours} h ago {at}.")), since));
    Ok(out)
}

/// How the providers answered, on a network read with cross-check. Nothing on a network read with failover.
/// A read that only one provider answered is a warning, whichever read it was: the head, the account, its history or
/// the arena. What one provider says alone, it could have made up, so it never adds up to an `allow`.
fn rpc_reasons(reader: &Reader) -> Vec<Reason> {
    let t = &reader.tally;
    if !reader.cross_check || t.reads == 0 {
        return vec![];
    }
    let hosts: Vec<String> = reader.endpoints.iter().map(|e| host_of(e)).collect();
    let evidence = json!({ "rpc": hosts.join(", "), "reads": t.reads, "cross_checked": t.agreed });
    if hosts.len() < 2 {
        let text = format!("Read from one RPC provider only, {}: nothing was cross-checked.", hosts[0]);
        return vec![with(reason("rpc_single", Level::Warn, text), evidence)];
    }
    if t.agreed == t.reads {
        let text = format!("Two independent RPC providers, {}, gave the same answer to all {} reads.", hosts.join(" and "), t.reads);
        return vec![with(reason("rpc_agree", Level::Info, text), evidence)];
    }
    let why: Vec<String> = t.missing.iter().map(|(endpoint, said)| format!("{}: {}", host_of(endpoint), after_endpoint(said))).collect();
    let text =
        format!("{} of {} reads came from one RPC provider only and were not cross-checked ({}).", t.reads - t.agreed, t.reads, why.join("; "));
    vec![with(reason("rpc_single", Level::Warn, text), evidence)]
}

/// An error's message without the endpoint it starts with.
fn after_endpoint(message: &str) -> &str {
    match message.split_once(": ") {
        Some((endpoint, rest)) if !endpoint.is_empty() && !endpoint.contains(char::is_whitespace) => rest,
        _ => message,
    }
}

fn summarize(verdict: Verdict, level: Level, reasons: &[Reason]) -> String {
    if verdict == Verdict::Allow {
        return "No signals against this account were found.".into();
    }
    let top: Vec<&str> = reasons.iter().filter(|r| r.level == level).map(|r| r.text.as_str()).collect();
    format!("{}: {}", verdict.name().to_uppercase(), top.join(" "))
}

/// Everything the chain says about the account, at one final block.
fn read_chain(reader: &mut Reader, id: &str, o: &Options, reasons: &mut Vec<Reason>, block: &mut Option<BlockRef>) -> Result<(), Stop> {
    let head = reader.head()?;
    *block = Some(BlockRef { height: head.height, hash: head.hash.clone(), time: iso(head.time_ms()) });
    let at = At::Height(head.height);
    match reader.account(id, at)? {
        None if is_implicit(id) => {
            reasons.push(reason("unused_implicit", Level::Warn, "An implicit account nobody has used yet: no history at all."))
        }
        None => reasons.push(reason("no_account", Level::Block, format!("No such account on {}: a payment cannot arrive.", o.network.name()))),
        Some(account) => {
            for entry in o.list.arena.iter().filter(|e| e.safe == id) {
                reasons.extend(arena_reasons(reader, entry, at, o.network.explorer())?);
            }
            reasons.extend(history_reasons(reader, id, &head, &account, o.window_hours)?);
            reasons.push(if account.code_hash == NO_CODE {
                reason("plain_account", Level::Info, "A plain account: no contract code.")
            } else {
                with(
                    reason("contract", Level::Info, format!("A contract, code hash {}.", account.code_hash)),
                    json!({ "code_hash": account.code_hash }),
                )
            });
        }
    }
    reasons.extend(rpc_reasons(reader));
    Ok(())
}

/// Asks the chain and the shared list about one account.
pub fn mask_check(account_id: &str, reader: &mut Reader, o: &Options) -> Result<CheckResult, CheckError> {
    let id = trimmed(account_id).to_lowercase();
    let network = o.network;
    if !account_ok(&id) {
        return Err(CheckError::InvalidAccount(format!("not a NEAR account id: {account_id}")));
    }
    if network == Network::Testnet && is_mainnet_name(&id) {
        return Err(CheckError::InvalidAccount(format!("{id} is a mainnet name; this check reads testnet")));
    }
    if network == Network::Mainnet && is_testnet_name(&id) {
        return Err(CheckError::InvalidAccount(format!("{id} is a testnet name; this check reads mainnet")));
    }
    if o.list.network() != network {
        return Err(CheckError::Failed(format!("the shared list is for {}, not {}", o.list.network, network.name())));
    }

    let mut reasons = vec![];
    for r in o.list.reports.iter().filter(|r| r.account == id) {
        let level = if r.level == "block" { Level::Block } else { Level::Warn };
        let evidence = json!({ "reported_by": r.reported_by, "added": r.added, "evidence": r.evidence });
        reasons.push(with(reason("reported", level, r.reason.clone()), evidence));
    }

    let mut block = None;
    match read_chain(reader, &id, o, &mut reasons, &mut block) {
        Ok(()) => {}
        Err(Stop::Failed(why)) => return Err(CheckError::Failed(why)),
        Err(Stop::Chain(e)) if e.kind == Kind::Disagree => {
            let said = e.message.strip_prefix("rpc: ").unwrap_or(&e.message);
            let text = format!(
                "Two RPC providers gave different answers to the same read, so the check stopped there and nothing after it was read: {said}"
            );
            let hosts: Vec<String> = reader.endpoints.iter().map(|e| host_of(e)).collect();
            reasons.push(with(reason("rpc_disagree", Level::Warn, text), json!({ "rpc": hosts.join(", ") })));
        }
        Err(Stop::Chain(e)) => {
            reasons.push(reason(
                "chain_unreadable",
                Level::Warn,
                format!("The chain could not be read, so nothing on chain was checked: {}", e.message),
            ));
        }
    }

    // Stable: reasons of one level stay in the order they were found.
    reasons.sort_by_key(|r| std::cmp::Reverse(r.level));
    let top = reasons.first().map(|r| r.level).unwrap_or(Level::Info);
    let verdict = match top {
        Level::Block => Verdict::Block,
        Level::Warn => Verdict::Warn,
        Level::Info => Verdict::Allow,
    };
    Ok(CheckResult {
        account: id,
        network: network.name(),
        verdict,
        summary: summarize(verdict, top, &reasons),
        reasons,
        block,
        checked_at: iso(o.now_ms),
        rpc: reader.endpoints.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_near_with_three_decimals_cut() {
        let ok = |y: &str| near(y).ok().unwrap();
        assert_eq!(ok("100000000000000000000000"), "0.1");
        assert_eq!(ok("1000000000000000000000000"), "1");
        assert_eq!(ok("1234999999999999999999999"), "1.234");
        assert_eq!(ok("5000000000000000000000"), "0.005");
        assert_eq!(ok("0"), "0");
        assert!(near("a lot").is_err());
    }

    #[test]
    fn writes_a_contracts_value_as_javascript_writes_it() {
        assert_eq!(js_text(None), "undefined");
        for (value, text) in [
            (json!(null), "null"),
            (json!("nova.testnet"), "nova.testnet"),
            (json!(7), "7"),
            (json!(true), "true"),
            (json!({ "account": "x" }), "[object Object]"),
            (json!(["a", null, 2, ["b", "c"]]), "a,,2,b,c"),
        ] {
            assert_eq!(js_text(Some(&value)), text);
        }
        assert_eq!(js_join(&[json!("a"), json!(null), json!("b")], ", "), "a, , b");
    }

    #[test]
    fn strips_the_endpoint_from_an_error() {
        assert_eq!(after_endpoint("https://near.drpc.org: HTTP 502, invalid JSON"), "HTTP 502, invalid JSON");
        assert_eq!(after_endpoint("rpc: https://a.example: down"), "https://a.example: down");
        assert_eq!(after_endpoint("no endpoint here"), "no endpoint here");
    }
}
