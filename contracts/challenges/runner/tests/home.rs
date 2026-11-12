//! `home` on a mask (contracts/home), on a real local node. A mask that wins a round of the house holds the NEAR it
//! won; `home()`, which anyone may call, sends everything above what the mask keeps back to the house, and only there.
//!
//! The code here is the very file contracts/home/build.sh makes from this source: `home()` as the next deploy runs it
//! (that deploy is the same source built by cargo-near in its pinned image, contracts/README.md "Source on chain"; the
//! code on the masks now is `home_code` in packages/network, and CI checks the file served under it). Its house is
//! written into it, so the house here
//! has its real name: `house.maskwars.near` (and `house.tinygif8324.testnet` for the testnet build), put on the node
//! with a key of the test's own, as the sandbox lets anyone do. The vault is that house's own sub-account, as on
//! mainnet. Everything else is as in tests/retire.rs: the real bounty contract, the real safe, the real judge reading
//! the node's own RPC, and a stand-in for OutLayer.
//!
//! - the mask keeps exactly 0.4 NEAR and the stake of its own storage; the rest goes to the house, to the yoctoNEAR;
//! - at the threshold or below it nothing goes, and one yoctoNEAR above it is one yoctoNEAR sent;
//! - a stranger's call, whatever arguments it brings, pays the stranger's gas and sends to the house alone, and the
//!   code has no other method but the read-only `contract_source_metadata` (NEP-330);
//! - a mask running `home`, with nothing but its two function-call keys and what it keeps, seals, plays, reveals and
//!   claims its rounds as before, is paid, and its winnings go home: the circle closes, day after day.

use anyhow::{bail, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountDetailsPatch, AccountId, Contract, Worker};
use race_runner::round::{
    bounty_wasm_path, build_home, code_hash, home_wasm_path, sandbox, seal_hash, NoGitHub, SandboxRpc, SANDBOX_JUDGE,
};
use race_runner::{build_targets, wasm_dir, workspace_root};
use serde_json::{json, Value};
use std::sync::Once;
use std::task::Poll;
use std::time::Duration;

fn built() {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| {
        build_targets().expect("build wasm");
        build_home().expect("build home");
    });
}

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// NEAR locks this much for every byte an account stores.
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
/// A contract earns a share of the gas its calls burn: a mask's balance grows by this much at most with each call.
const DUST: u128 = ONE_NEAR / 1000;
/// What a call of `home()` is given.
const HOME_GAS: Gas = Gas::from_tgas(10);
/// The bytes a plain account with one full key stores: its record and the key.
const PLAIN_ACCOUNT_BYTES: u64 = 182;

/// A network file of packages/network.
fn network(net: &str) -> Result<Value> {
    let path = workspace_root().join("../../packages/network").join(format!("{net}.json"));
    Ok(serde_json::from_str(&std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?)?)
}

/// NEAR as a decimal string ("0.4") → yoctoNEAR.
fn yocto(near: &str) -> u128 {
    let (whole, frac) = near.split_once('.').unwrap_or((near, ""));
    whole.parse::<u128>().expect("whole") * ONE_NEAR + format!("{frac:0<24}").parse::<u128>().expect("fraction")
}

/// The code of `home` for `net` built from this source, its house and the 0.4 NEAR a mask keeps, as packages/network
/// names them.
struct Home {
    wasm: Vec<u8>,
    house: AccountId,
    keep: u128,
}

fn home_of(net: &str) -> Result<Home> {
    built();
    let wasm = std::fs::read(home_wasm_path(net)).context("read the home wasm")?;
    let n = network(net)?;
    let house = n["house"].as_str().context("house")?.parse()?;
    let keep = yocto(n["round"]["mask_keep"].as_str().context("mask_keep")?);
    assert_eq!(keep, 4 * ONE_NEAR / 10);
    Ok(Home { wasm, house, keep })
}

async fn view(worker: &Worker<Sandbox>, id: &AccountId, method: &str, args: Value) -> Result<Value> {
    Ok(worker.view(id, method).args_json(args).await?.json()?)
}

async fn balance(worker: &Worker<Sandbox>, id: &AccountId) -> Result<u128> {
    Ok(worker.view_account(id).await?.balance.as_yoctonear())
}

/// What `home()` leaves the mask: 0.4 NEAR and the stake of everything it stores.
async fn keeps(worker: &Worker<Sandbox>, id: &AccountId, home: &Home) -> Result<u128> {
    Ok(home.keep + BYTE_COST * u128::from(worker.view_account(id).await?.storage_usage))
}

