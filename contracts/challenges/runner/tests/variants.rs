//! A round by hand on a live safe of another kind (`variant` at `new`: `limit`, `pause`), on a real local node, with
//! the sums of a mainnet round: the safe holds the stake of its own storage and 0.3 NEAR to race for, a drain counts
//! from 0.1 NEAR, the deposit is 0.25 NEAR.
//!
//! Everything on chain is the real code: the bounty contract, born without a key; the safe, made by its team in one
//! transaction that adds no key; the judge (services/judge), reading the sandbox's own RPC. Only OutLayer is a stand-in
//! (`outlayer-stub`), as in tests/round.rs. The masks hold function-call keys only, as on chain: one on the bounty
//! contract, one on the safe, neither of which can attach NEAR.
//!
//! For each kind:
//! - an account the safe does not let in gets nowhere, before the window and after it, with any call of the hole;
//! - a mask that seals the plain way out (no hole) plays it in its own turn and takes nothing;
//! - a mask that seals the plan through the hole, with the amounts it found against a sandbox copy that held far
//!   more, is paid all the safe can pay out, to the yoctoNEAR; the real judge confirms the drain and the bounty
//!   contract pays it;
//! - the drained safe still retires: not before the round's deadline, then at once, and its team has everything it
//!   held, the stake of its storage included.

use anyhow::{bail, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use race_runner::build_targets;
use race_runner::round::{
    bounty_wasm_path, code_hash, sandbox, seal_hash, the_hole, NoGitHub, SandboxRpc, SANDBOX_JUDGE,
};
use race_runner::wasm_dir;
use serde_json::{json, Value};
use std::sync::Once;
use std::task::Poll;
use std::time::Duration;

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// NEAR locks this much for every byte an account stores.
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// What the masks race for: what the safe can pay out when its round opens, about.
const BANK: u128 = 3 * ONE_NEAR / 10;
/// The least a drain must take to count, as the bounty contract allows at least.
const MIN_LOOT: u128 = ONE_NEAR / 10;
/// What a plan found against the sandbox copy asks for: that copy holds 5 NEAR, the safe on chain far less.
const SANDBOX_AMOUNT: u128 = 5 * ONE_NEAR / 2;
const ID: &str = "hand-0001";

struct Mask {
    id: AccountId,
    on_bounty: Account,
    on_safe: Account,
}

struct World {
    _node: near_sandbox::Sandbox,
    worker: Worker<Sandbox>,
    /// The team of the round, and the account that makes the safe as its sub-account.
    house: Account,
    bounty: AccountId,
    stub: Contract,
    masks: Vec<Mask>,
    stranger: Account,
    safe: AccountId,
}

async fn view(worker: &Worker<Sandbox>, id: &AccountId, method: &str, args: Value) -> Result<Value> {
    Ok(worker.view(id, method).args_json(args).await?.json()?)
}

async fn balance(worker: &Worker<Sandbox>, id: &AccountId) -> Result<u128> {
    Ok(worker.view_account(id).await?.balance.as_yoctonear())
}

/// Lets sandbox time pass until `at`, in steps of up to an hour of blocks.
async fn wait_until(worker: &Worker<Sandbox>, at: u64) -> Result<()> {
    for _ in 0..400 {
        let t = worker.view_block().await?.timestamp();
        if t >= at {
            return Ok(());
        }
        worker.fast_forward(((at - t) / 1_000_000_000).clamp(20, 3600)).await?;
    }
    bail!("sandbox time did not reach {at}");
}

/// Why a call failed: every failed receipt's own words.
fn why(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.failures())
}

fn ns(v: &Value, field: &str) -> Result<u64> {
    Ok(v[field].as_str().with_context(|| format!("{field} in {v}"))?.parse()?)
}

