// The drain judge reads the break from the chain itself. A live safe on testnet holds NEAR for a sealed round
// (RULES.md); a mask breaks it with its own key, reveals the plan it sealed, and the bounty contract asks: did the
// mask's transactions play exactly that plan on the safe, and did the plan move at least `min_loot` out of the safe to
// the mask? The answer comes from final transactions and state, read through every RPC source the judge has. All of
// them must give the same answer.
//
// What the judge checks:
// - every transaction of the revealed plan: signed by the mask, sent to the safe, exactly the call the plan names,
//   successful, in order, between the end of the commit window and the deadline;
// - the safe was locked to this round: the bounty contract that asked armed it for this very round, with the end of
//   its commit window, so nobody moved it before the window closed;
// - the plan is the mask's own turn on the safe, whole: its first call started the mask's one turn, in which the safe
//   was back as the round left it and nobody else could move it, and each call moved the safe once, in that turn, the
//   moves numbered one after another. A move of another mask in its own turn spoils no plan; a mask that moved the
//   safe outside its plan has used its turn;
// - the safe runs the code the round named, at the opening and at the drain, and nobody holds a key to it; when the
//   round opened it was its own owner and let in exactly the round's masks, so the team cannot move it itself;
// - the loot: what the plan moved from the safe to the mask, net of anything the mask put in, and never more than
//   the safe actually lost.

use crate::judge::account_ok;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// What the bounty contract sends for a drain. Numbers come as decimal strings (`U128`, `U64`).
#[derive(Deserialize, Debug, Clone)]
pub struct DrainInput {
    /// The bounty contract that asks: the one that armed the safe for the round.
    #[serde(default)]
    pub contract: Option<String>,
    pub bounty_id: String,
    pub safe: String,
    pub mask: String,
    pub tx_hash: String,
    pub min_loot: String,
    /// The end of the commit window, under its older name.
    pub opened_ns: String,
    pub deadline_ns: String,
    /// The revealed plan and the transaction of each of its calls, in order. `tx_hash` is one of them.
    #[serde(default)]
    pub plan: Option<Vec<PlanCall>>,
    #[serde(default)]
    pub plan_txs: Option<Vec<String>>,
    /// The block at which the round opened: the safe's code and keys then are checked too.
    #[serde(default)]
    pub opened_height: Option<String>,
    #[serde(default)]
    pub commit_until: Option<String>,
    /// The code hash the round named for the safe, base58.
    #[serde(default)]
    pub safe_code: Option<String>,
    /// The round's masks: the safe must let in exactly these.
    #[serde(default)]
    pub masks: Option<Vec<String>>,
}

/// One call of a revealed plan.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct PlanCall {
    pub method: String,
    pub args: Value,
}

/// Calls in one revealed plan.
pub const MAX_PLAN_CALLS: usize = 12;
/// The standard a safe of the arena logs its events under: `move` for every move, `turn` for a mask's first.
pub const SAFE_STANDARD: &str = "maskwars_safe";
/// A contract earns this share of the gas its calls burn: the safe's balance grows by it with every call.
const REWARD_NUM: u128 = 3;
const REWARD_DEN: u128 = 10;

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
pub struct DrainVerdict {
    pub bounty_id: String,
    pub winner: String,
    pub tx_hash: String,
    /// yoctoNEAR the mask took out of the safe with its plan, net of what it put in.
    pub loot: String,
    pub block_height: u64,
    /// The safe's code at the drain, so anyone can check which contract was drained.
    pub safe_code_hash: String,
}

/// One NEAR RPC endpoint. `rpc` returns the whole JSON-RPC response body.
pub trait Chain {
    fn name(&self) -> &str;
    fn rpc(&self, method: &str, params: Value) -> Result<Value, String>;
}

struct Terms<'a> {
    input: &'a DrainInput,
    contract: &'a str,
    min_loot: u128,
    commit_until: u64,
    deadline_ns: u64,
    calls: &'a [PlanCall],
    txs: &'a [String],
    opened_height: u64,
    safe_code: &'a str,
    masks: &'a [String],
}

/// A NEAR transaction hash or code hash: base58 of 32 bytes.
pub fn tx_hash_ok(h: &str) -> bool {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    (32..=44).contains(&h.len()) && h.bytes().all(|c| B58.contains(&c))
}

fn terms(input: &DrainInput) -> Result<Terms<'_>, String> {
    if !tx_hash_ok(&input.tx_hash) {
        return Err("bad transaction hash".into());
    }
    if !account_ok(&input.safe) || !account_ok(&input.mask) || input.safe == input.mask {
        return Err("bad safe or mask account".into());
    }
    let bad = |_| "bad number".to_string();
    let min_loot = input.min_loot.parse::<u128>().map_err(bad)?;
    let commit_until = input.commit_until.as_deref().unwrap_or(&input.opened_ns).parse::<u64>().map_err(bad)?;
    let deadline_ns = input.deadline_ns.parse::<u64>().map_err(bad)?;
    if min_loot == 0 || commit_until >= deadline_ns {
        return Err("bad bounty terms".into());
    }
    let (Some(calls), Some(txs), Some(height)) = (&input.plan, &input.plan_txs, &input.opened_height) else {
        return Err("bad plan".into());
    };
    let fits = (1..=MAX_PLAN_CALLS).contains(&calls.len()) && calls.len() == txs.len();
    let hashes_ok = txs.iter().enumerate().all(|(i, h)| tx_hash_ok(h) && !txs[..i].contains(h));
    if !fits || !hashes_ok || !txs.contains(&input.tx_hash) {
        return Err("bad plan".into());
    }
    let opened_height = height.parse::<u64>().map_err(bad)?;
    let safe_code = input.safe_code.as_deref().filter(|c| tx_hash_ok(c)).ok_or("bad bounty terms: no safe code")?;
    let masks = input.masks.as_deref().filter(|m| m.contains(&input.mask)).ok_or("bad bounty terms: no masks")?;
    let contract = input.contract.as_deref().filter(|c| account_ok(c)).ok_or("bad bounty terms: no contract")?;
    Ok(Terms { input, contract, min_loot, commit_until, deadline_ns, calls, txs, opened_height, safe_code, masks })
}

/// Every source must confirm the same drain; one that fails or disagrees fails the claim.
pub fn judge_drain(input: &DrainInput, sources: &[&dyn Chain]) -> Result<DrainVerdict, String> {
    let t = terms(input)?;
    let mut agreed: Option<DrainVerdict> = None;
    for source in sources {
        let v = read_drain(&t, *source).map_err(|e| format!("{}: {e}", source.name()))?;
        match &agreed {
            None => agreed = Some(v),
            Some(a) if *a == v => {}
            Some(_) => return Err("the RPC sources disagree".into()),
        }
    }
    agreed.ok_or_else(|| "no RPC source".into())
}

fn result(body: Value) -> Result<Value, String> {
    if let Some(e) = body.get("error") {
        let why = e.pointer("/cause/name").or_else(|| e.get("name")).and_then(Value::as_str).unwrap_or("error");
        return Err(format!("RPC answered {why}"));
    }
    body.get("result").cloned().ok_or_else(|| "RPC answered nothing".into())
}