/// Puts the house on the node under its real name, holding `near` NEAR and one full key of the test's own.
async fn house_on(worker: &Worker<Sandbox>, id: &AccountId, near: u128) -> Result<Account> {
    let key = SecretKey::from_random(KeyType::ED25519);
    worker
        .patch(id)
        .account(AccountDetailsPatch::default().balance(NearToken::from_near(near)).storage_usage(PLAIN_ACCOUNT_BYTES))
        .access_key(key.public_key(), AccessKey::full_access())
        .transact()
        .await
        .with_context(|| format!("put {id} on the node"))?;
    Ok(Account::from_secret_key(id.clone(), key, worker))
}

/// Sets what `id` holds, to the yoctoNEAR.
async fn set_balance(worker: &Worker<Sandbox>, id: &AccountId, yocto: u128) -> Result<()> {
    worker
        .patch(id)
        .account_from_current(move |a| AccountDetailsPatch::from(a).balance(NearToken::from_yoctonear(yocto)))
        .transact()
        .await?;
    assert_eq!(balance(worker, id).await?, yocto);
    Ok(())
}

/// The mask deploys `home` with its own full key, as the owner does from the keychain.
async fn deploy_home(worker: &Worker<Sandbox>, mask: &Account, home: &Home) -> Result<()> {
    mask.deploy(&home.wasm).await?.into_result().with_context(|| format!("deploy home on {}", mask.id()))?;
    let details = worker.view_account(mask.id()).await?;
    assert!(format!("{:?}", details.contract_state).contains(&code_hash(&home.wasm)), "{details:?}");
    Ok(())
}

/// `who` calls `home()` on the mask, with arguments that try to name another receiver: the code reads none.
async fn call_home(who: &Account, mask: &AccountId, deposit: u128) -> Result<ExecutionFinalResult> {
    Ok(who
        .call(mask, "home")
        .args_json(json!({ "to": who.id(), "receiver_id": who.id(), "amount": ONE_NEAR.to_string() }))
        .deposit(NearToken::from_yoctonear(deposit))
        .gas(HOME_GAS)
        .transact()
        .await?)
}

/// The amounts the `home` events of a call name, each with its receiver.
fn sent_home(r: &ExecutionFinalResult) -> Vec<(String, u128)> {
    r.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|e| serde_json::from_str::<Value>(e).ok())
        .filter(|e| e["standard"] == "maskwars_home" && e["event"] == "home")
        .map(|e| {
            assert_eq!(e["version"], "1.0.0");
            let amount = e["data"]["amount"].as_str().and_then(|a| a.parse().ok()).expect("amount");
            (e["data"]["to"].as_str().unwrap_or_default().to_string(), amount)
        })
        .collect()
}

/// The NEAR a call burnt for gas, all of it paid by whoever signed it.
fn burnt(r: &ExecutionFinalResult) -> u128 {
    r.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear()).sum()
}

fn why(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.failures())
}

/// A stranger calls `home()` on a mask that holds `holds`: what went home, checked to the yoctoNEAR on every account
/// the call touched. The mask keeps exactly what it keeps and the gas share NEAR pays it, the house gets the rest and
/// nobody else gets anything; the stranger pays only gas.
async fn home_and_check(
    worker: &Worker<Sandbox>,
    stranger: &Account,
    mask: &AccountId,
    home: &Home,
    deposit: u128,
) -> Result<u128> {
    // The gas refunds of the calls so far land first, so every balance read here is what the account really has.
    worker.fast_forward(5).await?;
    let (mask_before, house_before, stranger_before) =
        (balance(worker, mask).await?, balance(worker, &home.house).await?, balance(worker, stranger.id()).await?);
    let keep = keeps(worker, mask, home).await?;
    let expect = (mask_before + deposit).saturating_sub(keep);
    let r = call_home(stranger, mask, deposit).await?;
    assert!(r.is_success(), "home: {}", why(&r));
    println!("home on {mask}: {:.2} TGas, sent {expect} to {}", r.total_gas_burnt.as_gas() as f64 / 1e12, home.house);
    // Only the mask, the house, and the stranger's own gas refund ran anything.
    for o in r.receipt_outcomes() {
        assert!([mask, &home.house, stranger.id()].contains(&&o.executor_id), "{} ran a receipt", o.executor_id);
    }
    let sent = sent_home(&r);
    if expect == 0 {
        assert!(sent.is_empty(), "nothing goes: {sent:?}");
        assert!(r.logs().iter().any(|l| l.starts_with("home: nothing above")), "{:?}", r.logs());
        assert!(r.receipt_outcomes().iter().all(|o| o.executor_id != home.house), "no receipt reaches the house");
    } else {
        assert_eq!(sent, vec![(home.house.to_string(), expect)], "one event, to the house, with the amount");
    }
    worker.fast_forward(5).await?;
    let (mask_after, house_after, stranger_after) =
        (balance(worker, mask).await?, balance(worker, &home.house).await?, balance(worker, stranger.id()).await?);
    assert_eq!(house_after - house_before, expect, "the house got exactly what went home");
    assert_eq!(stranger_before - stranger_after, burnt(&r) + deposit, "the stranger paid the gas and the deposit only");
    if expect > 0 {
        assert!((keep..keep + DUST).contains(&mask_after), "the mask keeps {keep} and its gas share: {mask_after}");
    } else {
        assert!((mask_before + deposit..mask_before + deposit + DUST).contains(&mask_after), "{mask_after}");
    }
    Ok(expect)
}

