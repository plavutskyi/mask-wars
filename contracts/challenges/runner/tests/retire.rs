//! Retiring a safe (`retire` in live-safe), on a real local node. A safe nobody holds a key to kept the NEAR its code
//! locks for good; now its team retires it once its round is over, the safe deletes its own account, and all it holds
//! goes to the team. The account that made the safe (the house: the team, and the safe's parent account) makes it
//! again under the same name for the next round.
//!
//! Everything on chain is the real code: the bounty contract, the safe, made by its parent in one transaction that
//! adds no key, and the judge (services/judge), which reads the sandbox's own RPC. Only OutLayer is a stand-in
//! (`outlayer-stub`), as in tests/round.rs.
//!
//! - a won round: before its deadline nobody retires the safe, the team included; from the deadline on the team does,
//!   the account is gone, and the team has all it held, the NEAR its code locked included;
//! - a round nobody won: the safe stays while the bounty is open, and goes once it is refunded;
//! - a safe that took no round goes at once;
//! - 16 masks with the longest names NEAR allows, all of them played: the safe's state still fits what NEAR lets an
//!   account delete (10 000 bytes besides its code);
//! - the safe made again under the same name by the same parent takes a second round, which the same mask wins with
//!   the same keys and the real judge confirms.

use anyhow::{bail, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use race_runner::build_targets;
use race_runner::round::{bounty_wasm_path, code_hash, sandbox, seal_hash, NoGitHub, SandboxRpc, SANDBOX_JUDGE};
use race_runner::wasm_dir;
use serde_json::{json, Value};
use std::sync::Once;
use std::task::Poll;
use std::time::Duration;

fn built() {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| build_targets().expect("build wasm"));
}

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// NEAR locks this much for every byte an account stores.
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// The most an account may store besides its code and still be deleted (nearcore, `action_delete_account`).
const MAX_STATE_TO_DELETE: u64 = 10_000;
/// A mask's turn on the safe (`TURN_NS` in live-safe).
const TURN_NS: u64 = 3 * 60 * 1_000_000_000;
const HOUR_NS: u64 = 3_600_000_000_000;
/// What the team attaches to `retire`: the call itself, 10 TGas for the bounty contract's answer and 10 for the
/// safe's own. Enough for the biggest safe there can be.
const RETIRE_GAS: Gas = Gas::from_tgas(30);
/// A contract earns a share of the gas its calls burn: a safe's balance grows by dust with every call.
const DUST: u128 = ONE_NEAR / 1000;

/// A mask: its account, and the key it uses on the bounty contract and on the safe. With full keys both are the
/// account's own; `only_round_keys` swaps them for two function-call keys.
struct Mask {
    id: AccountId,
    on_bounty: Account,
    on_safe: Account,
}

struct World {
    _node: near_sandbox::Sandbox,
    worker: Worker<Sandbox>,
    /// The team of every round here, and the account that makes the safe as its sub-account.
    house: Account,
    bounty: AccountId,
    stub: Contract,
    masks: Vec<Mask>,
    stranger: Account,
    safe_wasm: Vec<u8>,
    safe_code: String,
}

async fn view(worker: &Worker<Sandbox>, id: &AccountId, method: &str, args: Value) -> Result<Value> {
    Ok(worker.view(id, method).args_json(args).await?.json()?)
}

async fn now(worker: &Worker<Sandbox>) -> Result<u64> {
    Ok(worker.view_block().await?.timestamp())
}

/// Lets sandbox time pass until `at`, in steps of up to an hour of blocks.
async fn wait_until(worker: &Worker<Sandbox>, at: u64) -> Result<()> {
    for _ in 0..400 {
        let t = now(worker).await?;
        if t >= at {
            return Ok(());
        }
        let blocks = ((at - t) / 1_000_000_000).clamp(20, 3600);
        worker.fast_forward(blocks).await?;
    }
    bail!("sandbox time did not reach {at}");
}

async fn balance(worker: &Worker<Sandbox>, id: &AccountId) -> Result<u128> {
    Ok(worker.view_account(id).await?.balance.as_yoctonear())
}

/// Lets the gas refunds of the calls so far land, so a balance read next is what the account really has.
async fn settled(worker: &Worker<Sandbox>, id: &AccountId) -> Result<u128> {
    worker.fast_forward(5).await?;
    balance(worker, id).await
}