fn s<'v>(v: &'v Value, ptr: &str) -> &'v str {
    v.pointer(ptr).and_then(Value::as_str).unwrap_or("")
}

fn yocto(v: &Value, ptr: &str) -> Result<u128, String> {
    s(v, ptr).parse::<u128>().map_err(|_| format!("unreadable amount at {ptr}"))
}

/// The NEAR an action carries: `Transfer` and `FunctionCall` keep it in `deposit`, as a decimal string.
fn deposits(actions: &Value) -> Result<u128, String> {
    let mut sum: u128 = 0;
    for action in actions.as_array().into_iter().flatten() {
        let Some(body) = action.as_object().and_then(|o| o.values().next()) else {
            continue;
        };
        if let Some(d) = body.get("deposit") {
            let d = d.as_str().and_then(|d| d.parse::<u128>().ok()).ok_or("unreadable deposit")?;
            sum = sum.checked_add(d).ok_or("deposit overflow")?;
        }
    }
    Ok(sum)
}

fn succeeded(status: &Value) -> bool {
    status.get("SuccessValue").is_some() || status.get("SuccessReceiptId").is_some()
}

/// One of the mask's transactions to the safe, final and inside the race.
struct Sent {
    tx: Value,
    /// The block that took the transaction in: the safe's state there is the state before its call.
    block_hash: String,
    height: u64,
    /// The outcome of the receipt that ran the call on the safe.
    on_safe: Value,
}

fn read_sent(t: &Terms, chain: &dyn Chain, hash: &str) -> Result<Sent, String> {
    let (safe, mask) = (t.input.safe.as_str(), t.input.mask.as_str());
    let tx = result(chain.rpc(
        "EXPERIMENTAL_tx_status",
        json!({ "tx_hash": hash, "sender_account_id": mask, "wait_until": "FINAL" }),
    )?)?;
    if s(&tx, "/final_execution_status") != "FINAL" {
        return Err("the transaction is not final".into());
    }
    if s(&tx, "/transaction/hash") != hash {
        return Err("another transaction came back".into());
    }
    if s(&tx, "/transaction/signer_id") != mask {
        return Err("the mask did not sign this transaction".into());
    }
    if s(&tx, "/transaction/receiver_id") != safe {
        return Err("the transaction did not go to the safe".into());
    }
    let block_hash = s(&tx, "/transaction_outcome/block_hash").to_string();
    if block_hash.is_empty() {
        return Err("no block for the transaction".into());
    }
    let block = result(chain.rpc("block", json!({ "block_id": block_hash }))?)?;
    let at = block.pointer("/header/timestamp_nanosec").and_then(Value::as_str).and_then(|n| n.parse::<u64>().ok());
    let at = at.or_else(|| block.pointer("/header/timestamp").and_then(Value::as_u64)).ok_or("no block time")?;
    let height = block.pointer("/header/height").and_then(Value::as_u64).ok_or("no block height")?;
    if at < t.commit_until || at >= t.deadline_ns {
        return Err("the drain happened outside the race".into());
    }
    // The transaction's one receipt runs the call on the safe.
    let first = s(&tx, "/transaction_outcome/outcome/receipt_ids/0").to_string();
    let on_safe = tx
        .get("receipts_outcome")
        .and_then(Value::as_array)
        .and_then(|o| o.iter().find(|o| s(o, "/id") == first))
        .cloned()
        .ok_or("no receipt on the safe")?;
    if s(&on_safe, "/outcome/executor_id") != safe {
        return Err("the transaction did not run on the safe".into());
    }
    Ok(Sent { tx, block_hash, height, on_safe })
}

/// The safe's own events in the receipt that ran a call: `(event, data)`.
fn safe_events(sent: &Sent) -> Vec<(String, Value)> {
    let logs = sent.on_safe.pointer("/outcome/logs").and_then(Value::as_array).cloned().unwrap_or_default();
    logs.iter()
        .filter_map(|l| l.as_str()?.strip_prefix("EVENT_JSON:").and_then(|e| serde_json::from_str::<Value>(e).ok()))
        .filter(|e| s(e, "/standard") == SAFE_STANDARD)
        .map(|e| (s(&e, "/event").to_string(), e.get("data").cloned().unwrap_or(Value::Null)))
        .collect()
}

/// The one move a call made on the safe, from the safe's own event: its number and the turn it was made in.
fn move_of(t: &Terms, sent: &Sent) -> Result<(u64, u64), String> {
    let mut moves = vec![];
    for (event, data) in safe_events(sent) {
        if event != "move" {
            continue;
        }
        if s(&data, "/by") != t.input.mask {
            return Err("the safe counted the move for someone else".into());
        }
        let n = data.get("n").and_then(Value::as_u64).ok_or("unreadable move")?;
        let turn =
            data.get("turn").and_then(Value::as_u64).ok_or("the safe counts no turns: it is not locked to rounds")?;
        moves.push((n, turn));
    }
    match moves.as_slice() {
        [m] => Ok(*m),
        [] => Err("a call of the plan did not move the safe".into()),
        _ => Err("a call of the plan moved the safe more than once".into()),
    }
}

/// The turn a call started on the safe, if it started one: `(turn, its first move)`, for the mask only.
fn turn_started(t: &Terms, sent: &Sent) -> Option<(u64, u64)> {
    safe_events(sent).into_iter().find_map(|(event, data)| {
        let mine = event == "turn" && s(&data, "/by") == t.input.mask;
        mine.then(|| Some((data.get("turn")?.as_u64()?, data.get("from")?.as_u64()?))).flatten()
    })
}

/// What a plan moved from the safe to the mask, and what the mask put in: the transaction's own deposit, plus any
/// later receipt from the mask to the safe that went through (a contract on the mask's account can send more). The
/// receipt the transaction itself became carries the same deposit and is not counted twice.
fn flows(t: &Terms, sent: &Sent) -> Result<(u128, u128), String> {
    let (safe, mask) = (t.input.safe.as_str(), t.input.mask.as_str());
    let tx = &sent.tx;
    let mut put_in = deposits(&tx["transaction"]["actions"])?;
    let first: Vec<&str> = tx
        .pointer("/transaction_outcome/outcome/receipt_ids")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let outcomes = tx.get("receipts_outcome").and_then(Value::as_array).ok_or("no receipts")?;
    let ok = |id: &str| outcomes.iter().any(|o| s(o, "/id") == id && succeeded(&o["outcome"]["status"]));
    let mut taken: u128 = 0;
    for r in tx.get("receipts").and_then(Value::as_array).ok_or("no receipts")? {
        let (from, to, id) = (s(r, "/predecessor_id"), s(r, "/receiver_id"), s(r, "/receipt_id"));
        if !ok(id) {
            continue;
        }
        let d = deposits(&r["receipt"]["Action"]["actions"])?;
        if from == safe && to == mask {
            taken = taken.checked_add(d).ok_or("deposit overflow")?;
        } else if from == mask && to == safe && !first.contains(&id) {
            put_in = put_in.checked_add(d).ok_or("deposit overflow")?;
        }
    }
    Ok((taken, put_in))
}