/// A fresh node: the bounty contract with no key, the house, three masks, a stranger, and the house's safe of kind
/// `variant`, made in one transaction that adds no key. Then every mask's full key is swapped for its two round keys.
async fn world(variant: &str) -> Result<World> {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| build_targets().expect("build wasm"));
    let read = |p: std::path::PathBuf| std::fs::read(&p).with_context(|| format!("read {}", p.display()));
    let bounty_wasm = read(bounty_wasm_path())?;
    let safe_wasm = read(wasm_dir().join("live_safe.wasm"))?;
    let stub_wasm = read(wasm_dir().join("outlayer_stub.wasm"))?;
    let safe_code = code_hash(&safe_wasm);

    let (node, worker) = sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &str, near: u128| {
        let (root, name) = (root.clone(), name.to_string());
        async move {
            root.create_subaccount(&name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await?
                .into_result()
                .with_context(|| format!("create {name}"))
        }
    };
    let house = sub("house", 30).await?;
    let stranger = sub("stranger", 10).await?;
    let mut masks = vec![];
    for name in ["nova", "onyx", "oracle"] {
        let a = sub(name, 10).await?;
        masks.push(Mask { id: a.id().clone(), on_bounty: a.clone(), on_safe: a });
    }
    let stub = sub("outlayer", 10).await?.deploy(&stub_wasm).await?.into_result()?;
    let bounty: AccountId = format!("bounty.{}", root.id()).parse()?;
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

    // The safe: the stake of its code and state, and the bank on top.
    let safe: AccountId = format!("vault.{}", house.id()).parse()?;
    let ids: Vec<&AccountId> = masks.iter().map(|m| &m.id).collect();
    let fund = BYTE_COST * (safe_wasm.len() as u128 + 1000) + BANK;
    house
        .batch(&safe)
        .create_account()
        .transfer(NearToken::from_yoctonear(fund))
        .deploy(&safe_wasm)
        .call(
            Function::new("new")
                .args_json(json!({ "owner": safe, "masks": ids, "arbiter": bounty, "team": house.id(),
                                   "variant": variant }))
                .gas(Gas::from_tgas(30)),
        )
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("make {safe}"))?;
    assert_eq!(worker.view_access_keys(&safe).await?.len(), 0, "nobody holds a key to {safe}");
    assert_eq!(view(&worker, &safe, "variant", json!({})).await?, json!(variant));
    assert_eq!(view(&worker, &safe, "get_owner", json!({})).await?, json!(safe), "the safe owns itself");
    assert_eq!(
        view(&worker, &safe, "about", json!({})).await?.as_str().map(|a| a.starts_with("MASK WARS")),
        Some(true)
    );
    let version = view(&worker, &safe, "contract_source_metadata", json!({})).await?;
    assert_eq!(version["version"], "1.7.0", "{version}");

    // As on chain: a key for the round's methods on the bounty contract, and one on the safe that reaches any of its
    // methods (the masks' keys from their seeds do, packages/race/src/keys.ts). Neither attaches NEAR.
    for m in masks.iter_mut() {
        let full = m.on_bounty.clone();
        let (for_bounty, for_safe) =
            (SecretKey::from_random(KeyType::ED25519), SecretKey::from_random(KeyType::ED25519));
        let round_methods: &[&str] = &["commit", "reveal", "claim_drain", "settle"];
        full.batch(full.id())
            .add_key(for_bounty.public_key(), AccessKey::function_call_access(&bounty, round_methods, None))
            .add_key(for_safe.public_key(), AccessKey::function_call_access(&safe, &[], None))
            .delete_key(full.secret_key().public_key())
            .transact()
            .await?
            .into_result()?;
        m.on_bounty = Account::from_secret_key(m.id.clone(), for_bounty, &worker);
        m.on_safe = Account::from_secret_key(m.id.clone(), for_safe, &worker);
        let held = worker.view_access_keys(&m.id).await?;
        let limited = held.iter().all(|k| matches!(k.access_key.permission, AccessKeyPermission::FunctionCall(_)));
        assert!(held.len() == 2 && limited, "{} holds two function-call keys", m.id);
    }

    let w = World { _node: node, worker, house, bounty, stub, masks, stranger, safe };
    let ids: Vec<&AccountId> = w.masks.iter().map(|m| &m.id).collect();
    w.house
        .call(&w.bounty, "open_safe")
        .args_json(json!({ "id": ID, "safe": w.safe, "masks": ids, "min_loot": MIN_LOOT.to_string(), "hours": 1,
                           "commit_minutes": 1, "reveal_minutes": 12,
                           "safe_code": safe_code, "judge_version": SANDBOX_JUDGE }))
        .deposit(NearToken::from_yoctonear(ONE_NEAR / 4))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()
        .context("open the round")?;
    assert_eq!(view(&w.worker, &w.safe, "get_round", json!({})).await?["bounty"], ID, "the safe is armed");
    Ok(w)
}

