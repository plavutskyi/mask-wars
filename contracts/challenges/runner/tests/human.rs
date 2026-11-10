//! A person's mask in a sealed round beside the arena's own, end to end on a real local node. Everything on chain is
//! the real code: the mask factory and the mask code as a global contract (contracts/masks), the bounty contract, the
//! live safe locked to the round, and the judge (services/judge), which reads the sandbox's own RPC. Only OutLayer is a
//! stand-in (`outlayer-stub`), as in tests/round.rs.
//!
//! ANN forges KIRA with a line of strategy only the mind can read. The team opens a round with KIRA on its list beside
//! NOVA. The keeper, whose account holds nothing but a function-call key for the factory's `arm` and `settle`, arms
//! KIRA with two race keys from its seed; the factory checks the round on the bounty contract first. KIRA seals first,
//! NOVA second, each a sweep of `min_loot`, so the earlier seal leaves the later plan whole. KIRA plays in its own slot
//! with the keeper's keys, NOVA in the next one; both drains go through. KIRA reveals and claims: the judge confirms,
//! the bounty contract pays KIRA's own account. The keeper settles what KIRA's mind spent, and the race keys are gone.
//! ANN, and only ANN, takes the prize out; the ×, earned ÷ fuel, reads off the chain.

use anyhow::{bail, Context, Result};
use ed25519_dalek::SigningKey;
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::types::{AccessKey, AccessKeyPermission, Gas, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use race_runner::round::{
    bounty_wasm_path, build_masks, code_hash, masks_wasm_dir, sandbox, seal_hash, NoGitHub, SandboxRpc, SANDBOX_JUDGE,
};
use race_runner::{build_targets, wasm_dir, workspace_root};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Once;
use std::task::Poll;
use std::time::Duration;

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = ONE_NEAR / 1000;
const ROUND: &str = "human-0001";
/// The keeper's seed in this sandbox: `KEEPER_SEED` on GitHub, in the `live-race` environment only.
const KEEPER_SEED: [u8; 32] = [7; 32];
/// The mind's seed in this sandbox: on OutLayer it is generated inside the TEE and nobody sees it.
const MIND_SEED: [u8; 32] = [42; 32];
const STRATEGY: &str = "Wait for the window to close, take the safe, sweep only what the round asks.";

fn built() {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| {
        build_targets().expect("build wasm");
        build_masks().expect("build the mask factory");
    });
}

// ---------------------------------------------------------------------------------------------------------------------
// The keeper's keys, as packages/race/src/keeper.ts derives them
// ---------------------------------------------------------------------------------------------------------------------

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let pad = |x: u8| k.iter().map(|b| b ^ x).collect::<Vec<u8>>();
    let inner = Sha256::new().chain_update(pad(0x36)).chain_update(message).finalize();
    Sha256::new().chain_update(pad(0x5c)).chain_update(inner).finalize().into()
}