/// The NEAR a call burnt for gas, all of it paid by whoever signed it. A share of what a contract's own calls burn
/// goes to that contract instead of being burnt.
fn burnt(r: &ExecutionFinalResult) -> u128 {
    r.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear()).sum()
}

/// Whether the account is gone from the chain.
async fn gone(worker: &Worker<Sandbox>, id: &AccountId) -> Result<bool> {
    match worker.view_account(id).await {
        Ok(_) => Ok(false),
        Err(e) => {
            let text = format!("{e:?}");
            if text.contains("UnknownAccount") || text.contains("does not exist") {
                return Ok(true);
            }
            bail!("view {id}: {text}")
        }
    }
}

/// How many keys the account holds.
async fn keys(worker: &Worker<Sandbox>, id: &AccountId) -> Result<usize> {
    Ok(worker.view_access_keys(id).await?.len())
}

/// Why a call failed: every failed receipt's own words.
fn why(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.failures())
}

/// The gas each receipt of a call burnt, by who ran it.
fn gas(r: &ExecutionFinalResult) -> String {
    let each: Vec<String> = r
        .receipt_outcomes()
        .iter()
        .map(|o| format!("{} {:.2}", o.executor_id, o.gas_burnt.as_gas() as f64 / 1e12))
        .collect();
    format!("total {:.2} TGas; {}", r.total_gas_burnt.as_gas() as f64 / 1e12, each.join(", "))
}

/// The safe's own events of one kind in a call's logs.
fn events(r: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|e| serde_json::from_str::<Value>(e).ok())
        .filter(|e| e["standard"] == "maskwars_safe" && e["event"] == name)
        .collect()
}

/// A fresh node with the bounty contract, born without a key, the house, the masks and a stranger. `house`, `bounty`
/// and `masks` are the accounts' names under the sandbox root.
async fn world(house: &str, bounty: &str, masks: &[String]) -> Result<World> {
    built();
    let read = |p: std::path::PathBuf| std::fs::read(&p).with_context(|| format!("read {}", p.display()));
    let bounty_wasm = read(bounty_wasm_path())?;
    let safe_wasm = read(wasm_dir().join("live_safe.wasm"))?;
    let stub_wasm = read(wasm_dir().join("outlayer_stub.wasm"))?;
    let safe_code = code_hash(&safe_wasm);

    let (node, worker) = sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: String, near: u128| {
        let root = root.clone();
        async move {
            root.create_subaccount(&name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await?
                .into_result()
                .with_context(|| format!("create {name}"))
        }
    };
    let house = sub(house.into(), 30).await?;
    let stranger = sub("stranger".into(), 10).await?;
    let mut accounts = vec![];
    for name in masks {
        let a = sub(name.clone(), 10).await?;
        accounts.push(Mask { id: a.id().clone(), on_bounty: a.clone(), on_safe: a });
    }
    let stub = sub("outlayer".into(), 10).await?.deploy(&stub_wasm).await?.into_result()?;
    let bounty: AccountId = format!("{bounty}.{}", root.id()).parse()?;
    root.batch(&bounty)
        .create_account()
        .transfer(NearToken::from_near(10))
        .deploy(&bounty_wasm)
        .call(
            Function::new("new")
                .args_json(json!({ "outlayer": stub.id(), "judge_project": "house/judge",
                                   "judge_version": SANDBOX_JUDGE, "admin": house.id(), "safe_codes": [safe_code] }))
                .gas(Gas::from_tgas(50)),
        )
        .transact()
        .await?
        .into_result()
        .context("deploy the bounty contract")?;
    Ok(World { _node: node, worker, house, bounty, stub, masks: accounts, stranger, safe_wasm, safe_code })
}

/// Swaps every mask's full key for two function-call keys, as the masks hold them on chain: one on the bounty
/// contract for the round's methods, one on `safe` for the calls a drain is made of. The key on the safe names the
/// safe's account only: it does not care how many times that account is made.
async fn only_round_keys(w: &mut World, safe: &AccountId) -> Result<()> {
    for m in w.masks.iter_mut() {
        let full = m.on_bounty.clone();
        let (for_bounty, for_safe) =
            (SecretKey::from_random(KeyType::ED25519), SecretKey::from_random(KeyType::ED25519));
        let round_methods: &[&str] = &["commit", "reveal", "claim_drain", "settle"];
        full.batch(full.id())
            .add_key(for_bounty.public_key(), AccessKey::function_call_access(&w.bounty, round_methods, None))
            .add_key(for_safe.public_key(), AccessKey::function_call_access(safe, &["set_owner", "sweep"], None))
            .delete_key(full.secret_key().public_key())
            .transact()
            .await?
            .into_result()?;
        m.on_bounty = Account::from_secret_key(m.id.clone(), for_bounty, &w.worker);
        m.on_safe = Account::from_secret_key(m.id.clone(), for_safe, &w.worker);
        let held = w.worker.view_access_keys(&m.id).await?;
        let limited = held.iter().all(|k| matches!(k.access_key.permission, AccessKeyPermission::FunctionCall(_)));
        assert!(held.len() == 2 && limited, "{} holds two function-call keys", m.id);
    }
    Ok(())
}

/// The house makes the safe `name.<house>` in one transaction that adds no key: the account, its NEAR, the code and
/// `new`, with the bounty contract as its arbiter and the house as its team. The same call makes it again once the
/// old one is gone.
async fn make_safe(w: &World, name: &str, near: u128) -> Result<AccountId> {
    let safe: AccountId = format!("{name}.{}", w.house.id()).parse()?;
    let masks: Vec<&AccountId> = w.masks.iter().map(|m| &m.id).collect();
    w.house
        .batch(&safe)
        .create_account()
        .transfer(NearToken::from_near(near))
        .deploy(&w.safe_wasm)
        .call(
            Function::new("new")
                .args_json(json!({ "owner": safe, "masks": masks, "arbiter": w.bounty, "team": w.house.id() }))
                .gas(Gas::from_tgas(30)),
        )
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("make {safe}"))?;
    assert_eq!(keys(&w.worker, &safe).await?, 0, "nobody holds a key to {safe}");
    Ok(safe)
}