/// The most the safe's balance could have grown by from its own calls in the plan: the gas reward on each.
fn rewards(t: &Terms, sent: &Sent) -> u128 {
    let outcomes = sent.tx.get("receipts_outcome").and_then(Value::as_array).cloned().unwrap_or_default();
    outcomes
        .iter()
        .filter(|o| s(o, "/outcome/executor_id") == t.input.safe)
        .filter_map(|o| s(o, "/outcome/tokens_burnt").parse::<u128>().ok())
        .map(|burnt| burnt * REWARD_NUM / REWARD_DEN + 1)
        .sum()
}

fn query(chain: &dyn Chain, request: Value) -> Result<Value, String> {
    result(chain.rpc("query", request)?)
}

fn view_account(chain: &dyn Chain, safe: &str, block_id: Value) -> Result<Value, String> {
    query(chain, json!({ "request_type": "view_account", "account_id": safe, "block_id": block_id }))
}

/// The code an account runs, by hash: its own wasm, or a global contract it uses by hash (then NEAR shows its own code
/// hash as all ones, which means no code, and the global one in `global_contract_hash`). A global contract by hash
/// never changes. One used by an account's name can be redeployed by that account at any time, so it counts as no code
/// the round could name, and so does no code at all.
fn code_of(account: &Value) -> &str {
    const NO_CODE: &str = "11111111111111111111111111111111";
    if account.get("global_contract_account_id").is_some_and(|v| !v.is_null()) {
        return "";
    }
    match account.get("global_contract_hash").and_then(Value::as_str) {
        Some(global) => global,
        None => Some(s(account, "/code_hash")).filter(|c| *c != NO_CODE).unwrap_or_default(),
    }
}

/// Nobody holds a key to the safe at that block: only its code moves its NEAR.
fn keyless(chain: &dyn Chain, safe: &str, block_id: Value) -> Result<(), String> {
    let r = query(chain, json!({ "request_type": "view_access_key_list", "account_id": safe, "block_id": block_id }))?;
    match r.get("keys").and_then(Value::as_array) {
        Some(keys) if keys.is_empty() => Ok(()),
        Some(_) => Err("someone holds a key to the safe".into()),
        None => Err("no key list for the safe".into()),
    }
}

/// A view of the safe at a block, as JSON.
fn safe_view(chain: &dyn Chain, t: &Terms, method: &str, args: Value, block_id: Value) -> Result<Value, String> {
    let r = query(
        chain,
        json!({ "request_type": "call_function", "account_id": t.input.safe, "method_name": method,
                "args_base64": base64_encode(args.to_string().as_bytes()), "block_id": block_id }),
    )?;
    let bytes: Vec<u8> = r
        .get("result")
        .and_then(Value::as_array)
        .ok_or_else(|| format!("the safe did not answer {method}"))?
        .iter()
        .map(|b| b.as_u64().and_then(|b| u8::try_from(b).ok()))
        .collect::<Option<_>>()
        .ok_or("the safe's answer is not bytes")?;
    serde_json::from_slice(&bytes).map_err(|_| "the safe's answer is not JSON".to_string())
}

/// When the round opened, the safe was its own owner and let in exactly the round's masks: nobody else, the team
/// included, could move it.
fn sealed_off(chain: &dyn Chain, t: &Terms) -> Result<(), String> {
    let at = json!(t.opened_height);
    let owner = safe_view(chain, t, "get_owner", json!({}), at.clone())?;
    if owner.as_str() != Some(t.input.safe.as_str()) {
        return Err("the safe was not its own owner when the round opened".into());
    }
    let masks = safe_view(chain, t, "masks", json!({}), at)?;
    let mut theirs: Vec<&str> = masks.as_array().ok_or("unreadable masks")?.iter().filter_map(Value::as_str).collect();
    let mut ours: Vec<&str> = t.masks.iter().map(String::as_str).collect();
    theirs.sort_unstable();
    ours.sort_unstable();
    if theirs != ours {
        return Err("the safe let in other accounts than the round's masks".into());
    }
    Ok(())
}

/// The safe was locked to this round: the bounty contract that asks armed it for this bounty, with the end of the
/// commit window, so nobody could move it before the window closed.
fn locked_to_round(chain: &dyn Chain, t: &Terms, block_hash: &str) -> Result<(), String> {
    let r = safe_view(chain, t, "get_round", json!({}), json!(block_hash))?;
    let opens = r.get("opens_ns").and_then(Value::as_str).and_then(|n| n.parse::<u64>().ok());
    if r.is_null()
        || s(&r, "/arbiter") != t.contract
        || s(&r, "/bounty") != t.input.bounty_id
        || opens != Some(t.commit_until)
    {
        return Err("the safe was not locked to this round".into());
    }
    Ok(())
}

fn read_drain(t: &Terms, chain: &dyn Chain) -> Result<DrainVerdict, String> {
    let (safe, mask) = (t.input.safe.as_str(), t.input.mask.as_str());

    // Every call of the plan, in order, each one move of the safe right after the other, all in one turn.
    let mut sents: Vec<Sent> = vec![];
    let mut first: Option<(u64, u64)> = None;
    for (i, (call, hash)) in t.calls.iter().zip(t.txs).enumerate() {
        let sent = read_sent(t, chain, hash)?;
        if !makes_call(&sent.tx, call) {
            return Err("a transaction is not the call the plan names".into());
        }
        if !succeeded(&sent.tx["status"]) {
            return Err("a call of the plan failed".into());
        }
        if sents.last().is_some_and(|prev| sent.height < prev.height) {
            return Err("the plan's transactions are out of order".into());
        }
        let (n, turn) = move_of(t, &sent)?;
        match first {
            None => first = Some((n, turn)),
            Some((n0, turn0)) => {
                if n != n0 + i as u64 {
                    return Err("someone moved the safe between the plan's calls".into());
                }
                if turn != turn0 {
                    return Err("a call of the plan was made outside the mask's turn".into());
                }
            }
        }
        sents.push(sent);
    }
    let start = &sents[0];
    let drain_at = t.txs.iter().position(|h| *h == t.input.tx_hash).ok_or("bad plan")?;
    let drain = &sents[drain_at];

    // The plan is the mask's own turn from its first move: the safe was back as the round left it, and the mask had
    // not moved it before (a mask has one turn).
    let (n0, turn0) = first.ok_or("bad plan")?;
    if turn_started(t, start) != Some((turn0, n0)) {
        return Err("the plan did not start the mask's own turn on the safe".into());
    }
    locked_to_round(chain, t, &start.block_hash)?;

    // The safe the round named: its code at the opening and at the drain, and no key to it.
    let executed = s(&drain.on_safe, "/block_hash").to_string();
    if executed.is_empty() {
        return Err("no block for the drain".into());
    }
    let opened = view_account(chain, safe, json!(t.opened_height))?;
    let after = view_account(chain, safe, json!(executed))?;
    for code in [code_of(&opened), code_of(&after)] {
        if code != t.safe_code {
            return Err("the safe does not run the code the round named".into());
        }
    }
    keyless(chain, safe, json!(t.opened_height))?;
    sealed_off(chain, t)?;
    keyless(chain, safe, json!(executed))?;

    // The loot: what the plan moved out to the mask, net of what it put in, and never more than the safe lost.
    let (mut taken, mut put_in, mut slack) = (0u128, 0u128, 0u128);
    for sent in &sents[..=drain_at] {
        let (out, back) = flows(t, sent)?;
        taken = taken.checked_add(out).ok_or("deposit overflow")?;
        put_in = put_in.checked_add(back).ok_or("deposit overflow")?;
        slack += rewards(t, sent);
    }
    let before = view_account(chain, safe, json!(start.block_hash))?;
    let lost = yocto(&before, "/amount")?.saturating_sub(yocto(&after, "/amount")?).saturating_add(slack);
    let loot = taken.saturating_sub(put_in).min(lost);
    if loot < t.min_loot {
        return Err("the safe did not lose enough to the mask".into());
    }
    Ok(DrainVerdict {
        bounty_id: t.input.bounty_id.clone(),
        winner: mask.to_string(),
        tx_hash: t.input.tx_hash.clone(),
        loot: loot.to_string(),
        block_height: drain.height,
        safe_code_hash: t.safe_code.to_string(),
    })
}