fn base58(bytes: &[u8]) -> String {
    const B58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits: Vec<u8> = vec![];
    for byte in bytes {
        let mut carry = u32::from(*byte);
        for d in digits.iter_mut() {
            carry += u32::from(*d) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    std::iter::repeat_n(b'1', zeros).chain(digits.iter().rev().map(|d| B58[*d as usize])).map(char::from).collect()
}

fn seeded(seed: &[u8; 32], label: &str) -> SecretKey {
    let s = hmac_sha256(seed, label.as_bytes());
    let public = SigningKey::from_bytes(&s).verifying_key().to_bytes();
    let both: Vec<u8> = s.iter().chain(public.iter()).copied().collect();
    format!("ed25519:{}", base58(&both)).parse().expect("an ed25519 secret key")
}

/// A person's mask's race key for one round and one receiver.
fn human_key(seed: &[u8; 32], mask: &str, round: &str, receiver: &str) -> SecretKey {
    seeded(seed, &format!("maskwars-human-key:{mask}:{round}:{receiver}"))
}

/// The keeper's own function-call key on the factory.
fn keeper_key(seed: &[u8; 32], factory: &str) -> SecretKey {
    seeded(seed, &format!("maskwars-keeper-key:{factory}"))
}

#[test]
fn the_keys_are_the_ones_the_keeper_derives() {
    let path =
        workspace_root().join("..").join("..").join("packages").join("race").join("test").join("human-keys.json");
    let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let seed: [u8; 32] = (0..32)
        .map(|i| u8::from_str_radix(&v["seed"].as_str().unwrap()[2 * i..2 * i + 2], 16).unwrap())
        .collect::<Vec<u8>>()
        .try_into()
        .unwrap();
    let (mask, round) = (v["mask"].as_str().unwrap(), v["round"].as_str().unwrap());
    for (receiver, key) in v["keys"].as_object().unwrap() {
        assert_eq!(human_key(&seed, mask, round, receiver).public_key().to_string(), key.as_str().unwrap());
    }
    let factory = v["keeper"]["factory"].as_str().unwrap();
    assert_eq!(keeper_key(&seed, factory).public_key().to_string(), v["keeper"]["key"].as_str().unwrap());
}

// ---------------------------------------------------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------------------------------------------------

async fn view(worker: &Worker<Sandbox>, id: &AccountId, method: &str, args: Value) -> Result<Value> {
    Ok(worker.view(id, method).args_json(args).await?.json()?)
}

async fn balance(worker: &Worker<Sandbox>, id: &AccountId) -> Result<u128> {
    Ok(worker.view_account(id).await?.balance.as_yoctonear())
}

/// Every key on the account: `(public key, None)` for a full key, `(public key, Some((receiver, methods)))` else.
async fn keys(worker: &Worker<Sandbox>, id: &AccountId) -> Result<Vec<(String, Option<(String, Vec<String>)>)>> {
    Ok(worker
        .view_access_keys(id)
        .await?
        .into_iter()
        .map(|k| {
            let perm = match k.access_key.permission {
                AccessKeyPermission::FullAccess => None,
                AccessKeyPermission::FunctionCall(f) => Some((f.receiver_id, f.method_names)),
            };
            (k.public_key.to_string(), perm)
        })
        .collect())
}

async fn wait_until(worker: &Worker<Sandbox>, at: u64) -> Result<()> {
    for _ in 0..400 {
        if worker.view_block().await?.timestamp() >= at {
            return Ok(());
        }
        worker.fast_forward(20).await?;
    }
    bail!("sandbox time did not reach {at}");
}

fn u128_of(v: &Value) -> u128 {
    v.as_str().and_then(|s| s.parse().ok()).unwrap_or_else(|| panic!("not an amount: {v}"))
}

/// Why a transaction failed, short.
fn why(r: &near_workspaces::result::ExecutionFinalResult) -> String {
    format!("{:?}", r.failures())
}

struct World {
    _node: near_sandbox::Sandbox,
    worker: Worker<Sandbox>,
    bounty: AccountId,
    safe: AccountId,
    stub: Contract,
}

/// A mask plays its sealed plan on the safe with its key there, one transaction a call. While another mask has its
/// turn, or an earlier seal still goes first, the safe says so in `waits_for`; the mask lets sandbox time pass.
async fn play(w: &World, on_safe: &Account, calls: &[Value]) -> Result<Vec<String>> {
    for _ in 0..400 {
        let why = view(&w.worker, &w.safe, "waits_for", json!({ "account_id": on_safe.id() })).await?;
        if !why
            .as_str()
            .is_some_and(|s| s.contains("another mask has its turn") || s.contains("an earlier seal goes first"))
        {
            break;
        }
        w.worker.fast_forward(20).await?;
    }
    let mut txs = vec![];
    for c in calls {
        let r = on_safe
            .call(&w.safe, c["method"].as_str().unwrap())
            .args_json(&c["args"])
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        txs.push(r.outcome().transaction_hash.to_string());
        if r.is_failure() {
            bail!("{} {}: {}", on_safe.id(), c["method"], why(&r));
        }
    }
    Ok(txs)
}

/// The mask claims its drain with nothing attached; the real judge answers the stub's request from the sandbox's
/// chain. Returns the judge's verdict and the bounty afterwards.
async fn claim(w: &World, on_bounty: &Account, drain: &str) -> Result<(maskwars_judge::judge::Output, Value)> {
    let asked = view(&w.worker, w.stub.id(), "requests", json!({})).await?.as_array().map_or(0, Vec::len);
    let pending = on_bounty
        .call(&w.bounty, "claim_drain")
        .args_json(json!({ "id": ROUND, "tx_hash": drain }))
        .gas(Gas::from_tgas(300))
        .transact_async()
        .await?;
    let input = loop {
        if let Poll::Ready(r) = pending.status().await? {
            bail!("the claim never reached the judge: {}", why(&r));
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
    Ok((verdict, view(&w.worker, &w.bounty, "get", json!({ "id": ROUND })).await?))
}

#[tokio::test]
async fn a_person_s_mask_wins_a_sealed_round_in_its_own_slot_and_its_owner_takes_the_prize() -> Result<()> {
    built();
    let read = |p: std::path::PathBuf| std::fs::read(&p).with_context(|| format!("read {}", p.display()));
    let bounty_wasm = read(bounty_wasm_path())?;
    let live_safe = read(wasm_dir().join("live_safe.wasm"))?;
    let stub_wasm = read(wasm_dir().join("outlayer_stub.wasm"))?;
    let factory_wasm = read(masks_wasm_dir().join("maskwars_masks.wasm"))?;
    let mask_wasm = read(masks_wasm_dir().join("maskwars_mask.wasm"))?;
    let live_code = code_hash(&live_safe);

    let (node, worker) = sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await?
                .into_result()
                .with_context(|| format!("create {name}"))
        }
    };
    let admin = sub("admin", 20).await?;
    let team = sub("team", 20).await?;
    let ann = sub("ann", 20).await?;
    let bob = sub("bob", 20).await?;
    let keeper = sub("keeper", 5).await?;
    let treasury = sub("treasury", 1).await?;
    let nova = sub("nova", 10).await?;
    let stub = sub("outlayer", 10).await?.deploy(&stub_wasm).await?.into_result()?;

    // The bounty contract and the factory, each born without a key: create, fund, deploy, new in one transaction.
    let bounty: AccountId = format!("bounty.{}", root.id()).parse()?;
    root.batch(&bounty)
        .create_account()
        .transfer(NearToken::from_near(10))
        .deploy(&bounty_wasm)
        .call(
            Function::new("new")
                .args_json(json!({ "outlayer": stub.id(), "judge_project": "admin/judge",
                                   "judge_version": SANDBOX_JUDGE, "admin": admin.id(), "safe_codes": [live_code] }))
                .gas(Gas::from_tgas(50)),
        )
        .transact()
        .await?
        .into_result()
        .context("deploy the bounty contract")?;
    let factory: AccountId = format!("masks.{}", root.id()).parse()?;
    let mind = maskwars_brain::mind_secret(&MIND_SEED);
    let mind_key = maskwars_brain::key_text(&maskwars_brain::MindPublic::from(&mind));
    let catalog: Value = serde_json::from_str(&std::fs::read_to_string(
        workspace_root().join("..").join("masks").join("catalog.json"),
    )?)?;
    let mask_code: String = Sha256::digest(&mask_wasm).iter().map(|b| format!("{b:02x}")).collect();
    root.batch(&factory)
        .create_account()
        .transfer(NearToken::from_near(30))
        .deploy(&factory_wasm)
        .call(
            Function::new("new")
                .args_json(json!({ "admin": admin.id(), "keeper": keeper.id(), "treasury": treasury.id(),
                                   "arena": bounty, "mask_code": mask_code, "strategy_key": mind_key,
                                   "catalog": catalog, "release_minutes": 2880, "teams": [team.id()] }))
                .gas(Gas::from_tgas(100)),
        )
        .transact()
        .await?
        .into_result()
        .context("deploy the factory")?;
    bob.call(&factory, "publish_mask_code")
        .args(mask_wasm.clone())
        .gas(Gas::from_tgas(300))
        .transact()
        .await?
        .into_result()
        .context("publish the mask code")?;

    // The keeper's account gives up its full key: from here on it holds one function-call key, for the factory's arm
    // and settle, the key that `KEEPER_SEED` gives (scripts/testnet/keeper-key.ps1 adds it on testnet).
    let own = keeper_key(&KEEPER_SEED, factory.as_str());
    keeper
        .batch(keeper.id())
        .add_key(own.public_key(), AccessKey::function_call_access(&factory, &["arm", "settle"], None))
        .delete_key(keeper.secret_key().public_key())
        .transact()
        .await?
        .into_result()
        .context("the keeper's function-call key")?;
    let keeper = Account::from_secret_key(keeper.id().clone(), own, &worker);

    // ANN forges KIRA: a look, a TEE model, a style and one line of strategy, sealed in the browser for the mind.
    let kira: AccountId = format!("kira.{factory}").parse()?;
    let sealed =
        maskwars_brain::seal(&maskwars_brain::MindPublic::from(&mind), kira.as_str(), STRATEGY, [3; 32], [4; 12])
            .map_err(anyhow::Error::msg)?;
    let forged = ann
        .call(&factory, "forge")
        .args_json(json!({ "name": "kira", "look": "porcelain", "model": "Qwen/Qwen3.8-27B", "style": "cunning",
                           "strategy": sealed }))
        .deposit(NearToken::from_near(2))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(forged.is_success(), "forge: {}", why(&forged));
    assert!(keys(&worker, &kira).await?.is_empty(), "KIRA is born with no key at all");
    let forged = view(&worker, &factory, "get_mask", json!({ "name": "kira" })).await?;
    assert_eq!((forged["owner"].as_str(), forged["strategy"].as_bool()), (Some(ann.id().as_str()), Some(true)));
    let fuel = u128_of(&forged["fuel"]);

    // The line is nowhere on chain in the clear: not in a view, not in the factory's state. Only the mind opens the
    // box, and only for KIRA.
    for method in ["get_mask", "get_sealed_strategy"] {
        let shown = view(&worker, &factory, method, json!({ "name": "kira" })).await?.to_string();
        assert!(!shown.contains("sweep only what"), "{method} shows the strategy: {shown}");
    }
    let state = worker.view_state(&factory).await?;
    assert!(
        state.values().all(|v| !String::from_utf8_lossy(v).contains("sweep only what")),
        "the factory's state holds the line in the clear"
    );
    let boxed = view(&worker, &factory, "get_sealed_strategy", json!({ "name": "kira" })).await?;
    let boxed = boxed["sealed"].as_str().context("a sealed box")?;
    assert_eq!(maskwars_brain::open(&mind, kira.as_str(), boxed).map_err(anyhow::Error::msg)?, STRATEGY);
    assert!(maskwars_brain::open(&mind, nova.id().as_str(), boxed).is_err(), "the box opens for KIRA only");
    assert!(maskwars_brain::open(&maskwars_brain::mind_secret(&[9; 32]), kira.as_str(), boxed).is_err());

    // The review's F4, on the real bounty contract: anyone may open a sealed round, with any contract as its safe and
    // any mask on its list. BOB forges TARA; a thief deploys a safe of their own, names themselves its team and opens a
    // round with TARA on it. The keeper's key arms TARA for that round: the factory sees that none of its teams opened
    // it, so TARA gets no key there, burns no gas for the thief, and its hold goes back.
    let tara: AccountId = format!("tara.{factory}").parse()?;
    let made = bob
        .call(&factory, "forge")
        .args_json(json!({ "name": "tara", "look": "porcelain", "model": "Qwen/Qwen3.8-27B", "style": "bold" }))
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(made.is_success(), "forge TARA: {}", why(&made));
    let thief = sub("thief", 10).await?;
    let theirs = sub("t0666", 3).await?.deploy(&live_safe).await?.into_result()?;
    theirs
        .call("new")
        .args_json(json!({ "owner": theirs.id(), "masks": [tara], "arbiter": bounty, "team": thief.id() }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .context("init the thief's safe")?;
    let opened = thief
        .call(&bounty, "open_safe")
        .args_json(
            json!({ "id": "thief-0001", "safe": theirs.id(), "masks": [tara], "min_loot": (ONE_NEAR / 10).to_string(),
                           "hours": 1, "commit_minutes": 30, "reveal_minutes": 30, "safe_code": live_code,
                           "judge_version": SANDBOX_JUDGE }),
        )
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(opened.is_success(), "the bounty contract lets anyone open a round: {}", why(&opened));
    let theirs_round = view(&worker, &bounty, "get", json!({ "id": "thief-0001" })).await?;
    assert_eq!(
        (theirs_round["owner"].as_str(), theirs_round["status"]["state"].as_str()),
        (Some(thief.id().as_str()), Some("open"))
    );
    let tara_before = balance(&worker, &tara).await?;
    let tara_brain = u128_of(&view(&worker, &factory, "get_mask", json!({ "name": "tara" })).await?["brain"]);
    let squat = keeper
        .call(&factory, "arm")
        .args_json(json!({ "name": "tara", "race": "thief-0001",
                           "arena_key": human_key(&KEEPER_SEED, tara.as_str(), "thief-0001", bounty.as_str()).public_key(),
                           "target": theirs.id(),
                           "target_key": human_key(&KEEPER_SEED, tara.as_str(), "thief-0001", theirs.id().as_str()).public_key(),
                           "target_methods": ["set_owner", "sweep"] }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?;
    assert!(squat.is_success(), "arm: {}", why(&squat));
    let logs: Vec<String> = squat.logs().iter().map(|l| l.to_string()).collect();
    assert!(!squat.json::<bool>()?, "a thief's round is no round of ours: {logs:?}");
    assert!(logs.iter().any(|l| l.contains("not opened by one of the factory's teams")), "{logs:?}");
    assert!(keys(&worker, &tara).await?.is_empty(), "TARA got no key for the thief's round");
    let after = view(&worker, &factory, "get_mask", json!({ "name": "tara" })).await?;
    assert_eq!((after["state"].as_str(), u128_of(&after["brain"])), (Some("ready"), tara_brain), "the hold went back");
    assert_eq!(balance(&worker, &tara).await?, tara_before, "TARA burned nothing");
    println!("TARA: the thief's round thief-0001 refused, no key, nothing burned");

    // The team makes the round's safe for KIRA and NOVA (it owns itself and drops the key that deployed it) and opens
    // the round. Each sealed sweep asks for min_loot, not for everything, so the earlier seal spoils no later plan.
    let safe_account = sub("h0001", 6).await?;
    let safe = safe_account.deploy(&live_safe).await?.into_result()?;
    let masks = [kira.clone(), nova.id().clone()];
    safe.call("new")
        .args_json(json!({ "owner": safe.id(), "masks": masks, "arbiter": bounty, "team": team.id() }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .context("init the safe")?;
    assert!(keys(&worker, safe.id()).await?.is_empty(), "the safe holds no key");
    let min_loot = ONE_NEAR;
    let opened = team
        .call(&bounty, "open_safe")
        .args_json(json!({ "id": ROUND, "safe": safe.id(), "masks": masks, "min_loot": min_loot.to_string(),
                           "hours": 1, "commit_minutes": 2, "reveal_minutes": 30, "safe_code": live_code,
                           "judge_version": SANDBOX_JUDGE }))
        .deposit(NearToken::from_near(2))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    assert!(opened.is_success(), "open_safe: {}", why(&opened));
    let w = World { _node: node, worker, bounty: bounty.clone(), safe: safe.id().clone(), stub };
    assert_eq!(view(&w.worker, &bounty, "get", json!({ "id": ROUND })).await?["status"]["state"], "open");

    // The keeper's key reaches the factory's arm and settle, nothing else.
    let other = keeper.call(&factory, "unfuel").args_json(json!({ "name": "kira" })).transact().await;
    assert!(other.map_or(true, |r| r.is_failure()), "the keeper's key calls arm and settle only");

    // The keeper arms KIRA for this round with two keys from its seed. The factory asks the bounty contract first.
    let arena_key = human_key(&KEEPER_SEED, kira.as_str(), ROUND, bounty.as_str());
    let target_key = human_key(&KEEPER_SEED, kira.as_str(), ROUND, w.safe.as_str());
    let brain_before = u128_of(&forged["brain"]);
    let armed = keeper
        .call(&factory, "arm")
        .args_json(json!({ "name": "kira", "race": ROUND, "arena_key": arena_key.public_key(), "target": w.safe,
                           "target_key": target_key.public_key(), "target_methods": ["set_owner", "sweep"] }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?;
    assert!(armed.is_success(), "arm: {}", why(&armed));
    let logs: Vec<String> = armed.logs().iter().map(|l| l.to_string()).collect();
    assert!(armed.json::<bool>()?, "the round checks out: {logs:?}");
    let mut on_kira = keys(&w.worker, &kira).await?;
    on_kira.sort();
    let mut want = vec![
        (
            arena_key.public_key().to_string(),
            Some((bounty.to_string(), vec!["commit", "reveal", "claim_drain", "settle"])),
        ),
        (target_key.public_key().to_string(), Some((w.safe.to_string(), vec!["set_owner", "sweep"]))),
    ]
    .into_iter()
    .map(|(k, p)| (k, p.map(|(r, m)| (r, m.into_iter().map(String::from).collect::<Vec<_>>()))))
    .collect::<Vec<_>>();
    want.sort();
    assert_eq!(on_kira, want, "KIRA holds exactly its two race keys");
    let held = u128_of(&view(&w.worker, &factory, "get_mask", json!({ "name": "kira" })).await?["race"]["held"]);

    // NOVA is the arena's own mask, not one of the factory's: the keeper cannot arm it, nor arm KIRA twice.
    let again = keeper
        .call(&factory, "arm")
        .args_json(json!({ "name": "kira", "race": ROUND, "arena_key": arena_key.public_key(), "target": w.safe,
                           "target_key": target_key.public_key(), "target_methods": ["set_owner", "sweep"] }))
        .gas(Gas::from_tgas(150))
        .transact()
        .await?;
    assert!(why(&again).contains("the mask is already in a race"), "{}", why(&again));

    // The seals. KIRA first, with the keeper's key on the bounty contract; NOVA second.
    let kira_bounty = Account::from_secret_key(kira.clone(), arena_key.clone(), &w.worker);
    let kira_safe = Account::from_secret_key(kira.clone(), target_key.clone(), &w.worker);
    let hole = |who: &AccountId| {
        vec![
            json!({ "method": "set_owner", "args": { "new_owner": who } }),
            json!({ "method": "sweep", "args": { "to": who, "amount": min_loot.to_string() } }),
        ]
    };
    let mut seq = vec![];
    for (who, on_bounty) in [(&kira, &kira_bounty), (nova.id(), &nova)] {
        let plan = serde_json::to_string(&hole(who))?;
        let salt = format!("{}-human-round-salt", who.as_str().split('.').next().unwrap());
        let r = on_bounty
            .call(&bounty, "commit")
            .args_json(json!({ "id": ROUND, "hash": seal_hash(ROUND, who.as_str(), &salt, &plan) }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        assert!(r.is_success(), "{who} commit: {}", why(&r));
        seq.push((who.clone(), plan, salt, r.json::<Value>()?["seq"].as_u64()));
    }
    assert_eq!((seq[0].3, seq[1].3), (Some(0), Some(1)), "KIRA holds seal #0, NOVA seal #1");

    // In the commit window the safe is locked: even KIRA's key moves nothing.
    let early = kira_safe.call(&w.safe, "set_owner").args_json(json!({ "new_owner": kira })).transact().await?;
    assert!(why(&early).contains("the safe is locked"), "{}", why(&early));

    let until: u64 = view(&w.worker, &bounty, "get_round", json!({ "id": ROUND })).await?["commit_until"]
        .as_str()
        .context("commit_until")?
        .parse()?;
    wait_until(&w.worker, until).await?;

    // KIRA plays first, in its own slot, with the keeper's key on the safe. NOVA plays in the next slot, after KIRA's
    // turn: KIRA's sweep of min_loot left NOVA's sealed sweep whole, so it goes through too.
    let kira_before = balance(&w.worker, &kira).await?;
    let kira_txs = play(&w, &kira_safe, &hole(&kira)).await?;
    let looted = balance(&w.worker, &kira).await?.saturating_sub(kira_before);
    assert!(looted > min_loot - 10 * MILLI, "KIRA took min_loot from the safe: {looted}");
    let nova_txs = play(&w, &nova, &hole(nova.id())).await?;
    for (who, plan, salt, _) in &seq {
        let txs = if who == &kira { &kira_txs } else { &nova_txs };
        let on_bounty = if who == &kira { &kira_bounty } else { &nova };
        let r = on_bounty
            .call(&bounty, "reveal")
            .args_json(json!({ "id": ROUND, "plan": plan, "salt": salt, "txs": txs }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        assert!(r.is_success(), "{who} reveal: {}", why(&r));
    }

    // KIRA claims its drain with the keeper's key: nothing attached, the bounty pays its first claim's judge.
    let prize_before = balance(&w.worker, &kira).await?;
    let (verdict, b) = claim(&w, &kira_bounty, kira_txs.last().unwrap()).await?;
    assert!(verdict.success, "the judge confirmed KIRA's drain: {:?}", verdict.error);
    assert_eq!(b["status"]["state"], "drained", "{b}");
    assert_eq!(b["status"]["winner"], kira.as_str(), "the bounty went to KIRA's own account");
    let prize = u128_of(&b["amount"]);
    // The claim prepaid 300 TGas; what it did not burn comes back to KIRA a few blocks later.
    w.worker.fast_forward(5).await?;
    let won = balance(&w.worker, &kira).await? - prize_before;
    // The bounty paid the judge of KIRA's first claim (0.01 NEAR) from the prize; KIRA's key attached nothing.
    assert!(won + 30 * MILLI > prize && won < prize, "KIRA's account took the prize {prize}: {won}");

    // The keeper settles: the mind's real cost (here 0.0123 NEAR of NEAR AI tokens) goes to the treasury, the rest of
    // the hold back to the tank, and the race keys are gone. Never more than the race held.
    let spent = 12_300 * MILLI / 1000;
    let greedy = keeper
        .call(&factory, "settle")
        .args_json(json!({ "name": "kira", "race": ROUND, "spent": (held + 1).to_string() }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    assert!(why(&greedy).contains("the mind cannot spend more than the race held"), "{}", why(&greedy));
    let treasury_before = balance(&w.worker, treasury.id()).await?;
    let settled = keeper
        .call(&factory, "settle")
        .args_json(json!({ "name": "kira", "race": ROUND, "spent": spent.to_string() }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    assert!(settled.is_success(), "settle: {}", why(&settled));
    assert_eq!(
        balance(&w.worker, treasury.id()).await? - treasury_before,
        spent,
        "the treasury got what the mind spent"
    );
    let after = view(&w.worker, &factory, "get_mask", json!({ "name": "kira" })).await?;
    assert_eq!(
        (after["state"].as_str(), u128_of(&after["brain"]), u128_of(&after["spent"]), after["races"].as_u64()),
        (Some("ready"), brain_before - spent, spent, Some(1))
    );
    assert!(keys(&w.worker, &kira).await?.is_empty(), "the race keys are gone with the round");
    // A race key that leaked is dead now.
    let dead = kira_bounty.call(&bounty, "settle").args_json(json!({ "id": ROUND })).transact().await;
    assert!(dead.map_or(true, |r| r.is_failure()), "the old key signs nothing");

    // For eyes only (apps/web/scripts/person-shots.mjs): with HUMAN_SERVE=<file> the round stops here, the prize still
    // on KIRA, a change of the factory waiting, and the sandbox stays up for the site until <file>.stop appears.
    if let Ok(file) = std::env::var("HUMAN_SERVE") {
        let proposed = admin
            .call(&factory, "propose")
            .args_json(json!({ "change": { "kind": "keeper", "account": admin.id() } }))
            .transact()
            .await?;
        assert!(proposed.is_success(), "propose: {}", why(&proposed));
        // The same file serves apps/web/scripts/forge-shots.mjs: ANN forges, BOB races her for a name.
        let info = json!({ "rpc": w.worker.rpc_addr(), "factory": factory, "bounty": bounty, "safe": w.safe,
                           "round": ROUND, "mask": kira, "owner": ann.id(), "owner_key": ann.secret_key().to_string(),
                           "account": ann.id(), "secret_key": ann.secret_key().to_string(),
                           "rival": bob.id(), "rival_key": bob.secret_key().to_string() });
        std::fs::write(&file, serde_json::to_string_pretty(&info)?)?;
        println!("serving {info}");
        let stop = format!("{file}.stop");
        while !std::path::Path::new(&stop).exists() {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        return Ok(());
    }

    // Only ANN takes the prize out; the gas fund stays on KIRA for the next race.
    let stolen = bob.call(&kira, "withdraw").transact().await?;
    assert!(why(&stolen).contains("only the mask's owner withdraws"), "{}", why(&stolen));
    let on_mask = balance(&w.worker, &kira).await?;
    let ann_before = balance(&w.worker, ann.id()).await?;
    let out = ann.call(&kira, "withdraw").gas(Gas::from_tgas(30)).transact().await?;
    assert!(out.is_success(), "withdraw: {}", why(&out));
    let took = balance(&w.worker, ann.id()).await? + 5 * MILLI - ann_before;
    assert!(took + 300 * MILLI > prize + min_loot, "ANN took KIRA's prize and loot: {took}");
    let left = balance(&w.worker, &kira).await?;
    assert!(left >= 250 * MILLI && left < on_mask, "the gas fund stays on KIRA: {left}");

    // The × reads off the chain: what the bounty contract paid KIRA and what its sealed plan swept, over its fuel.
    let round = view(&w.worker, &bounty, "get_round", json!({ "id": ROUND })).await?;
    let mine = round["seals"].as_array().unwrap().iter().find(|s| s["mask"] == kira.as_str()).unwrap();
    let plan: Vec<Value> = serde_json::from_str(mine["plan"].as_str().unwrap())?;
    let swept: u128 = plan.iter().filter(|c| c["method"] == "sweep").map(|c| u128_of(&c["args"]["amount"])).sum();
    let earned = prize + swept;
    let x = earned as f64 / fuel as f64;
    println!("KIRA: seal #0, prize {prize}, loot {swept}, fuel {fuel}, × {x:.2}; the mind spent {spent}");
    assert!(x > 0.9, "KIRA earned more than half its fuel back: × {x:.2}");
    assert_eq!(after["fuel"], forged["fuel"], "the × is over what ANN put in");
    Ok(())
}
