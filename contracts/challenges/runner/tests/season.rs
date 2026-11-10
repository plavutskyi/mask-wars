//! A season on a real local node, three rounds, and not one full key in any: the treasury (contracts/season) makes
//! each round's safe from global code and opens the sealed round on the bounty contract when the scheduler, which
//! holds only a function-call key for `open_next` and `collect`, says so. The masks hold only function-call keys too:
//! one on the bounty contract, one on each safe. Two rounds are won; the third nobody wins, and `collect` brings home
//! its bounty and the NEAR of its safe (`reclaim`). Everything on chain is the real code: the treasury, the bounty
//! contract, the safes (`live-safe`, each named with the bounty contract that arms it and the treasury as its team, so
//! each takes only the season's own round, locked until the commit window closes) and the judge (services/judge),
//! which reads the sandbox's own RPC. Only OutLayer is a stand-in (`outlayer-stub`), as in tests/round.rs.

use anyhow::{bail, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::types::{AccessKey, AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use race_runner::build_targets;
use race_runner::round::{
    build_season, code_hash, sandbox, seal_hash, season_wasm_path, NoGitHub, SandboxRpc, SANDBOX_JUDGE,
};
use race_runner::wasm_dir;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Once;
use std::task::Poll;
use std::time::Duration;

fn built() {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| {
        build_targets().expect("build wasm");
        build_season().expect("build the season treasury");
    });
}

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// A mask: its account, and the one key it holds for each contract it may call.
struct Mask {
    id: AccountId,
    keys: HashMap<AccountId, Account>,
}

impl Mask {
    fn on(&self, receiver: &AccountId) -> &Account {
        self.keys.get(receiver).unwrap_or_else(|| panic!("{} has no key for {receiver}", self.id))
    }
}

struct World {
    _node: near_sandbox::Sandbox,
    worker: Worker<Sandbox>,
    season: AccountId,
    bounty: AccountId,
    stub: Contract,
    scheduler: Account,
    masks: Vec<Mask>,
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

/// The scheduler calls `collect`; the rounds it asked about. Prints the gas each receipt burnt.
async fn collect(w: &World) -> Result<u32> {
    let r = w.scheduler.call(&w.season, "collect").args_json(json!({})).gas(Gas::from_tgas(300)).transact().await?;
    let mut burnt = vec![];
    for o in r.receipt_outcomes() {
        burnt.push(format!("{} {:.1}", o.executor_id, o.gas_burnt.as_gas() as f64 / 1e12));
    }
    println!("collect: total {:.1} TGas; {}", r.total_gas_burnt.as_gas() as f64 / 1e12, burnt.join(", "));
    let logs = r.logs().join("\n");
    Ok(r.into_result().with_context(|| format!("collect: {logs}"))?.json::<u32>()?)
}

async fn balance(worker: &Worker<Sandbox>, id: &AccountId) -> Result<u128> {
    Ok(worker.view_account(id).await?.balance.as_yoctonear())
}

/// Every key on the account, as (full access?, receiver).
async fn keys(worker: &Worker<Sandbox>, id: &AccountId) -> Result<Vec<(bool, String)>> {
    Ok(worker
        .view_access_keys(id)
        .await?
        .into_iter()
        .map(|k| match k.access_key.permission {
            AccessKeyPermission::FullAccess => (true, String::new()),
            AccessKeyPermission::FunctionCall(f) => (false, f.receiver_id),
        })
        .collect())
}

/// Swaps the account's full key for function-call keys, one per receiver and its methods (none: any method), in one
/// transaction signed by the full key itself. From then on the account can only call those contracts, with no NEAR.
async fn only_function_call_keys(
    worker: &Worker<Sandbox>,
    account: &Account,
    grants: &[(&AccountId, &[&str])],
) -> Result<HashMap<AccountId, Account>> {
    let mut batch = account.batch(account.id());
    let mut out = HashMap::new();
    for (receiver, methods) in grants {
        let key = SecretKey::from_random(KeyType::ED25519);
        batch = batch.add_key(key.public_key(), AccessKey::function_call_access(receiver, methods, None));
        out.insert((*receiver).clone(), Account::from_secret_key(account.id().clone(), key, worker));
    }
    batch.delete_key(account.secret_key().public_key()).transact().await?.into_result()?;
    Ok(out)
}

/// The scheduler says "now". The whole chain (the bounty contract's state, the safe, `open_safe`) runs in this one
/// transaction; its value is the round the treasury recorded.
async fn open_next(w: &World) -> Result<Value> {
    let r = w.scheduler.call(&w.season, "open_next").gas(Gas::from_tgas(300)).transact().await?;
    let logs = r.logs().join("\n");
    let round: Value = r.into_result().with_context(|| format!("open_next: {logs}"))?.json()?;
    if round.is_null() {
        bail!("no round opened: {logs}");
    }
    Ok(round)
}

/// One mask plays the round it found the hole of: seals the plan in the commit window, plays it on the safe after
/// the window with its key on the safe, reveals it and claims its drain with nothing attached. The judge's request
/// waits in the stub; the real judge answers it from the sandbox's chain. Returns the bounty's final state.
async fn play(w: &World, round: &Value, mask: usize, calls: Vec<Value>) -> Result<Value> {
    let id = round["id"].as_str().context("round id")?.to_string();
    let safe: AccountId = round["safe"].as_str().context("safe")?.parse()?;
    let m = &w.masks[mask];
    let plan = serde_json::to_string(&calls)?;
    let salt = format!("{}-season-salt-0001", m.id.as_str().split('.').next().unwrap());
    let hash = seal_hash(&id, m.id.as_str(), &salt, &plan);
    let on_bounty = m.on(&w.bounty);
    on_bounty
        .call(&w.bounty, "commit")
        .args_json(json!({ "id": id, "hash": hash }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .context("commit")?;

    let until: u64 = view(&w.worker, &w.bounty, "get_round", json!({ "id": id })).await?["commit_until"]
        .as_str()
        .context("commit_until")?
        .parse()?;
    wait_until(&w.worker, until).await?;

    let mut txs = vec![];
    for c in &calls {
        let r = m
            .on(&safe)
            .call(&safe, c["method"].as_str().unwrap())
            .args_json(&c["args"])
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        txs.push(r.outcome().transaction_hash.to_string());
        r.into_result().with_context(|| format!("play {}", c["method"]))?;
    }
    on_bounty
        .call(&w.bounty, "reveal")
        .args_json(json!({ "id": id, "plan": plan, "salt": salt, "txs": txs }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .context("reveal")?;

    let asked = view(&w.worker, w.stub.id(), "requests", json!({})).await?.as_array().map_or(0, Vec::len);
    let drain = txs.last().unwrap().clone();
    let pending = on_bounty
        .call(&w.bounty, "claim_drain")
        .args_json(json!({ "id": id, "tx_hash": drain }))
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
async fn three_rounds_open_pay_and_come_home_with_no_full_key() -> Result<()> {
    built();
    let read = |p: std::path::PathBuf| std::fs::read(&p).with_context(|| format!("read {}", p.display()));
    let bounty_wasm = read(race_runner::round::bounty_wasm_path())?;
    let season_wasm = read(season_wasm_path())?;
    let live_safe = read(wasm_dir().join("live_safe.wasm"))?;
    let stub_wasm = read(wasm_dir().join("outlayer_stub.wasm"))?;
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
    let sponsor = sub("sponsor", 100).await?;
    let scheduler = sub("scheduler", 10).await?;
    // A team of its own, with a safe of its own, beside the season: what its reclaim may and may not take.
    let crew = sub("crew", 20).await?;
    let mut mask_accounts = vec![];
    for name in ["nova", "onyx", "oracle"] {
        mask_accounts.push(sub(name, 10).await?);
    }
    let mask_ids: Vec<AccountId> = mask_accounts.iter().map(|a| a.id().clone()).collect();
    let stub = sub("outlayer", 10).await?.deploy(&stub_wasm).await?.into_result()?;

    // The bounty contract and the treasury, each born without a key: create, fund, deploy, new in one transaction.
    let bounty: AccountId = format!("bounty.{}", root.id()).parse()?;
    root.batch(&bounty)
        .create_account()
        .transfer(NearToken::from_near(10))
        .deploy(&bounty_wasm)
        .call(
            Function::new("new")
                .args_json(
                    json!({ "outlayer": stub.id(), "judge_project": "admin/judge", "judge_version": SANDBOX_JUDGE,
                                   "admin": admin.id(), "safe_codes": [live_code] }),
                )
                .gas(Gas::from_tgas(50)),
        )
        .transact()
        .await?
        .into_result()
        .context("deploy the bounty contract")?;
    let season: AccountId = format!("season.{}", root.id()).parse()?;
    let (nova, onyx) = (mask_ids[0].as_str(), mask_ids[1].as_str());
    // The safes of the library without the lock (pause-bypass and the rest) take no live round: the program races
    // live-safe only.
    let program = json!({
        "masks": mask_ids,
        "targets": [
            { "challenge": "live-safe", "code_hash": live_code, "init": "{}",
              "safe_fund": (3 * ONE_NEAR).to_string(), "min_loot": ONE_NEAR.to_string() },
        ],
        "prize": ONE_NEAR.to_string(),
        "hours": 1, "commit_minutes": 30, "reveal_minutes": 30,
        "judge_version": SANDBOX_JUDGE,
        // A round every 3 minutes, so the second one is due soon after the first.
        "first_minute": 0, "every_minutes": 3,
    });
    let limits = json!({ "max_prize": (2 * ONE_NEAR).to_string(), "max_safe_fund": (5 * ONE_NEAR).to_string(), "max_per_day": 4 });
    root.batch(&season)
        .create_account()
        .transfer(NearToken::from_near(10))
        .deploy(&season_wasm)
        .call(
            Function::new("new")
                .args_json(json!({ "name": "s1", "admin": admin.id(), "scheduler": scheduler.id(), "bounty": bounty,
                                   "limits": limits, "safe_codes": [live_code], "program": program }))
                .gas(Gas::from_tgas(100)),
        )
        .transact()
        .await?
        .into_result()
        .context("deploy the season treasury")?;
    for id in [&bounty, &season] {
        assert!(keys(&worker, id).await?.is_empty(), "{id} holds no key");
    }

    // A sponsor fills the treasury and publishes the safe's code once, as a global contract by hash.
    sponsor.call(&season, "fund").deposit(NearToken::from_near(20)).transact().await?.into_result().context("fund")?;
    for code in [&live_safe] {
        let cost = 100_000_000_000_000_000_000u128 * code.len() as u128;
        let published = sponsor
            .call(&season, "publish_code")
            .args(code.clone())
            .deposit(NearToken::from_yoctonear(cost + ONE_NEAR / 100))
            .gas(Gas::from_tgas(300))
            .transact()
            .await?;
        assert!(published.json::<bool>()?, "publish {}", code_hash(code));
    }

    // The crew's safe: the crew is its team, the bounty contract its arbiter; NOVA is its one mask. Deployed and made
    // by the safe's own key, which `new` drops.
    let crew_safe = sub("crewsafe", 5).await?;
    let crew_safe = crew_safe.deploy(&live_safe).await?.into_result()?;
    crew_safe
        .call("new")
        .args_json(json!({ "owner": crew_safe.id(), "masks": [mask_ids[0]], "arbiter": bounty, "team": crew.id() }))
        .transact()
        .await?
        .into_result()
        .context("make the crew's safe")?;
    let crew_safe = crew_safe.id().clone();

    // From here on nobody holds a full key that matters: the scheduler may only call open_next; each mask may only
    // call the bounty contract's round methods and the safes the season will make, and the crew's.
    let s1: AccountId = format!("s0001.{season}").parse()?;
    let s2: AccountId = format!("s0002.{season}").parse()?;
    let s3: AccountId = format!("s0003.{season}").parse()?;
    let scheduler_keys = only_function_call_keys(&worker, &scheduler, &[(&season, &["open_next", "collect"])]).await?;
    let scheduler = scheduler_keys[&season].clone();
    let mut masks = vec![];
    for a in &mask_accounts {
        let round_methods: &[&str] = &["commit", "reveal", "claim_drain", "settle"];
        let grants: &[(&AccountId, &[&str])] =
            &[(&bounty, round_methods), (&s1, &[]), (&s2, &[]), (&s3, &[]), (&crew_safe, &[])];
        let keys = only_function_call_keys(&worker, a, grants).await?;
        masks.push(Mask { id: a.id().clone(), keys });
    }
    let w = World { _node: node, worker, season: season.clone(), bounty: bounty.clone(), stub, scheduler, masks };

    // The scheduler's key reaches nothing but open_next and collect.
    let fund = w.scheduler.call(&season, "fund").deposit(NearToken::from_near(1)).transact().await;
    assert!(fund.map_or(true, |r| r.is_failure()), "a function-call key attaches no NEAR");
    let other =
        w.scheduler.call(&season, "drop_safe_code").args_json(json!({ "code_hash": live_code })).transact().await;
    assert!(other.map_or(true, |r| r.is_failure()), "the scheduler's key calls open_next and collect only");

    // Round 1. NOVA takes the safe through its planted hole.
    let next = view(&w.worker, &season, "next", json!({})).await?;
    assert_eq!((next["n"].as_u64(), next["challenge"].as_str()), (Some(1), Some("live-safe")));
    let r1 = open_next(&w).await?;
    assert_eq!((r1["n"].as_u64(), r1["safe"].as_str()), (Some(1), Some(s1.as_str())));
    assert!(r1["id"].as_str().unwrap().starts_with("s1-0001-"));
    assert_eq!(r1["bounty"], bounty.as_str());
    assert!(keys(&w.worker, &s1).await?.is_empty(), "the safe holds no key");
    // The treasury made the safe with the bounty contract as its arbiter and itself as the team, and recorded the
    // round only once the safe was armed for it.
    assert_eq!(view(&w.worker, &s1, "arbiter", json!({})).await?, json!(bounty));
    assert_eq!(view(&w.worker, &s1, "team", json!({})).await?, json!(season));
    let lock = view(&w.worker, &s1, "get_round", json!({})).await?;
    assert_eq!((lock["bounty"].as_str(), lock["arbiter"].as_str()), (r1["id"].as_str(), Some(bounty.as_str())));
    assert_eq!(lock["opens_ns"], r1["commit_until_ns"]);
    // What the bounty contract kept of the prize for the round's storage and the masks' reserve: within what the
    // treasury counts on (`min_prize`), so a program it allows never leaves the winner less than 0.1 NEAR.
    let b = view(&w.worker, &bounty, "get", json!({ "id": r1["id"] })).await?;
    let kept = ONE_NEAR - b["amount"].as_str().context("amount")?.parse::<u128>()?;
    let least: u128 = view(&w.worker, &season, "min_prize", json!({ "masks": 3 })).await?.as_str().unwrap().parse()?;
    assert!(kept <= least - ONE_NEAR / 10, "the bounty contract kept {kept}, the season counts on {least}");
    // The treasury records the round as the bounty contract opened it.
    let on_bounty = view(&w.worker, &bounty, "get_round", json!({ "id": r1["id"] })).await?;
    assert_eq!(r1["commit_until_ns"], on_bounty["commit_until"]);
    assert_eq!(r1["deadline_ns"], on_bounty["deadline_ns"]);
    let details = w.worker.view_account(&s1).await?;
    assert!(format!("{:?}", details.contract_state).contains("GlobalHash"), "the safe runs global code: {details:?}");
    // Once a round is open for this slot, the next one waits for its own.
    let again = w.scheduler.call(&season, "open_next").gas(Gas::from_tgas(300)).transact().await?;
    assert!(again.is_failure(), "one round per slot");

    let nova_before = balance(&w.worker, &mask_ids[0]).await?;
    let sweep = (2 * ONE_NEAR).to_string();
    let b1 = play(
        &w,
        &r1,
        0,
        vec![
            json!({ "method": "set_owner", "args": { "new_owner": nova } }),
            json!({ "method": "sweep", "args": { "to": nova, "amount": sweep } }),
        ],
    )
    .await?;
    assert_eq!(b1["status"]["state"], "drained", "{b1}");
    assert_eq!(b1["status"]["winner"], nova);
    assert_eq!(b1["owner"], season.as_str(), "the treasury opened the round");
    let nova_won = balance(&w.worker, &mask_ids[0]).await? - nova_before;
    assert!(nova_won > 2 * ONE_NEAR, "NOVA took the safe's NEAR and the bounty: {nova_won}");

    // Round 2, at the next slot, on a fresh safe s0002. This time ONYX finds the hole first.
    let next = view(&w.worker, &season, "next", json!({})).await?;
    assert_eq!((next["n"].as_u64(), next["challenge"].as_str()), (Some(2), Some("live-safe")));
    wait_until(&w.worker, next["at_ns"].as_str().unwrap().parse()?).await?;
    let r2 = open_next(&w).await?;
    assert_eq!(
        (r2["n"].as_u64(), r2["safe"].as_str(), r2["challenge"].as_str()),
        (Some(2), Some(s2.as_str()), Some("live-safe"))
    );
    assert!(keys(&w.worker, &s2).await?.is_empty(), "the safe holds no key");
    let onyx_before = balance(&w.worker, &mask_ids[1]).await?;
    let b2 = play(
        &w,
        &r2,
        1,
        vec![
            json!({ "method": "set_owner", "args": { "new_owner": onyx } }),
            json!({ "method": "sweep", "args": { "to": onyx, "amount": sweep } }),
        ],
    )
    .await?;
    assert_eq!(b2["status"]["state"], "drained", "{b2}");
    assert_eq!(b2["status"]["winner"], onyx);
    let onyx_won = balance(&w.worker, &mask_ids[1]).await? - onyx_before;
    assert!(onyx_won > 2 * ONE_NEAR, "ONYX took the safe's NEAR and the bounty: {onyx_won}");

    // The crew opens a round of its own on its safe. While it is open the crew takes nothing back, and nobody else
    // may even ask.
    let crew_round = json!({ "id": "crew-0001-round", "safe": crew_safe });
    crew.call(&bounty, "open_safe")
        .args_json(json!({ "id": "crew-0001-round", "safe": crew_safe, "masks": [mask_ids[0]],
                           "min_loot": ONE_NEAR.to_string(), "hours": 1, "commit_minutes": 1, "reveal_minutes": 6,
                           "safe_code": live_code, "judge_version": SANDBOX_JUDGE }))
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()
        .context("the crew opens its round")?;
    let crew_before = balance(&w.worker, &crew_safe).await?;
    let early = crew.call(&crew_safe, "reclaim").gas(Gas::from_tgas(100)).transact().await?;
    assert!(early.is_failure(), "the crew takes nothing back while its round is open");
    assert!(format!("{:?}", early.failures()).contains("the round is not over"), "{:?}", early.failures());
    let stranger = sponsor.call(&crew_safe, "reclaim").gas(Gas::from_tgas(100)).transact().await?;
    assert!(stranger.is_failure(), "only the safe's own team asks");
    assert!(format!("{:?}", stranger.failures()).contains("only the safe's team"), "{:?}", stranger.failures());
    assert_eq!(balance(&w.worker, &crew_safe).await?, crew_before, "nothing left the crew's safe");
    // NOVA wins the crew's round.
    let b3 = play(
        &w,
        &crew_round,
        0,
        vec![
            json!({ "method": "set_owner", "args": { "new_owner": nova } }),
            json!({ "method": "sweep", "args": { "to": nova, "amount": sweep } }),
        ],
    )
    .await?;
    assert_eq!(b3["status"]["state"], "drained", "{b3}");

    // Round 3, which nobody wins: no mask seals, and the safe keeps its 3 NEAR.
    let next = view(&w.worker, &season, "next", json!({})).await?;
    assert_eq!((next["n"].as_u64(), next["challenge"].as_str()), (Some(3), Some("live-safe")));
    wait_until(&w.worker, next["at_ns"].as_str().unwrap().parse()?).await?;
    let r3 = open_next(&w).await?;
    assert_eq!((r3["n"].as_u64(), r3["safe"].as_str()), (Some(3), Some(s3.as_str())));
    // While the rounds are out, each one's bounty and its safe's NEAR count as the treasury's own, out in the round.
    let s = view(&w.worker, &season, "season", json!({})).await?;
    let out: u128 = s["outstanding"].as_str().unwrap().parse()?;
    assert_eq!(out, 3 * (ONE_NEAR + 3 * ONE_NEAR), "the bounties and the safes of three rounds are out: {s}");
    let stranger = sponsor.call(&s3, "reclaim").gas(Gas::from_tgas(100)).transact().await?;
    assert!(stranger.is_failure(), "only the treasury, the safe's team, takes back what round 3 leaves");
    // The claims of every round are not over: nothing to bring home yet.
    assert_eq!(collect(&w).await?, 0);

    // The season's record, and the next round back at the first target.
    let s = view(&w.worker, &season, "season", json!({})).await?;
    assert_eq!((s["rounds"].as_u64(), s["safes"].as_u64()), (Some(3), Some(3)));
    let latest = view(&w.worker, &season, "latest", json!({})).await?;
    assert_eq!(latest[0]["id"], r3["id"]);
    assert_eq!(latest[1]["id"], r2["id"]);
    assert_eq!(latest[2]["id"], r1["id"]);
    let next = view(&w.worker, &season, "next", json!({})).await?;
    assert_eq!((next["n"].as_u64(), next["challenge"].as_str()), (Some(4), Some("live-safe")));

    // Past round 3's deadline and the claim grace. The crew's round was won: its safe gives the crew nothing.
    let deadline: u64 = r3["deadline_ns"].as_str().unwrap().parse()?;
    wait_until(&w.worker, deadline + 13 * 3_600_000_000_000).await?;
    let crew_before = balance(&w.worker, &crew_safe).await?;
    let late = crew.call(&crew_safe, "reclaim").gas(Gas::from_tgas(100)).transact().await?;
    assert!(late.is_failure(), "after a won round the team takes nothing");
    assert!(format!("{:?}", late.failures()).contains("a mask won the round"), "{:?}", late.failures());
    assert_eq!(balance(&w.worker, &crew_safe).await?, crew_before, "what NOVA left stays in the crew's safe");

    // The scheduler brings the three rounds home: two won, one nobody won. Round 3's bounty and its safe's NEAR come
    // back to the treasury; the safes of the won rounds keep what the winners left.
    let treasury_before = balance(&w.worker, &season).await?;
    let s1_before = balance(&w.worker, &s1).await?;
    // On NEAR's own runtime 300 TGas carry two rounds home in one call, each with the gas its safe's way home may take.
    let mut asked = collect(&w).await?;
    assert_eq!(asked, 2, "two rounds a call");
    for _ in 0..3 {
        asked += collect(&w).await?;
        if view(&w.worker, &season, "collectable", json!({})).await? == json!(0) {
            break;
        }
    }
    assert_eq!(asked, 3);
    let rounds = view(&w.worker, &season, "rounds", json!({})).await?;
    let ends: Vec<(&str, Value)> = rounds
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["outcome"].as_str().unwrap_or("-"), r["reclaimed"].clone()))
        .collect();
    assert_eq!(ends, [("drained", json!(false)), ("drained", json!(false)), ("refunded", json!(true))], "{rounds}");
    let s = view(&w.worker, &season, "season", json!({})).await?;
    assert_eq!(s["outstanding"], "0", "nothing is out any more: {s}");
    let came_home = balance(&w.worker, &season).await? - treasury_before;
    let bounty_back: u128 =
        view(&w.worker, &bounty, "get", json!({ "id": r3["id"] })).await?["amount"].as_str().unwrap().parse()?;
    assert!(came_home > bounty_back + 3 * ONE_NEAR - ONE_NEAR / 50, "round 3's bounty and safe came home: {came_home}");
    let left: u128 = view(&w.worker, &s3, "available", json!({})).await?.as_str().unwrap().parse()?;
    assert_eq!(left, 0, "round 3's safe holds nothing it could pay out");
    assert_eq!(balance(&w.worker, &s1).await?, s1_before, "round 1's safe keeps what NOVA left");

    // Not one full key anywhere in the three rounds.
    for id in [&season, &bounty, &s1, &s2, &s3, &crew_safe] {
        assert!(keys(&w.worker, id).await?.is_empty(), "{id} holds no key");
    }
    for id in mask_ids.iter().chain([w.scheduler.id()]) {
        let k = keys(&w.worker, id).await?;
        assert!(!k.is_empty() && k.iter().all(|(full, _)| !full), "{id} holds function-call keys only: {k:?}");
    }
    println!("round 1 {} on {}: {}", r1["id"], s1, b1["status"]);
    println!("round 2 {} on {}: {}", r2["id"], s2, b2["status"]);
    println!("round 3 {} on {}: nobody won; {} yoctoNEAR came home", r3["id"], s3, came_home);
    println!("the crew's round on {}: {}", crew_safe, b3["status"]);
    Ok(())
}