#[tokio::test]
async fn home_keeps_exactly_the_threshold_and_sends_the_rest_to_the_house_alone() -> Result<()> {
    let (_node, worker) = sandbox().await?;
    let root = worker.root_account()?;
    let stranger =
        root.create_subaccount("stranger").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    for net in ["mainnet", "testnet"] {
        let home = home_of(net)?;
        house_on(&worker, &home.house, 3).await?;
        let mask = root
            .create_subaccount(&format!("nova-{net}"))
            .initial_balance(NearToken::from_near(5))
            .transact()
            .await?
            .into_result()?;
        deploy_home(&worker, &mask, &home).await?;
        let stored = worker.view_account(mask.id()).await?.storage_usage;
        println!(
            "{net}: home is {} bytes; on a mask it stores {stored} bytes in all, a stake of {:.4} NEAR",
            home.wasm.len(),
            (BYTE_COST * u128::from(stored)) as f64 / 1e24
        );
        // The mask's key is as it was: the deploy changed what calls to the account do, not who signs for it.
        assert_eq!(worker.view_access_keys(mask.id()).await?.len(), 1);

        // Everything above 0.4 NEAR and the stake of its storage goes home, to the yoctoNEAR.
        let keep = keeps(&worker, mask.id(), &home).await?;
        let sent = home_and_check(&worker, &stranger, mask.id(), &home, 0).await?;
        assert!(sent > 4 * ONE_NEAR, "{sent}");

        // At the threshold nothing goes; below it nothing goes; one yoctoNEAR above it, one yoctoNEAR goes.
        set_balance(&worker, mask.id(), keep).await?;
        assert_eq!(home_and_check(&worker, &stranger, mask.id(), &home, 0).await?, 0);
        set_balance(&worker, mask.id(), keep - 1).await?;
        assert_eq!(home_and_check(&worker, &stranger, mask.id(), &home, 0).await?, 0);
        set_balance(&worker, mask.id(), keep / 2).await?;
        assert_eq!(home_and_check(&worker, &stranger, mask.id(), &home, 0).await?, 0);
        set_balance(&worker, mask.id(), keep + 1).await?;
        assert_eq!(home_and_check(&worker, &stranger, mask.id(), &home, 0).await?, 1);

        // A deposit on the call adds to what the mask holds, and goes to the house with the rest, not back.
        set_balance(&worker, mask.id(), keep).await?;
        assert_eq!(home_and_check(&worker, &stranger, mask.id(), &home, ONE_NEAR).await?, ONE_NEAR);

        // The code has no other method: nothing else can move the mask's NEAR.
        for method in ["sweep", "transfer", "set_house", "new"] {
            let r = stranger.call(mask.id(), method).args_json(json!({})).gas(HOME_GAS).transact().await?;
            assert!(r.is_failure() && why(&r).contains("MethodNotFound"), "{method}: {}", why(&r));
        }
        // Its one other method only reads: where its source is (NEP-330). Nothing moves.
        let held = balance(&worker, mask.id()).await?;
        let meta = view(&worker, mask.id(), "contract_source_metadata", json!({})).await?;
        assert_eq!(meta["standards"], json!([{ "standard": "nep330", "version": "1.3.0" }]), "{meta}");
        assert!(
            meta["link"].as_str().is_some_and(|l| l.starts_with("https://github.com/plavutskyi/mask-wars")),
            "{meta}"
        );
        assert!(meta["version"].as_str().is_some_and(|v| v.split('.').count() == 3), "{meta}");
        assert_eq!(balance(&worker, mask.id()).await?, held);
        // The mask's own key still signs for it.
        mask.transfer_near(stranger.id(), NearToken::from_millinear(10)).await?.into_result()?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// A round of the house, as tests/retire.rs plays it

/// A mask of the round: its account, and its two function-call keys, one on the bounty contract and one on the vault.
struct Mask {
    id: AccountId,
    on_bounty: Account,
    on_safe: Account,
}

struct World {
    _node: near_sandbox::Sandbox,
    worker: Worker<Sandbox>,
    home: Home,
    house: Account,
    vault: AccountId,
    bounty: AccountId,
    stub: Contract,
    masks: Vec<Mask>,
    stranger: Account,
    safe_wasm: Vec<u8>,
    safe_code: String,
}

/// A fresh node with the bounty contract born without a key, the house under its mainnet name, and three masks that
/// run `home` and hold nothing but their two function-call keys, given once, before the vault is first made.
async fn world() -> Result<World> {
    let home = home_of("mainnet")?;
    let read = |p: std::path::PathBuf| std::fs::read(&p).with_context(|| format!("read {}", p.display()));
    let bounty_wasm = read(bounty_wasm_path())?;
    let safe_wasm = read(wasm_dir().join("live_safe.wasm"))?;
    let stub_wasm = read(wasm_dir().join("outlayer_stub.wasm"))?;
    let safe_code = code_hash(&safe_wasm);

    let (node, worker) = sandbox().await?;
    let root = worker.root_account()?;
    let house = house_on(&worker, &home.house, 30).await?;
    let vault: AccountId = format!("vault.{}", house.id()).parse()?;
    let sub = |name: &'static str, near: u128| {
        root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact()
    };
    let stranger = sub("stranger", 10).await?.into_result()?;
    let stub = sub("outlayer", 10).await?.into_result()?.deploy(&stub_wasm).await?.into_result()?;
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

    let mut masks = vec![];
    for name in ["nova", "onyx", "oracle"] {
        let full = sub(name, 2).await?.into_result()?;
        deploy_home(&worker, &full, &home).await?;
        let (for_bounty, for_safe) =
            (SecretKey::from_random(KeyType::ED25519), SecretKey::from_random(KeyType::ED25519));
        full.batch(full.id())
            .add_key(
                for_bounty.public_key(),
                AccessKey::function_call_access(&bounty, &["commit", "reveal", "claim_drain", "settle"], None),
            )
            .add_key(for_safe.public_key(), AccessKey::function_call_access(&vault, &["set_owner", "sweep"], None))
            .delete_key(full.secret_key().public_key())
            .transact()
            .await?
            .into_result()?;
        let held = worker.view_access_keys(full.id()).await?;
        assert!(
            held.len() == 2
                && held.iter().all(|k| matches!(k.access_key.permission, AccessKeyPermission::FunctionCall(_)))
        );
        masks.push(Mask {
            id: full.id().clone(),
            on_bounty: Account::from_secret_key(full.id().clone(), for_bounty, &worker),
            on_safe: Account::from_secret_key(full.id().clone(), for_safe, &worker),
        });
    }
    Ok(World { _node: node, worker, home, house, vault, bounty, stub, masks, stranger, safe_wasm, safe_code })
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
        worker.fast_forward(((at - t) / 1_000_000_000).clamp(20, 3600)).await?;
    }
    bail!("sandbox time did not reach {at}");
}