/// The house opens a sealed round on the safe with 1 NEAR; the round as the bounty contract shows it.
async fn open(w: &World, id: &str, safe: &AccountId, commit_minutes: u64, reveal_minutes: u64) -> Result<Value> {
    let masks: Vec<&AccountId> = w.masks.iter().map(|m| &m.id).collect();
    w.house
        .call(&w.bounty, "open_safe")
        .args_json(json!({ "id": id, "safe": safe, "masks": masks, "min_loot": ONE_NEAR.to_string(), "hours": 1,
                           "commit_minutes": commit_minutes, "reveal_minutes": reveal_minutes,
                           "safe_code": w.safe_code, "judge_version": SANDBOX_JUDGE }))
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("open {id}"))?;
    let lock = view(&w.worker, safe, "get_round", json!({})).await?;
    assert_eq!(lock["bounty"], id, "the safe is armed for the round");
    view(&w.worker, &w.bounty, "get_round", json!({ "id": id })).await
}

async fn bounty_state(w: &World, id: &str) -> Result<Value> {
    view(&w.worker, &w.bounty, "get", json!({ "id": id })).await
}

/// The planted hole: take the safe, sweep `near` NEAR to the mask.
fn the_hole(mask: &AccountId, near: u128) -> Vec<Value> {
    vec![
        json!({ "method": "set_owner", "args": { "new_owner": mask } }),
        json!({ "method": "sweep", "args": { "to": mask, "amount": (near * ONE_NEAR).to_string() } }),
    ]
}

/// A plan that only takes the safe: one move, and the mask has had its turn.
fn a_touch(mask: &AccountId) -> Vec<Value> {
    vec![json!({ "method": "set_owner", "args": { "new_owner": mask } })]
}

/// A sealed plan: its text and the salt of its seal.
struct Sealed {
    calls: Vec<Value>,
    plan: String,
    salt: String,
}