/// Did the transaction make exactly this call: one function call, this method, these arguments?
fn makes_call(tx: &Value, call: &PlanCall) -> bool {
    let Some([action]) = tx.pointer("/transaction/actions").and_then(Value::as_array).map(Vec::as_slice) else {
        return false;
    };
    let Some(f) = action.get("FunctionCall") else {
        return false;
    };
    let args =
        f.get("args").and_then(Value::as_str).and_then(base64).and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    f.get("method_name").and_then(Value::as_str) == Some(call.method.as_str()) && args.as_ref() == Some(&call.args)
}

const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding, as NEAR RPC writes function call arguments.
fn base64(text: &str) -> Option<Vec<u8>> {
    let body = text.trim_end_matches('=');
    if text.len() % 4 != 0 || text.len() - body.len() > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in body.bytes() {
        acc = (acc << 6) | ABC.iter().position(|&x| x == c)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
        for i in 0..4 {
            out.push(if i <= chunk.len() { ABC[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAFE: &str = "safe-0002.tinygif8324.testnet";
    const CONTRACT: &str = "bounty.tinygif8324.testnet";
    const MASK: &str = "nova.tinygif8324.testnet";
    const ONYX: &str = "onyx.tinygif8324.testnet";
    const OWNER_TX: &str = "7vZy5fJ3bQhW2nT8kR4mX1cLpA6sDgE7uYoHiNjKwMzV";
    const TX: &str = "9vZy5fJ3bQhW2nT8kR4mX1cLpA6sDgE7uYoHiNjKwMzV";
    /// The blocks that took the plan's two transactions in, and the blocks their calls ran on the safe in.
    const BLOCK0: &str = "2Xk8pQ2rT5vW9yB1cD4fG6hJ7kL8mN9oP1qR2sT3uV4w";
    const BLOCK: &str = "3Xk8pQ2rT5vW9yB1cD4fG6hJ7kL8mN9oP1qR2sT3uV4w";
    const EXEC0: &str = "4Xk8pQ2rT5vW9yB1cD4fG6hJ7kL8mN9oP1qR2sT3uV4w";
    const EXEC: &str = "5Xk8pQ2rT5vW9yB1cD4fG6hJ7kL8mN9oP1qR2sT3uV4w";
    const CODE: &str = "7Hq3rXbK9mP2vW5yZ8cD1fG4hJ6kL9nQ2sT5uV8wX1yA";
    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
    const OPENED_HEIGHT: u64 = 42;
    /// The commit window closes at 1000 ns; the race ends at 9000 ns.
    const COMMIT_UNTIL: u64 = 1000;
    /// Gas the safe's call burns, in yoctoNEAR.
    const BURNT: u128 = 300_000_000_000_000_000_000;

    /// The safe's event for move `n`, made in turn `turn`.
    fn event(n: u64, by: &str, turn: u64) -> String {
        format!(
            r#"EVENT_JSON:{{"standard":"maskwars_safe","version":"1.1.0","event":"move","data":{{"n":{n},"by":"{by}","turn":{turn}}}}}"#
        )
    }

    /// The safe's event for a mask's turn, starting at move `from`.
    fn turn_event(turn: u64, by: &str, from: u64) -> String {
        format!(
            r#"EVENT_JSON:{{"standard":"maskwars_safe","version":"1.1.0","event":"turn","data":{{"turn":{turn},"by":"{by}","from":{from},"until_ns":"99999"}}}}"#
        )
    }

    /// NOVA's turn on the safe is the third: two other masks had theirs right after the window, moves 1 to 4.
    const TURN: u64 = 3;

    fn call_args(args: Value) -> String {
        base64_encode(args.to_string().as_bytes())
    }

    fn sweep_args() -> Value {
        json!({ "to": MASK, "amount": (3 * NEAR).to_string() })
    }

    fn transfer(id: &str, from: &str, to: &str, yocto: u128) -> Value {
        json!({ "receipt_id": id, "predecessor_id": from, "receiver_id": to,
                "receipt": { "Action": { "signer_id": MASK, "actions": [ { "Transfer": { "deposit": yocto.to_string() } } ] } } })
    }

    fn outcome(id: &str, ok: bool, executor: &str, block: &str, logs: Vec<String>) -> Value {
        let status = if ok { json!({ "SuccessValue": "" }) } else { json!({ "Failure": { "ActionError": {} } }) };
        json!({ "id": id, "block_hash": block,
                "outcome": { "status": status, "executor_id": executor, "logs": logs, "tokens_burnt": BURNT.to_string() } })
    }

    /// A transaction of the mask to the safe: one function call, run on the safe in `exec` with these events.
    fn call_tx(hash: &str, method: &str, args: Value, block: &str, exec: &str, logs: Vec<String>) -> Value {
        let r = format!("{}-r", &hash[..4]);
        json!({
            "final_execution_status": "FINAL",
            "status": { "SuccessValue": "" },
            "transaction": { "hash": hash, "signer_id": MASK, "receiver_id": SAFE,
                "actions": [ { "FunctionCall": { "method_name": method, "args": call_args(args), "gas": 30000000000000u64, "deposit": "0" } } ] },
            "transaction_outcome": { "id": hash, "block_hash": block, "outcome": { "receipt_ids": [r], "status": { "SuccessReceiptId": r } } },
            "receipts": [
                { "receipt_id": r, "predecessor_id": MASK, "receiver_id": SAFE, "receipt": { "Action": { "signer_id": MASK, "actions": [] } } },
            ],
            "receipts_outcome": [ outcome(&r, true, SAFE, exec, logs) ],
        })
    }

    /// The sweep: the safe sends `yocto` to the mask, the mask gets a gas refund from `system`.
    fn sweep_tx(yocto: u128) -> Value {
        let mut tx = call_tx(TX, "sweep", sweep_args(), BLOCK, EXEC, vec![event(6, MASK, TURN)]);
        tx["receipts"]
            .as_array_mut()
            .unwrap()
            .extend([transfer("r2", SAFE, MASK, yocto), transfer("r3", "system", MASK, 5)]);
        tx["receipts_outcome"]
            .as_array_mut()
            .unwrap()
            .extend([outcome("r2", true, MASK, EXEC, vec![]), outcome("r3", true, MASK, EXEC, vec![])]);
        tx
    }

    /// The plan's first call starts NOVA's turn at move 5.
    fn owner_tx() -> Value {
        let logs = vec![turn_event(TURN, MASK, 5), event(5, MASK, TURN)];
        call_tx(OWNER_TX, "set_owner", json!({ "new_owner": MASK }), BLOCK0, EXEC0, logs)
    }

    fn block(height: u64, at: u64) -> Value {
        json!({ "header": { "height": height, "timestamp": at, "timestamp_nanosec": at.to_string() } })
    }

    fn account(amount: u128, code: &str) -> Value {
        json!({ "amount": amount.to_string(), "locked": "0", "code_hash": code })
    }

    /// A canned RPC for one sealed round as it went: the bounty contract armed the safe for the round; right after the
    /// window two other masks had their turns (moves 1 to 4); then the mask's turn: set_owner (move 5) and the sweep
    /// (move 6), which took 3 NEAR.
    struct Rpc {
        name: &'static str,
        txs: Vec<(&'static str, Value)>,
        blocks: Vec<(&'static str, Value)>,
        /// The safe's `get_round`: the round it is armed for.
        round: Value,
        accounts: Vec<(Value, Value)>,
        keys: Vec<(Value, Value)>,
        /// The safe's `get_owner` and `masks` when the round opened.
        owner: Value,
        masks: Value,
    }

    impl Chain for Rpc {
        fn name(&self) -> &str {
            self.name
        }
        fn rpc(&self, method: &str, p: Value) -> Result<Value, String> {
            let found = |v: Option<&Value>| match v {
                Some(r) => json!({ "jsonrpc": "2.0", "id": "1", "result": r }),
                None => {
                    json!({ "jsonrpc": "2.0", "id": "1", "error": { "name": "HANDLER_ERROR", "cause": { "name": "UNKNOWN_BLOCK" } } })
                }
            };
            let body = match (method, p["request_type"].as_str()) {
                ("EXPERIMENTAL_tx_status", _) if p["sender_account_id"] == MASK && p["wait_until"] == "FINAL" => {
                    match self.txs.iter().find(|(h, _)| p["tx_hash"] == *h) {
                        Some((_, tx)) => json!({ "jsonrpc": "2.0", "id": "1", "result": tx }),
                        None => {
                            json!({ "jsonrpc": "2.0", "id": "1", "error": { "name": "HANDLER_ERROR", "cause": { "name": "UNKNOWN_TRANSACTION" } } })
                        }
                    }
                }
                ("block", _) => found(self.blocks.iter().find(|(h, _)| p["block_id"] == *h).map(|(_, b)| b)),
                ("query", Some("call_function"))
                    if p["account_id"] == SAFE && p["block_id"] == BLOCK0 && p["method_name"] == "get_round" =>
                {
                    found(Some(&json!({ "result": self.round.to_string().into_bytes(), "logs": [] })))
                }
                ("query", Some("call_function"))
                    if p["account_id"] == SAFE
                        && p["block_id"] == json!(OPENED_HEIGHT)
                        && p["method_name"] == "get_owner" =>
                {
                    found(Some(&json!({ "result": self.owner.to_string().into_bytes(), "logs": [] })))
                }
                ("query", Some("call_function"))
                    if p["account_id"] == SAFE
                        && p["block_id"] == json!(OPENED_HEIGHT)
                        && p["method_name"] == "masks" =>
                {
                    found(Some(&json!({ "result": self.masks.to_string().into_bytes(), "logs": [] })))
                }
                ("query", Some("view_account")) if p["account_id"] == SAFE => {
                    found(self.accounts.iter().find(|(b, _)| p["block_id"] == *b).map(|(_, a)| a))
                }
                ("query", Some("view_access_key_list")) if p["account_id"] == SAFE => {
                    found(self.keys.iter().find(|(b, _)| p["block_id"] == *b).map(|(_, k)| k))
                }
                _ => {
                    json!({ "jsonrpc": "2.0", "id": "1", "error": { "name": "HANDLER_ERROR", "cause": { "name": "UNKNOWN" } } })
                }
            };
            Ok(body)
        }
    }

    fn armed(contract: &str, bounty: &str, opens: u64) -> Value {
        json!({ "arbiter": contract, "bounty": bounty, "opens_ns": opens.to_string(), "armed_ns": "10" })
    }

    fn played() -> Rpc {
        let no_keys = json!({ "keys": [], "block_height": 1 });
        Rpc {
            name: "a",
            txs: vec![(OWNER_TX, owner_tx()), (TX, sweep_tx(3 * NEAR))],
            blocks: vec![(BLOCK0, block(770, 4000)), (BLOCK, block(777, 5000))],
            round: armed(CONTRACT, "race-0004", COMMIT_UNTIL),
            accounts: vec![
                (json!(OPENED_HEIGHT), account(10 * NEAR, CODE)),
                (json!(BLOCK0), account(10 * NEAR, CODE)),
                // The safe lost 3 NEAR and earned a little gas back.
                (json!(EXEC), account(7 * NEAR + 1_000, CODE)),
            ],
            keys: vec![(json!(OPENED_HEIGHT), no_keys.clone()), (json!(EXEC), no_keys)],
            owner: json!(SAFE),
            masks: json!([ONYX, MASK]),
        }
    }

    fn plan() -> Vec<PlanCall> {
        vec![
            PlanCall { method: "set_owner".into(), args: json!({ "new_owner": MASK }) },
            PlanCall { method: "sweep".into(), args: sweep_args() },
        ]
    }

    fn input() -> DrainInput {
        DrainInput {
            contract: Some(CONTRACT.into()),
            bounty_id: "race-0004".into(),
            safe: SAFE.into(),
            mask: MASK.into(),
            tx_hash: TX.into(),
            min_loot: NEAR.to_string(),
            opened_ns: COMMIT_UNTIL.to_string(),
            deadline_ns: "9000".into(),
            plan: Some(plan()),
            plan_txs: Some(vec![OWNER_TX.into(), TX.into()]),
            opened_height: Some(OPENED_HEIGHT.to_string()),
            commit_until: Some(COMMIT_UNTIL.to_string()),
            safe_code: Some(CODE.into()),
            masks: Some(vec![MASK.into(), ONYX.into()]),
        }
    }

    fn err(rpc: &Rpc) -> String {
        judge_drain(&input(), &[rpc]).unwrap_err()
    }

    #[test]
    fn a_mask_that_played_its_revealed_plan_on_the_safe_as_the_window_left_it_wins() {
        let v = judge_drain(&input(), &[&played()]).unwrap();
        assert_eq!(v.winner, MASK);
        assert_eq!(v.tx_hash, TX);
        assert_eq!(v.loot, (3 * NEAR).to_string());
        assert_eq!(v.block_height, 777);
        assert_eq!(v.safe_code_hash, CODE);
    }

    #[test]
    fn a_move_by_another_mask_right_after_the_window_spoils_no_plan() {
        // H1. Two other masks moved the safe first, right after the window (moves 1 to 4, turns 1 and 2): under the old
        // rule one such move refused every plan not yet started. Now each had its own turn, and NOVA's plan is its own
        // turn from its first move, on the safe as the round left it.
        assert_eq!(played().txs[0].1["receipts_outcome"][0]["outcome"]["logs"][0], json!(turn_event(3, MASK, 5)));
        assert!(judge_drain(&input(), &[&played()]).is_ok());
    }

    #[test]
    fn a_safe_not_locked_to_this_round_confirms_nothing() {
        // H1. The safe must have been armed by the contract that asks, for this bounty, with the end of its commit
        // window: then nobody moved it, the masks included, while plans were still being sealed.
        for round in [
            Value::Null,
            armed("team.testnet", "race-0004", COMMIT_UNTIL),
            armed(CONTRACT, "race-0005", COMMIT_UNTIL),
            armed(CONTRACT, "race-0004", COMMIT_UNTIL - 1),
            json!({ "bounty": "race-0004", "opens_ns": COMMIT_UNTIL.to_string() }),
        ] {
            let mut rpc = played();
            rpc.round = round.clone();
            assert_eq!(err(&rpc), "a: the safe was not locked to this round", "{round}");
        }
        // A safe of the old code counts no turns: it is not locked to rounds, and no plan on it counts.
        let mut rpc = played();
        rpc.txs[0].1["receipts_outcome"][0]["outcome"]["logs"] = json!([
            r#"EVENT_JSON:{"standard":"maskwars_safe","version":"1.0.0","event":"move","data":{"n":5,"by":"nova.tinygif8324.testnet"}}"#
        ]);
        assert_eq!(err(&rpc), "a: the safe counts no turns: it is not locked to rounds");
        // And a round without the contract that asks is no round.
        let mut i = input();
        i.contract = None;
        assert_eq!(judge_drain(&i, &[&played()]).unwrap_err(), "bad bounty terms: no contract");
    }

    #[test]
    fn a_mask_that_moved_the_safe_outside_its_plan_has_used_its_turn() {
        // Its turn started with a move of its own before the plan (move 4): the plan began on a safe it had moved.
        let mut rpc = played();
        rpc.txs[0].1["receipts_outcome"][0]["outcome"]["logs"] = json!([event(5, MASK, TURN)]);
        assert_eq!(err(&rpc), "a: the plan did not start the mask's own turn on the safe");
    }

    #[test]
    fn a_gambler_that_borrowed_a_move_outside_its_plan_is_refused() {
        // It sealed only `sweep` and took the safe with a set_owner of its own in its turn, outside its plan.
        let mut i = input();
        i.plan = Some(vec![PlanCall { method: "sweep".into(), args: sweep_args() }]);
        i.plan_txs = Some(vec![TX.into()]);
        assert_eq!(
            judge_drain(&i, &[&played()]).unwrap_err(),
            "a: the plan did not start the mask's own turn on the safe"
        );
    }

    #[test]
    fn the_turn_the_plan_starts_must_open_at_its_first_move() {
        // A turn event of another mask, another turn or another first move does not make the plan a turn of its own.
        for turn in [turn_event(TURN, ONYX, 5), turn_event(TURN + 1, MASK, 5), turn_event(TURN, MASK, 4)] {
            let mut rpc = played();
            rpc.txs[0].1["receipts_outcome"][0]["outcome"]["logs"] = json!([turn, event(5, MASK, TURN)]);
            assert_eq!(err(&rpc), "a: the plan did not start the mask's own turn on the safe", "{turn}");
        }
    }

    #[test]
    fn every_call_of_the_plan_is_made_in_the_same_turn() {
        let mut rpc = played();
        rpc.txs[1].1["receipts_outcome"][0]["outcome"]["logs"] = json!([event(6, MASK, TURN + 1)]);
        assert_eq!(err(&rpc), "a: a call of the plan was made outside the mask's turn");
    }

    #[test]
    fn nobody_may_move_the_safe_between_the_plans_calls() {
        let mut rpc = played();
        rpc.txs[1].1["receipts_outcome"][0]["outcome"]["logs"] = json!([event(7, MASK, TURN)]);
        assert_eq!(err(&rpc), "a: someone moved the safe between the plan's calls");
    }

    #[test]
    fn every_call_of_the_plan_is_one_move_of_the_mask() {
        let mut rpc = played();
        rpc.txs[0].1["receipts_outcome"][0]["outcome"]["logs"] = json!(["owner nova -> nova"]);
        assert_eq!(err(&rpc), "a: a call of the plan did not move the safe");
        let mut rpc = played();
        rpc.txs[0].1["receipts_outcome"][0]["outcome"]["logs"] =
            json!([turn_event(TURN, MASK, 5), event(5, MASK, TURN), event(6, MASK, TURN)]);
        assert_eq!(err(&rpc), "a: a call of the plan moved the safe more than once");
        let mut rpc = played();
        rpc.txs[0].1["receipts_outcome"][0]["outcome"]["logs"] = json!([event(5, ONYX, TURN)]);
        assert_eq!(err(&rpc), "a: the safe counted the move for someone else");
        let mut rpc = played();
        rpc.txs[0].1["receipts_outcome"][0]["outcome"]["executor_id"] = json!("proxy.testnet");
        assert_eq!(err(&rpc), "a: the transaction did not run on the safe");
    }

    #[test]
    fn the_safe_runs_the_code_the_round_named_from_the_opening_to_the_drain() {
        for at in [json!(OPENED_HEIGHT), json!(EXEC)] {
            let mut rpc = played();
            rpc.accounts.iter_mut().find(|(b, _)| *b == at).unwrap().1["code_hash"] = json!("Other111");
            assert_eq!(err(&rpc), "a: the safe does not run the code the round named", "{at}");
        }
        let mut i = input();
        i.safe_code = None;
        assert_eq!(judge_drain(&i, &[&played()]).unwrap_err(), "bad bounty terms: no safe code");
    }

    #[test]
    fn a_safe_from_global_code_is_named_by_the_global_hash() {
        // A safe made by the season treasury: no wasm of its own, the global contract by its hash.
        let mut rpc = played();
        for (_, a) in rpc.accounts.iter_mut() {
            a["code_hash"] = json!("11111111111111111111111111111111");
            a["global_contract_hash"] = json!(CODE);
        }
        assert!(judge_drain(&input(), &[&rpc]).is_ok());
        // The all-ones hash is no code at all: it never matches a round that named it.
        let mut rpc = played();
        for (_, a) in rpc.accounts.iter_mut() {
            a["code_hash"] = json!("11111111111111111111111111111111");
        }
        let mut i = input();
        i.safe_code = Some("11111111111111111111111111111111".into());
        assert!(judge_drain(&i, &[&rpc]).is_err());
        // Code used by an account's name can change under the round: it never counts.
        for at in [json!(OPENED_HEIGHT), json!(EXEC)] {
            let mut rpc = played();
            let a = &mut rpc.accounts.iter_mut().find(|(b, _)| *b == at).unwrap().1;
            a["code_hash"] = json!("11111111111111111111111111111111");
            a["global_contract_hash"] = json!(CODE);
            a["global_contract_account_id"] = json!("publisher.testnet");
            assert_eq!(err(&rpc), "a: the safe does not run the code the round named", "{at}");
        }
    }

    #[test]
    fn nobody_holds_a_key_to_the_safe() {
        for at in [json!(OPENED_HEIGHT), json!(EXEC)] {
            let mut rpc = played();
            rpc.keys.iter_mut().find(|(b, _)| *b == at).unwrap().1 = json!({ "keys": [{ "public_key": "ed25519:x", "access_key": { "nonce": 1, "permission": "FullAccess" } }] });
            assert_eq!(err(&rpc), "a: someone holds a key to the safe", "{at}");
        }
    }

    #[test]
    fn the_team_could_not_move_the_safe_itself() {
        // A safe of known code, but its owner is the team: it could take the NEAR the moment a mask started.
        let mut rpc = played();
        rpc.owner = json!("team.testnet");
        assert_eq!(err(&rpc), "a: the safe was not its own owner when the round opened");
        // Or the safe lets in a twin of the team that is not a mask of the round.
        let mut rpc = played();
        rpc.masks = json!([ONYX, MASK, "twin.testnet"]);
        assert_eq!(err(&rpc), "a: the safe let in other accounts than the round's masks");
        let mut rpc = played();
        rpc.masks = json!([MASK]);
        assert_eq!(err(&rpc), "a: the safe let in other accounts than the round's masks");
        // A round with no masks named, or the claiming mask not among them, is no round.
        let mut i = input();
        i.masks = Some(vec![ONYX.into()]);
        assert_eq!(judge_drain(&i, &[&played()]).unwrap_err(), "bad bounty terms: no masks");
    }

    #[test]
    fn the_loot_is_never_more_than_the_safe_lost() {
        // The transfer says 3 NEAR, but the safe's balance fell by 0.5 NEAR: the mask had paid in 2.5 NEAR by hand.
        let mut rpc = played();
        rpc.accounts[2].1 = account(10 * NEAR - NEAR / 2, CODE);
        assert_eq!(err(&rpc), "a: the safe did not lose enough to the mask");
    }

    #[test]
    fn the_masks_own_money_in_any_call_of_the_plan_does_not_count() {
        // The mask sends 2.5 NEAR with set_owner and gets 3 NEAR back with the sweep: 0.5 NEAR of loot.
        let mut rpc = played();
        rpc.txs[0].1["transaction"]["actions"][0]["FunctionCall"]["deposit"] = json!((5 * NEAR / 2).to_string());
        assert_eq!(err(&rpc), "a: the safe did not lose enough to the mask");
        // In the sweep's own transaction too.
        let mut rpc = played();
        rpc.txs[1].1["transaction"]["actions"][0]["FunctionCall"]["deposit"] = json!((5 * NEAR / 2).to_string());
        assert_eq!(err(&rpc), "a: the safe did not lose enough to the mask");
    }

    #[test]
    fn the_transactions_own_deposit_counts_once() {
        let mut rpc = played();
        rpc.txs[1].1["transaction"]["actions"][0]["FunctionCall"]["deposit"] = json!(NEAR.to_string());
        rpc.txs[1].1["receipts"][0]["receipt"]["Action"]["actions"] =
            json!([{ "FunctionCall": { "deposit": NEAR.to_string() } }]);
        assert_eq!(judge_drain(&input(), &[&rpc]).unwrap().loot, (2 * NEAR).to_string());
    }

    #[test]
    fn money_the_mask_sends_the_safe_later_in_the_transaction_does_not_count() {
        // A contract on the mask's account pays the safe 2 NEAR and gets 2.5 NEAR back: 0.5 NEAR of loot.
        let mut rpc = played();
        let tx = &mut rpc.txs[1].1;
        tx["receipts"][1] = transfer("r2", SAFE, MASK, 5 * NEAR / 2);
        tx["receipts"].as_array_mut().unwrap().push(transfer("r4", MASK, SAFE, 2 * NEAR));
        tx["receipts_outcome"].as_array_mut().unwrap().push(outcome("r4", true, SAFE, EXEC, vec![]));
        assert_eq!(err(&rpc), "a: the safe did not lose enough to the mask");
        // A payment that failed came back to the mask: it was never put in.
        let n = rpc.txs[1].1["receipts_outcome"].as_array().unwrap().len();
        rpc.txs[1].1["receipts_outcome"][n - 1] = outcome("r4", false, SAFE, EXEC, vec![]);
        rpc.accounts[2].1 = account(10 * NEAR - 5 * NEAR / 2, CODE);
        assert!(judge_drain(&input(), &[&rpc]).is_ok());
    }

    #[test]
    fn too_little_loot_wins_nothing() {
        let mut rpc = played();
        rpc.txs[1].1 = sweep_tx(NEAR - 1);
        assert_eq!(err(&rpc), "a: the safe did not lose enough to the mask");
    }

    #[test]
    fn a_failed_transfer_is_no_loot() {
        let mut rpc = played();
        rpc.txs[1].1["receipts_outcome"][1] = outcome("r2", false, MASK, EXEC, vec![]);
        assert!(judge_drain(&input(), &[&rpc]).is_err());
    }

    #[test]
    fn money_to_someone_else_or_from_someone_else_does_not_count() {
        for (from, to) in [(SAFE, "friend.testnet"), ("other-vault.testnet", MASK), ("system", MASK)] {
            let mut rpc = played();
            rpc.txs[1].1["receipts"][1] = transfer("r2", from, to, 3 * NEAR);
            assert!(judge_drain(&input(), &[&rpc]).is_err(), "{from} -> {to}");
        }
    }

    #[test]
    fn a_transaction_must_be_the_call_the_plan_names() {
        for (method, args) in [
            ("sweep", json!({ "to": MASK, "amount": (2 * NEAR).to_string() })),
            ("withdraw", sweep_args()),
            ("sweep", json!({ "to": "friend.testnet", "amount": (3 * NEAR).to_string() })),
        ] {
            let mut i = input();
            i.plan.as_mut().unwrap()[1] = PlanCall { method: method.into(), args };
            assert_eq!(
                judge_drain(&i, &[&played()]).unwrap_err(),
                "a: a transaction is not the call the plan names",
                "{method}"
            );
        }
        // Two actions in one transaction are not one call.
        let mut rpc = played();
        let action = rpc.txs[1].1["transaction"]["actions"][0].clone();
        rpc.txs[1].1["transaction"]["actions"].as_array_mut().unwrap().push(action);
        assert!(judge_drain(&input(), &[&rpc]).is_err());
    }

    #[test]
    fn every_call_of_the_plan_must_succeed_in_order_inside_the_race() {
        let mut rpc = played();
        rpc.txs[0].1["status"] = json!({ "Failure": { "ActionError": {} } });
        assert_eq!(err(&rpc), "a: a call of the plan failed");

        let mut rpc = played();
        rpc.blocks[0].1["header"]["height"] = json!(800);
        assert_eq!(err(&rpc), "a: the plan's transactions are out of order");

        // A call made before the commit window closed, or after the deadline.
        for at in [999, 9000] {
            let mut rpc = played();
            rpc.blocks[0].1["header"]["timestamp_nanosec"] = json!(at.to_string());
            assert_eq!(err(&rpc), "a: the drain happened outside the race", "{at}");
        }

        // A plan transaction signed by someone else.
        let mut rpc = played();
        rpc.txs[0].1["transaction"]["signer_id"] = json!("onyx.tinygif8324.testnet");
        assert_eq!(err(&rpc), "a: the mask did not sign this transaction");
    }

    #[test]
    fn only_the_masks_own_final_transaction_to_the_safe_counts() {
        for (ptr, v) in [
            ("/transaction/signer_id", "tinygif8324.testnet"),
            ("/transaction/receiver_id", "open-admin.testnet"),
            ("/transaction/hash", "11111111111111111111111111111111"),
            ("/final_execution_status", "EXECUTED_OPTIMISTIC"),
        ] {
            let mut rpc = played();
            *rpc.txs[1].1.pointer_mut(ptr).unwrap() = json!(v);
            assert!(judge_drain(&input(), &[&rpc]).is_err(), "{ptr}");
        }
    }

    #[test]
    fn a_plan_comes_whole() {
        let cases: [fn(&mut DrainInput); 7] = [
            |i| i.plan = None,
            |i| i.plan_txs = None,
            |i| i.opened_height = None,
            |i| i.plan_txs = Some(vec![OWNER_TX.into()]),
            |i| i.plan_txs = Some(vec![OWNER_TX.into(), OWNER_TX.into()]),
            // The claimed drain is not among the plan's transactions.
            |i| i.tx_hash = "22222222222222222222222222222222".into(),
            |i| {
                i.plan = Some(vec![]);
                i.plan_txs = Some(vec![]);
            },
        ];
        for (n, case) in cases.iter().enumerate() {
            let mut i = input();
            case(&mut i);
            assert_eq!(judge_drain(&i, &[&played()]).unwrap_err(), "bad plan", "case {n}");
        }
    }

    #[test]
    fn a_round_too_old_for_the_rpc_is_not_confirmed() {
        let mut rpc = played();
        rpc.accounts.remove(0);
        assert_eq!(err(&rpc), "a: RPC answered UNKNOWN_BLOCK");
    }

    #[test]
    fn every_source_must_agree() {
        let a = played();
        let b = Rpc { name: "b", ..played() };
        assert!(judge_drain(&input(), &[&a, &b]).is_ok());
        let mut liar = Rpc { name: "b", ..played() };
        liar.txs[1].1 = sweep_tx(4 * NEAR);
        liar.accounts[2].1 = account(6 * NEAR, CODE);
        assert_eq!(judge_drain(&input(), &[&a, &liar]).unwrap_err(), "the RPC sources disagree");
        let mut blind = Rpc { name: "b", ..played() };
        blind.txs.clear();
        assert!(judge_drain(&input(), &[&a, &blind]).unwrap_err().starts_with("b: "));
        assert_eq!(judge_drain(&input(), &[]).unwrap_err(), "no RPC source");
    }

    /// A14 on mainnet: the worker's RPC, FastNEAR and dRPC (`public_rpcs`). The drain holds only when all three read
    /// it the same way; one that lies, or knows nothing of the drain, fails the claim, which never pays on two of three.
    #[test]
    fn three_sources_all_must_agree() {
        let worker = played();
        let fastnear = Rpc { name: "fastnear", ..played() };
        let drpc = Rpc { name: "drpc", ..played() };
        assert!(judge_drain(&input(), &[&worker, &fastnear, &drpc]).is_ok());
        let mut liar = Rpc { name: "drpc", ..played() };
        liar.txs[1].1 = sweep_tx(4 * NEAR);
        liar.accounts[2].1 = account(6 * NEAR, CODE);
        assert_eq!(judge_drain(&input(), &[&worker, &fastnear, &liar]).unwrap_err(), "the RPC sources disagree");
        let mut blind = Rpc { name: "drpc", ..played() };
        blind.txs.clear();
        assert!(judge_drain(&input(), &[&worker, &fastnear, &blind]).unwrap_err().starts_with("drpc: "));
    }

    #[test]
    fn an_unknown_transaction_is_refused() {
        let mut rpc = played();
        rpc.txs.remove(1);
        assert_eq!(err(&rpc), "a: RPC answered UNKNOWN_TRANSACTION");
    }

    #[test]
    fn bad_terms_never_reach_the_chain() {
        let cases: [(&str, &str); 6] = [
            ("tx_hash", "0OIl-not-base58"),
            ("tx_hash", "short"),
            ("mask", "NOVA"),
            ("safe", MASK),
            ("min_loot", "0"),
            ("deadline_ns", "1000"),
        ];
        for (field, bad) in cases {
            let mut i = input();
            match field {
                "tx_hash" => i.tx_hash = bad.into(),
                "mask" => i.mask = bad.into(),
                "safe" => i.safe = bad.into(),
                "min_loot" => i.min_loot = bad.into(),
                _ => i.deadline_ns = bad.into(),
            }
            assert!(judge_drain(&i, &[]).is_err(), "{field}");
            assert_ne!(judge_drain(&i, &[]).unwrap_err(), "no RPC source", "{field}");
        }
    }

    #[test]
    fn the_commit_window_is_read_under_either_name() {
        let mut i = input();
        i.commit_until = None;
        assert!(judge_drain(&i, &[&played()]).is_ok());
        i.opened_ns = "4500".into();
        assert_eq!(judge_drain(&i, &[&played()]).unwrap_err(), "a: the drain happened outside the race");
    }

    #[test]
    fn base64_reads_what_near_writes() {
        for text in ["", "a", "ab", "abc", r#"{"new_owner":"nova.tinygif8324.testnet"}"#] {
            assert_eq!(base64(&base64_encode(text.as_bytes())).unwrap(), text.as_bytes(), "{text}");
        }
        assert_eq!(base64("eyJhIjoxfQ==").unwrap(), br#"{"a":1}"#);
        assert!(base64("abc").is_none());
    }
}