/// The house makes the vault, its own sub-account, in one transaction that adds no key.
async fn make_vault(w: &World) -> Result<()> {
    let masks: Vec<&AccountId> = w.masks.iter().map(|m| &m.id).collect();
    w.house
        .batch(&w.vault)
        .create_account()
        .transfer(NearToken::from_near(5))
        .deploy(&w.safe_wasm)
        .call(
            Function::new("new")
                .args_json(json!({ "owner": w.vault, "masks": masks, "arbiter": w.bounty, "team": w.house.id() }))
                .gas(Gas::from_tgas(30)),
        )
        .transact()
        .await?
        .into_result()
        .context("make the vault")?;
    assert!(w.worker.view_access_keys(&w.vault).await?.is_empty(), "nobody holds a key to the vault");
    Ok(())
}

/// The house opens a sealed round on the vault with 1 NEAR; the round as the bounty contract shows it.
async fn open(w: &World, id: &str) -> Result<Value> {
    let masks: Vec<&AccountId> = w.masks.iter().map(|m| &m.id).collect();
    w.house
        .call(&w.bounty, "open_safe")
        .args_json(json!({ "id": id, "safe": w.vault, "masks": masks, "min_loot": ONE_NEAR.to_string(), "hours": 1,
                           "commit_minutes": 1, "reveal_minutes": 12, "safe_code": w.safe_code,
                           "judge_version": SANDBOX_JUDGE }))
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("open {id}"))?;
    view(&w.worker, &w.bounty, "get_round", json!({ "id": id })).await
}