/// The mask seals `calls` in the commit window.
async fn seal(w: &World, id: &str, mask: usize, calls: Vec<Value>) -> Result<Sealed> {
    let m = &w.masks[mask];
    let plan = serde_json::to_string(&calls)?;
    let salt = format!("mask-{mask:02}-retire-salt-0001");
    let hash = seal_hash(id, m.id.as_str(), &salt, &plan);
    m.on_bounty
        .call(&w.bounty, "commit")
        .args_json(json!({ "id": id, "hash": hash }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("{} seals", m.id))?;
    Ok(Sealed { calls, plan, salt })
}

/// Lets sandbox time pass until the safe lets the mask in: its slot has come and nobody else has the safe.
async fn until_the_safe_lets_in(w: &World, safe: &AccountId, mask: usize) -> Result<()> {
    for _ in 0..200 {
        let waits = view(&w.worker, safe, "waits_for", json!({ "account_id": w.masks[mask].id })).await?;
        match waits.as_str() {
            None => return Ok(()),
            Some(w) if w.contains("another mask has its turn") || w.contains("an earlier seal goes first") => {}
            Some(w) => bail!("the safe never lets the mask in: {w}"),
        }
        w.worker.fast_forward(20).await?;
    }
    bail!("sandbox time did not reach the mask's turn");
}

/// The mask plays its sealed plan on the safe, one transaction a call; the transactions.
async fn play(w: &World, safe: &AccountId, mask: usize, sealed: &Sealed) -> Result<Vec<String>> {
    until_the_safe_lets_in(w, safe, mask).await?;
    let mut txs = vec![];
    for c in &sealed.calls {
        let r = w.masks[mask]
            .on_safe
            .call(safe, c["method"].as_str().unwrap())
            .args_json(&c["args"])
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        txs.push(r.outcome().transaction_hash.to_string());
        r.into_result().with_context(|| format!("{} plays {}", w.masks[mask].id, c["method"]))?;
    }
    Ok(txs)
}

/// The mask reveals its plan and claims its drain with nothing attached. The judge's request waits in the stub; the
/// real judge answers it from the sandbox's chain. The bounty as the contract holds it afterwards.
async fn reveal_and_claim(w: &World, id: &str, mask: usize, sealed: &Sealed, txs: &[String]) -> Result<Value> {
    let m = &w.masks[mask];
    m.on_bounty
        .call(&w.bounty, "reveal")
        .args_json(json!({ "id": id, "plan": sealed.plan, "salt": sealed.salt, "txs": txs }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .context("reveal")?;
    let asked = view(&w.worker, w.stub.id(), "requests", json!({})).await?.as_array().map_or(0, Vec::len);
    let pending = m
        .on_bounty
        .call(&w.bounty, "claim_drain")
        .args_json(json!({ "id": id, "tx_hash": txs.last().context("a drain")? }))
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    let input = loop {
        if let Poll::Ready(r) = pending.status().await? {
            bail!("the claim never reached the judge: {r:?}");
        }
        let requests = view(&w.worker, w.stub.id(), "requests", json!({})).await?;
        if let Some(r) = requests.as_array().and_then(|r| r.get(asked)) {
            break r["input"].as_str().unwrap_or("").to_string();
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let rpc = SandboxRpc::new(&w.worker.rpc_addr())?;
    let verdict = tokio::task::spawn_blocking(move || {
        maskwars_judge::answer(serde_json::from_str::<Value>(&input).ok(), &NoGitHub, &[&rpc])
    })
    .await?;
    assert!(verdict.success, "the judge refused the drain: {:?}", verdict.error);
    w.stub
        .call("answer")
        .args_json(json!({ "index": asked, "output": serde_json::to_string(&verdict)? }))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()
        .context("answer the judge's request")?;
    loop {
        if let Poll::Ready(r) = pending.status().await? {
            r.into_result().context("claim_drain")?;
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    bounty_state(w, id).await
}

/// One mask wins the round through the planted hole, start to finish: seals in the commit window, plays after it,
/// reveals, claims, and the real judge confirms. The bounty as the contract holds it afterwards.
async fn win(w: &World, id: &str, safe: &AccountId, round: &Value, mask: usize) -> Result<Value> {
    let sealed = seal(w, id, mask, the_hole(&w.masks[mask].id, 2)).await?;
    wait_until(&w.worker, round["commit_until"].as_str().context("commit_until")?.parse()?).await?;
    let txs = play(w, safe, mask, &sealed).await?;
    reveal_and_claim(w, id, mask, &sealed, &txs).await
}

async fn retire(by: &Account, safe: &AccountId) -> Result<ExecutionFinalResult> {
    Ok(by.call(safe, "retire").gas(RETIRE_GAS).transact().await?)
}

/// The team retires the safe and it goes: the account is gone, one `retired` event names the team and the round
/// (`bounty`, empty for a safe that took none), and the team has
/// all the safe held, the NEAR its code and state locked included. What the safe held.
async fn retire_and_check(w: &World, safe: &AccountId, bounty: &str) -> Result<u128> {
    let details = w.worker.view_account(safe).await?;
    let held = details.balance.as_yoctonear();
    let locked = BYTE_COST * u128::from(details.storage_usage);
    assert!(held >= locked && locked > BYTE_COST * w.safe_wasm.len() as u128, "the safe's storage locks {locked}");
    let before = settled(&w.worker, w.house.id()).await?;
    let r = retire(&w.house, safe).await?;
    println!("retire {safe}: {}", gas(&r));
    assert!(r.is_success(), "the team retires the safe: {}", why(&r));
    assert!(gone(&w.worker, safe).await?, "{safe} is gone from the chain");
    let e = events(&r, "retired");
    assert_eq!(e.len(), 1, "one retired event: {:?}", r.logs());
    assert_eq!((&e[0]["data"]["bounty"], &e[0]["data"]["to"]), (&json!(bounty), &json!(w.house.id())));
    assert_eq!(e[0]["version"], "1.5.0");
    let said: u128 = e[0]["data"]["amount"].as_str().context("amount")?.parse()?;
    assert!((held..held + DUST).contains(&said), "the event names what the safe held: {said} of {held}");
    // To the yoctoNEAR: the team paid the call's gas and got all the safe held, with the share of that gas the safe
    // itself earned on the way out.
    let after = settled(&w.worker, w.house.id()).await?;
    let gas_paid = burnt(&r);
    assert!(
        after + gas_paid >= before + held && after <= before + held,
        "the team has all the safe held, {held}, less the gas it paid, {gas_paid}: {before} then {after}"
    );
    assert!(after - before > locked, "the NEAR the safe's storage locked came back too: {locked}");
    println!(
        "retire {safe}: it held {held}, of them {locked} locked by storage; the team got {} and paid {gas_paid} of gas",
        after + gas_paid - before
    );
    Ok(held)
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn a_won_round_keeps_its_safe_until_its_deadline_and_then_the_team_has_everything() -> Result<()> {
    let w = world("house", "bounty", &names(&["nova", "onyx", "oracle"])).await?;
    let safe = make_safe(&w, "vault", 5).await?;
    let id = "retire-0001";
    let round = open(&w, id, &safe, 1, 12).await?;
    let b = win(&w, id, &safe, &round, 0).await?;
    assert_eq!((&b["status"]["state"], &b["status"]["winner"]), (&json!("drained"), &json!(w.masks[0].id)), "{b}");
    assert_eq!(view(&w.worker, &safe, "get_owner", json!({})).await?, json!(w.masks[0].id), "NOVA owns the safe now");

    // The winner is paid, and the round still has its deadline: until then the sealed masks have their turns on what
    // is left in the safe. Nobody retires it, the team included.
    let before = balance(&w.worker, &safe).await?;
    let lock = view(&w.worker, &safe, "get_round", json!({})).await?;
    let early = retire(&w.house, &safe).await?;
    println!("retire before the deadline: {}", gas(&early));
    assert!(early.is_failure(), "the team does not retire the safe before the deadline");
    assert!(why(&early).contains("the round's deadline has not come"), "{}", why(&early));
    assert!(events(&early, "retired").is_empty());
    // Nobody but the team even asks: not the mask that took the safe through the hole and owns it, not another mask
    // of the round, not a stranger.
    for who in [&w.masks[0].on_safe, &w.masks[1].on_safe, &w.stranger] {
        let r = retire(who, &safe).await?;
        assert!(r.is_failure() && why(&r).contains("only the safe's team retires it"), "{}: {}", who.id(), why(&r));
    }
    // And nobody hands the safe an answer of their own, the team included: only the safe calls `on_retire`.
    for who in [&w.house, &w.masks[0].on_safe, &w.stranger] {
        let r = who
            .call(&safe, "on_retire")
            .args_borsh(lock["armed_ns"].as_str().context("armed_ns")?.parse::<u64>()?)
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        assert!(r.is_failure() && why(&r).contains("Method on_retire is private"), "{}: {}", who.id(), why(&r));
    }
    assert!(!gone(&w.worker, &safe).await?, "the safe stands");
    let after = balance(&w.worker, &safe).await?;
    assert!((before..before + DUST).contains(&after), "nothing left the safe: {before} then {after}");
    assert_eq!(view(&w.worker, &safe, "get_round", json!({})).await?, lock, "the safe is as the round left it");

    // The deadline passes: the team retires the safe and has all it held.
    wait_until(&w.worker, round["deadline_ns"].as_str().context("deadline")?.parse()?).await?;
    retire_and_check(&w, &safe, id).await?;
    // The round's record stays on the bounty contract as it was: drained, NOVA the winner.
    assert_eq!(bounty_state(&w, id).await?, b);
    Ok(())
}

#[tokio::test]
async fn a_round_nobody_won_keeps_its_safe_until_its_bounty_is_refunded() -> Result<()> {
    let w = world("house", "bounty", &names(&["nova", "onyx", "oracle"])).await?;
    let safe = make_safe(&w, "vault", 5).await?;
    let id = "retire-0002";
    let round = open(&w, id, &safe, 1, 12).await?;
    let deadline: u64 = round["deadline_ns"].as_str().context("deadline")?.parse()?;
    let all = balance(&w.worker, &safe).await?;

    // Nobody seals. Past the deadline the bounty is still open: the masks may claim for 12 more hours, and the safe
    // stays whatever the team says.
    wait_until(&w.worker, deadline).await?;
    let open_still = retire(&w.house, &safe).await?;
    assert!(open_still.is_failure() && why(&open_still).contains("the round is not over"), "{}", why(&open_still));
    wait_until(&w.worker, deadline + 12 * HOUR_NS + 60_000_000_000).await?;
    let open_still = retire(&w.house, &safe).await?;
    assert!(open_still.is_failure() && why(&open_still).contains("the round is not over"), "{}", why(&open_still));
    assert!(!gone(&w.worker, &safe).await?, "the safe stands");

    // Anyone refunds the round; the NEAR goes to the team. Then the team takes back what the safe can pay out
    // (`reclaim`), and retires the safe for the rest: what its storage locked.
    w.stranger
        .call(&w.bounty, "refund")
        .args_json(json!({ "id": id }))
        .transact()
        .await?
        .into_result()
        .context("refund")?;
    assert_eq!(bounty_state(&w, id).await?["status"]["state"], "refunded");
    let before = settled(&w.worker, w.house.id()).await?;
    let back = w.house.call(&safe, "reclaim").gas(Gas::from_tgas(100)).transact().await?;
    assert!(back.is_success(), "reclaim: {}", why(&back));
    // The safe is left with exactly what its storage locks, not a yoctoNEAR to store a byte more: retiring must
    // not need one.
    assert_eq!(view(&w.worker, &safe, "available", json!({})).await?, json!("0"), "the safe paid out all it could");

    // The team asks twice in one transaction, before any answer is back. Both questions go out, and the first answer
    // lets the safe go. The second answer comes to nothing either way: it finds the safe going and is refused, or,
    // where the chain runs the safe's deletion right after the first answer, it finds no account at all.
    let twice = w
        .house
        .batch(&safe)
        .call(Function::new("retire").gas(RETIRE_GAS))
        .call(Function::new("retire").gas(RETIRE_GAS))
        .transact()
        .await?;
    println!("retire twice: {}", gas(&twice));
    assert_eq!(events(&twice, "retired").len(), 1, "the safe goes once: {:?}", twice.logs());
    let refused = twice.receipt_failures();
    assert_eq!(refused.len(), 1, "{refused:?}");
    let second = format!("{refused:?}");
    assert!(second.contains("the safe is retiring already") || second.contains("AccountDoesNotExist"), "{second}");
    assert!(gone(&w.worker, &safe).await?, "{safe} is gone from the chain");
    let after = settled(&w.worker, w.house.id()).await?;
    let gas_paid = burnt(&back) + burnt(&twice);
    assert!(
        after + gas_paid >= before + all && after <= before + all,
        "the team has all the safe held, {all}, less the gas it paid, {gas_paid}: {before} then {after}"
    );
    Ok(())
}

#[tokio::test]
async fn a_safe_that_took_no_round_goes_at_once_and_its_name_is_free_again() -> Result<()> {
    let w = world("house", "bounty", &names(&["nova", "onyx", "oracle"])).await?;
    let safe = make_safe(&w, "vault", 5).await?;
    // A round someone outside the team opens does not arm the safe: it is refunded at once, and the safe has no
    // round, as after an `open_safe` of the team's own that did not go through.
    let masks: Vec<&AccountId> = w.masks.iter().map(|m| &m.id).collect();
    w.stranger
        .call(&w.bounty, "open_safe")
        .args_json(json!({ "id": "intruder-0001", "safe": safe, "masks": masks, "min_loot": ONE_NEAR.to_string(),
                           "hours": 1, "commit_minutes": 1, "reveal_minutes": 12, "safe_code": w.safe_code,
                           "judge_version": SANDBOX_JUDGE }))
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(bounty_state(&w, "intruder-0001").await?["status"]["state"], "refunded");
    assert_eq!(view(&w.worker, &safe, "get_round", json!({})).await?, Value::Null);

    for who in [&w.stranger, &w.masks[0].on_safe] {
        let r = retire(who, &safe).await?;
        assert!(r.is_failure() && why(&r).contains("only the safe's team retires it"), "{}: {}", who.id(), why(&r));
    }
    // Twice in one transaction: the second call finds the deletion sent and fails, and the transaction with it.
    // Nothing happened; the team asks again.
    let twice = w
        .house
        .batch(&safe)
        .call(Function::new("retire").gas(RETIRE_GAS))
        .call(Function::new("retire").gas(RETIRE_GAS))
        .transact()
        .await?;
    assert!(twice.is_failure() && why(&twice).contains("the safe is retiring already"), "{}", why(&twice));
    assert!(!gone(&w.worker, &safe).await?, "the safe stands");

    retire_and_check(&w, &safe, "").await?;
    // The house makes the safe again under the same name, and it is a new safe.
    let again = make_safe(&w, "vault", 5).await?;
    assert_eq!(again, safe);
    assert_eq!(view(&w.worker, &safe, "get_round", json!({})).await?, Value::Null);
    assert_eq!(view(&w.worker, &safe, "team", json!({})).await?, json!(w.house.id()));
    Ok(())
}

#[tokio::test]
async fn sixteen_masks_with_the_longest_names_all_played_and_the_safe_still_goes() -> Result<()> {
    // NEAR deletes an account only if it stores at most 10 000 bytes besides its code. The safe's state is the
    // biggest it can be here: 16 masks, every account name as long as NEAR allows, the longest round id, every mask
    // sealed and moved the safe. The team is the safe's parent, so its name is two characters short of the longest.
    let root_len = ".test.near".len();
    let mask_names: Vec<String> = (0..16).map(|i| format!("m{i:02}{}", "x".repeat(64 - root_len - 3))).collect();
    let house = "h".repeat(64 - root_len - 2);
    let bounty = "b".repeat(64 - root_len);
    let w = world(&house, &bounty, &mask_names).await?;
    let safe = make_safe(&w, "v", 5).await?;
    let id = format!("round-{}", "0".repeat(58));
    for name in w.masks.iter().map(|m| &m.id).chain([&safe, &w.bounty]) {
        assert_eq!(name.len(), 64, "{name}");
    }
    assert_eq!((w.house.id().len(), id.len()), (62, 64));

    // 16 masks: a reveal window of 3 minutes each and 3 more.
    let round = open(&w, &id, &safe, 1, 51).await?;
    let commit_until: u64 = round["commit_until"].as_str().context("commit_until")?.parse()?;
    // Everyone seals: the first mask the hole, the others a plan that only takes the safe.
    let mut sealed = vec![];
    for i in 0..16 {
        let calls = if i == 0 { the_hole(&w.masks[i].id, 2) } else { a_touch(&w.masks[i].id) };
        sealed.push(seal(&w, &id, i, calls).await?);
    }
    wait_until(&w.worker, commit_until).await?;
    // Everyone plays, in the order of the seals, each in its own slot of 3 minutes. The first mask reveals, claims
    // and is paid.
    for i in 0..16 {
        wait_until(&w.worker, commit_until + TURN_NS * i as u64).await?;
        let txs = play(&w, &safe, i, &sealed[i]).await?;
        if i == 0 {
            let b = reveal_and_claim(&w, &id, 0, &sealed[0], &txs).await?;
            assert_eq!(b["status"]["state"], "drained", "{b}");
        }
    }
    for m in &w.masks {
        let t = view(&w.worker, &safe, "touches", json!({ "account_id": m.id })).await?;
        assert!(t["first_ns"].is_string(), "{} moved the safe: {t}", m.id);
    }
    assert_eq!(view(&w.worker, &safe, "get_queue", json!({})).await?.as_array().map(Vec::len), Some(16));
    assert_eq!(view(&w.worker, &safe, "touches", json!({ "account_id": safe })).await?["moves"], "17");

    let stored = w.worker.view_account(&safe).await?.storage_usage;
    let state = stored - w.safe_wasm.len() as u64;
    println!(
        "the biggest safe stores {stored} bytes: {} of code and {state} of state, of the {MAX_STATE_TO_DELETE} NEAR \
         lets a deleted account hold besides its code",
        w.safe_wasm.len()
    );
    assert!(state <= MAX_STATE_TO_DELETE / 2, "the state leaves room: {state} of {MAX_STATE_TO_DELETE}");

    wait_until(&w.worker, round["deadline_ns"].as_str().context("deadline")?.parse()?).await?;
    retire_and_check(&w, &safe, &id).await?;
    Ok(())
}

#[tokio::test]
async fn the_safe_made_again_under_the_same_name_takes_a_second_round_to_the_end() -> Result<()> {
    let mut w = world("house", "bounty", &names(&["nova", "onyx", "oracle"])).await?;
    // The masks hold function-call keys only, given once: the key on the safe names the account `vault.<house>`,
    // before that account is first made.
    let name: AccountId = format!("vault.{}", w.house.id()).parse()?;
    only_round_keys(&mut w, &name).await?;
    let nova = w.masks[0].id.clone();

    // Day one. The house makes the safe, NOVA takes it through the hole and is paid, the deadline passes, the safe
    // goes.
    let safe = make_safe(&w, "vault", 5).await?;
    assert_eq!(safe, name);
    let first = "circle-0001";
    let round = open(&w, first, &safe, 1, 12).await?;
    let b1 = win(&w, first, &safe, &round, 0).await?;
    assert_eq!((&b1["status"]["state"], &b1["status"]["winner"]), (&json!("drained"), &json!(nova)), "{b1}");
    wait_until(&w.worker, round["deadline_ns"].as_str().context("deadline")?.parse()?).await?;
    retire_and_check(&w, &safe, first).await?;

    // Day two. The same parent makes the safe again under the same name, in one transaction that adds no key. It is
    // a new safe: nothing of the old one is left in it, not the round, not the moves, not NOVA's turn.
    let again = make_safe(&w, "vault", 5).await?;
    assert_eq!(again, safe);
    let details = w.worker.view_account(&safe).await?;
    assert!(format!("{:?}", details.contract_state).contains(&w.safe_code), "the same code: {details:?}");
    assert_eq!(view(&w.worker, &safe, "get_round", json!({})).await?, Value::Null);
    assert_eq!(view(&w.worker, &safe, "get_turn", json!({})).await?, Value::Null);
    assert_eq!(view(&w.worker, &safe, "get_owner", json!({})).await?, json!(safe));
    assert_eq!(
        view(&w.worker, &safe, "touches", json!({ "account_id": nova })).await?,
        json!({ "moves": "0", "last_ns": null, "first_ns": null })
    );

    // The second round, to the end: NOVA seals, plays with the keys it was given on day one, reveals and claims; the
    // real judge reads the new safe from the chain (its code, no key, its own owner, armed for this round) and
    // confirms; the bounty contract pays.
    let second = "circle-0002";
    let round = open(&w, second, &safe, 1, 12).await?;
    let nova_before = balance(&w.worker, &nova).await?;
    let b2 = win(&w, second, &safe, &round, 0).await?;
    assert_eq!((&b2["status"]["state"], &b2["status"]["winner"]), (&json!("drained"), &json!(nova)), "{b2}");
    let won = balance(&w.worker, &nova).await? - nova_before;
    assert!(won > 2 * ONE_NEAR, "NOVA took the safe's NEAR and the bounty: {won}");
    // The first round's record is as it was.
    assert_eq!(bounty_state(&w, first).await?, b1);

    // The new safe is held by its own round: paid, but before its deadline the team does not retire it.
    let early = retire(&w.house, &safe).await?;
    assert!(early.is_failure() && why(&early).contains("the round's deadline has not come"), "{}", why(&early));
    wait_until(&w.worker, round["deadline_ns"].as_str().context("deadline")?.parse()?).await?;
    retire_and_check(&w, &safe, second).await?;
    // Not one key on the masks' accounts changed: two function-call keys each, as on day one.
    for m in &w.masks {
        assert_eq!(keys(&w.worker, &m.id).await?, 2, "{}", m.id);
    }
    Ok(())
}