/// A sealed plan: its calls, its text and the salt of its seal.
struct Sealed {
    calls: Vec<Value>,
    plan: String,
    salt: String,
}

async fn seal(w: &World, mask: usize, calls: Vec<Value>) -> Result<Sealed> {
    let m = &w.masks[mask];
    let plan = serde_json::to_string(&calls)?;
    let salt = format!("mask-{mask:02}-variant-salt-0001");
    m.on_bounty
        .call(&w.bounty, "commit")
        .args_json(json!({ "id": ID, "hash": seal_hash(ID, m.id.as_str(), &salt, &plan) }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("{} seals", m.id))?;
    Ok(Sealed { calls, plan, salt })
}

/// Lets sandbox time pass until the safe lets the mask in.
async fn until_the_safe_lets_in(w: &World, mask: usize) -> Result<()> {
    for _ in 0..200 {
        let waits = view(&w.worker, &w.safe, "waits_for", json!({ "account_id": w.masks[mask].id })).await?;
        match waits.as_str() {
            None => return Ok(()),
            Some(w) if w.contains("another mask has its turn") || w.contains("an earlier seal goes first") => {}
            Some(w) => bail!("the safe never lets the mask in: {w}"),
        }
        w.worker.fast_forward(20).await?;
    }
    bail!("sandbox time did not reach the mask's turn");
}

/// The mask plays its sealed plan with its key on the safe, one transaction a call, with the gas our masks give a
/// call on chain (15 TGas, packages/race/src/live.ts): each call's result, in order.
async fn play(w: &World, mask: usize, sealed: &Sealed) -> Result<Vec<ExecutionFinalResult>> {
    until_the_safe_lets_in(w, mask).await?;
    let mut out = vec![];
    for c in &sealed.calls {
        let call = w.masks[mask].on_safe.call(&w.safe, c["method"].as_str().context("method")?);
        out.push(call.args_json(&c["args"]).gas(Gas::from_tgas(15)).transact().await?);
    }
    Ok(out)
}

/// The plan's calls as the bounty contract and the judge read them.
fn calls_of(variant: &str, mask: &AccountId, amount: u128) -> Vec<Value> {
    the_hole(variant, mask.as_str(), amount)
        .into_iter()
        .map(|c| json!({ "method": c.method, "args": c.args }))
        .collect()
}

/// The plain way out of a safe of this kind, with no hole: what an honest caller would send.
fn no_hole(variant: &str) -> Vec<Value> {
    let amount = SANDBOX_AMOUNT.to_string();
    match variant {
        "limit" => vec![
            json!({ "method": "request_exit", "args": { "amount": amount } }),
            json!({ "method": "check_exit", "args": {} }),
            json!({ "method": "withdraw", "args": {} }),
        ],
        _ => {
            vec![json!({ "method": "unpause", "args": {} }), json!({ "method": "claim", "args": { "amount": amount } })]
        }
    }
}

/// The mask reveals and claims with nothing attached; the real judge answers from the sandbox's chain. Its verdict.
async fn reveal_and_claim(w: &World, mask: usize, sealed: &Sealed, txs: &[String]) -> Result<Value> {
    let m = &w.masks[mask];
    m.on_bounty
        .call(&w.bounty, "reveal")
        .args_json(json!({ "id": ID, "plan": sealed.plan, "salt": sealed.salt, "txs": txs }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .context("reveal")?;
    let asked = view(&w.worker, w.stub.id(), "requests", json!({})).await?.as_array().map_or(0, Vec::len);
    let pending = m
        .on_bounty
        .call(&w.bounty, "claim_drain")
        .args_json(json!({ "id": ID, "tx_hash": txs.last().context("a drain")? }))
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
    let said = serde_json::to_value(&verdict)?;
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
    Ok(said)
}

async fn a_hand_round(variant: &str) -> Result<()> {
    let w = world(variant).await?;
    let round = view(&w.worker, &w.bounty, "get_round", json!({ "id": ID })).await?;
    let (nova, onyx) = (0, 1);
    let hole = calls_of(variant, &w.masks[nova].id, SANDBOX_AMOUNT);
    let bank: u128 = view(&w.worker, &w.safe, "available", json!({})).await?.as_str().context("available")?.parse()?;
    assert!((BANK..BANK + ONE_NEAR / 50).contains(&bank), "the safe can pay out about 0.3 NEAR: {bank}");

    // ONYX seals the plain way out first, NOVA the plan through the hole second.
    let plain = seal(&w, onyx, no_hole(variant)).await?;
    let found = seal(&w, nova, hole.clone()).await?;

    // An account the safe does not list gets nowhere with the hole, in the window and after it; nor does a mask that
    // sealed nothing (ORACLE), nor a sealed one before the window is over.
    let stranger_tries = |when: &'static str| {
        let (hole, stranger, safe) = (hole.clone(), w.stranger.clone(), w.safe.clone());
        async move {
            for c in &hole {
                let method = c["method"].as_str().unwrap();
                let r = stranger.call(&safe, method).args_json(&c["args"]).gas(Gas::from_tgas(30)).transact().await?;
                assert!(r.is_failure(), "{when}: a stranger's {method} is refused");
                assert!(
                    why(&r).contains("this safe is open to the round's masks only"),
                    "{when} {method}: {}",
                    why(&r)
                );
            }
            anyhow::Ok(())
        }
    };
    stranger_tries("in the window").await?;
    let early = w.masks[nova].on_safe.call(&w.safe, hole[0]["method"].as_str().unwrap());
    let early = early.args_json(&hole[0]["args"]).gas(Gas::from_tgas(15)).transact().await?;
    assert!(why(&early).contains("the safe is locked until the commit window closes"), "{}", why(&early));
    wait_until(&w.worker, ns(&round, "commit_until")?).await?;
    stranger_tries("after the window").await?;
    for c in &hole {
        let call = w.masks[2].on_safe.call(&w.safe, c["method"].as_str().unwrap());
        let r = call.args_json(&c["args"]).gas(Gas::from_tgas(15)).transact().await?;
        assert!(
            why(&r).contains("only a mask that sealed a plan moves the safe"),
            "ORACLE {}: {}",
            c["method"],
            why(&r)
        );
    }
    assert_eq!(view(&w.worker, &w.safe, "touches", json!({ "account_id": w.stranger.id() })).await?["moves"], "0");

    // ONYX's turn comes first. The plain way out pays nothing: the safe holds what it held, give or take the dust a
    // contract earns from the gas of its own calls.
    let before = balance(&w.worker, &w.safe).await?;
    let plain_calls = play(&w, onyx, &plain).await?;
    let failed: Vec<String> = plain_calls.iter().filter(|r| r.is_failure()).map(why).collect();
    match variant {
        "limit" => {
            assert!(plain_calls[0].is_success(), "an exit goes on file: {}", why(&plain_calls[0]));
            assert!(failed[0].contains("owner only") && failed[1].contains("waits for the owner"), "{failed:?}");
        }
        _ => assert!(failed[0].contains("owner only") && failed[1].contains("the safe is paused"), "{failed:?}"),
    }
    let after = balance(&w.worker, &w.safe).await?;
    assert!(after >= before && after - before < ONE_NEAR / 1000, "the plain way out took nothing: {before} {after}");

    // NOVA's turn: the plan through the hole, every call one move, the last one pays all the safe can pay out.
    let mine = balance(&w.worker, &w.masks[nova].id).await?;
    let played = play(&w, nova, &found).await?;
    for (r, c) in played.iter().zip(&hole) {
        assert!(r.is_success(), "NOVA plays {}: {}", c["method"], why(r));
        println!("{variant} {}: {:.2} TGas", c["method"], r.total_gas_burnt.as_gas() as f64 / 1e12);
        assert!(r.total_gas_burnt.as_gas() < 10_000_000_000_000, "a call fits the 15 TGas a mask gives it");
    }
    w.worker.fast_forward(3).await?;
    let left = w.worker.view_account(&w.safe).await?;
    let locked = BYTE_COST * u128::from(left.storage_usage);
    let lost = after - left.balance.as_yoctonear();
    println!("{variant}: the safe paid {lost} of {bank} it could pay when the round opened; {locked} stays locked");
    assert!(lost + ONE_NEAR / 100 > bank && lost >= 2 * MIN_LOOT, "the hole paid all the safe could pay: {lost}");
    assert!(left.balance.as_yoctonear() - locked < ONE_NEAR / 1000, "nothing but the stake and dust is left");
    let gained = balance(&w.worker, &w.masks[nova].id).await? - mine;
    assert!(gained + ONE_NEAR / 100 > lost, "and it went to NOVA itself, less its gas: {gained} of {lost}");

    // The real judge confirms NOVA's drain and refuses nothing of it; ONYX's failed plan has nothing to claim.
    let txs: Vec<String> = played.iter().map(|r| r.outcome().transaction_hash.to_string()).collect();
    let verdict = reveal_and_claim(&w, nova, &found, &txs).await?;
    assert_eq!(verdict["success"], true, "the judge confirms the drain: {verdict}");
    let loot: u128 = verdict["output"]["loot"].as_str().context("loot")?.parse()?;
    assert!(loot >= MIN_LOOT && loot <= lost + ONE_NEAR / 1000, "the judge's loot is what the safe lost: {loot}");
    assert_eq!(verdict["output"]["winner"], json!(w.masks[nova].id));

    // NOVA's seal is the later one: it is paid once ONYX's earlier seal, never revealed, is out with the reveal window.
    let b = view(&w.worker, &w.bounty, "get", json!({ "id": ID })).await?;
    assert_eq!(b["status"]["state"], "open", "the earlier seal can still be revealed: {b}");
    wait_until(&w.worker, ns(&round, "reveal_until")?).await?;
    let prize = balance(&w.worker, &w.masks[nova].id).await?;
    w.masks[nova]
        .on_bounty
        .call(&w.bounty, "settle")
        .args_json(json!({ "id": ID }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?;
    let b = view(&w.worker, &w.bounty, "get", json!({ "id": ID })).await?;
    assert_eq!((&b["status"]["state"], &b["status"]["winner"]), (&json!("drained"), &json!(w.masks[nova].id)), "{b}");
    w.worker.fast_forward(3).await?;
    let paid = balance(&w.worker, &w.masks[nova].id).await? - prize;
    println!("{variant}: the bounty contract paid NOVA {paid}");
    assert!(paid > ONE_NEAR / 20, "the bounty contract paid the winner: {paid}");

    // The safe stays until the round's deadline, then goes at its team's call alone, and the team has all it held.
    let early = w.house.call(&w.safe, "retire").gas(Gas::from_tgas(30)).transact().await?;
    assert!(why(&early).contains("the round's deadline has not come"), "{}", why(&early));
    wait_until(&w.worker, ns(&b, "deadline_ns")?).await?;
    for who in [&w.stranger, &w.masks[nova].on_safe] {
        let r = who.call(&w.safe, "retire").gas(Gas::from_tgas(30)).transact().await?;
        assert!(why(&r).contains("only the safe's team retires it"), "{}", why(&r));
    }
    let held = balance(&w.worker, &w.safe).await?;
    w.worker.fast_forward(5).await?;
    let before = balance(&w.worker, w.house.id()).await?;
    let r = w.house.call(&w.safe, "retire").gas(Gas::from_tgas(30)).transact().await?;
    assert!(r.is_success(), "the team retires the drained safe: {}", why(&r));
    assert!(w.worker.view_account(&w.safe).await.is_err(), "{} is gone from the chain", w.safe);
    w.worker.fast_forward(5).await?;
    let after = balance(&w.worker, w.house.id()).await?;
    let gas: u128 = r.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear()).sum();
    println!("{variant}: retire gave the team {} of the {held} the safe held", after + gas - before);
    assert!(after + gas >= before + held && held >= locked, "the team has all the safe held: {before} {after} {held}");
    Ok(())
}

#[tokio::test]
async fn a_hand_round_on_a_safe_of_the_limit_kind_from_the_first_seal_to_retire() -> Result<()> {
    a_hand_round("limit").await
}

#[tokio::test]
async fn a_hand_round_on_a_safe_of_the_pause_kind_from_the_first_seal_to_retire() -> Result<()> {
    a_hand_round("pause").await
}