/// NOVA wins round `id` through the planted hole, start to finish, with its function-call keys alone: seals in the
/// commit window, takes the vault and sweeps 2 NEAR to itself after it, reveals, claims, and the real judge confirms.
/// The bounty as the contract holds it afterwards.
async fn nova_wins(w: &World, id: &str, round: &Value) -> Result<Value> {
    let m = &w.masks[0];
    let calls = vec![
        json!({ "method": "set_owner", "args": { "new_owner": m.id } }),
        json!({ "method": "sweep", "args": { "to": m.id, "amount": (2 * ONE_NEAR).to_string() } }),
    ];
    let plan = serde_json::to_string(&calls)?;
    let salt = format!("nova-home-salt-{id}");
    m.on_bounty
        .call(&w.bounty, "commit")
        .args_json(json!({ "id": id, "hash": seal_hash(id, m.id.as_str(), &salt, &plan) }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .context("NOVA seals")?;
    wait_until(&w.worker, round["commit_until"].as_str().context("commit_until")?.parse()?).await?;
    for _ in 0..200 {
        match view(&w.worker, &w.vault, "waits_for", json!({ "account_id": m.id })).await?.as_str() {
            None => break,
            Some(s) if s.contains("another mask has its turn") || s.contains("an earlier seal goes first") => {}
            Some(s) => bail!("the vault never lets NOVA in: {s}"),
        }
        w.worker.fast_forward(20).await?;
    }
    let mut txs = vec![];
    for c in &calls {
        let r = m
            .on_safe
            .call(&w.vault, c["method"].as_str().unwrap())
            .args_json(&c["args"])
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        txs.push(r.outcome().transaction_hash.to_string());
        r.into_result().with_context(|| format!("NOVA plays {}", c["method"]))?;
    }
    m.on_bounty
        .call(&w.bounty, "reveal")
        .args_json(json!({ "id": id, "plan": plan, "salt": salt, "txs": txs }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .context("reveal")?;
    // The claim goes to the judge through the stand-in; the real judge answers it from the node's own chain.
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
    view(&w.worker, &w.bounty, "get", json!({ "id": id })).await
}

#[tokio::test]
async fn a_mask_running_home_plays_its_rounds_as_before_and_its_winnings_go_home() -> Result<()> {
    let w = world().await?;
    let nova = w.masks[0].id.clone();
    // Before the first round every mask is left with what it keeps and nothing more: the rounds are played on that.
    for m in &w.masks {
        home_and_check(&w.worker, &w.stranger, &m.id, &w.home, 0).await?;
    }

    for (day, id) in ["home-0001", "home-0002"].iter().enumerate() {
        make_vault(&w).await?;
        let round = open(&w, id).await?;
        let nova_before = balance(&w.worker, &nova).await?;
        let b = nova_wins(&w, id, &round).await?;
        w.worker.fast_forward(5).await?;
        assert_eq!((&b["status"]["state"], &b["status"]["winner"]), (&json!("drained"), &json!(nova)), "{b}");
        let won = balance(&w.worker, &nova).await? - nova_before;
        assert!(
            won > 2 * ONE_NEAR,
            "day {}: NOVA took the vault's 2 NEAR and the bounty, less its gas: {won}",
            day + 1
        );

        // Anyone sends the winnings home: everything above what NOVA keeps, to the house and nowhere else.
        let house_before = balance(&w.worker, w.house.id()).await?;
        let sent = home_and_check(&w.worker, &w.stranger, &nova, &w.home, 0).await?;
        assert!(sent >= won - DUST && sent <= won + DUST, "day {}: what NOVA won went home: {sent} of {won}", day + 1);
        assert_eq!(balance(&w.worker, w.house.id()).await? - house_before, sent);

        // The round's deadline passes; the house retires the vault and has the rest of it back.
        wait_until(&w.worker, round["deadline_ns"].as_str().context("deadline")?.parse()?).await?;
        w.house.call(&w.vault, "retire").gas(Gas::from_tgas(30)).transact().await?.into_result().context("retire")?;
        w.worker.fast_forward(5).await?;
        assert!(w.worker.view_account(&w.vault).await.is_err(), "the vault is gone");
    }
    // Not one key of the masks changed, and each still runs home.
    for m in &w.masks {
        assert_eq!(w.worker.view_access_keys(&m.id).await?.len(), 2, "{}", m.id);
        let details = w.worker.view_account(&m.id).await?;
        assert!(format!("{:?}", details.contract_state).contains(&code_hash(&w.home.wasm)), "{}", m.id);
    }
    Ok(())
}
