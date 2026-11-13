//! The house contract (contracts/house) on a real local node: the daily round run day after day by a function-call key
//! that reaches the house's seven steps and nothing else, where a full key of the house used to sign every step.
//!
//! Everything on chain is the real code: the house contract on the house's own account, the bounty contract, the
//! vault (live-safe, made again each day by the house), `home` on the masks (contracts/home, the mainnet build), and
//! the judge (services/judge), which reads the sandbox's own RPC. Only OutLayer is a stand-in (`outlayer-stub`), as in
//! tests/retire.rs.
//!
//! - day one: the key cannot open a round before it makes the vault; it makes the vault, opens the round, refunds it
//!   once nobody won. A second round in the slot, a round past the slot's window, another code for the vault, a
//!   round id out of turn: each is refused;
//! - day two, the next slot: yesterday's vault still stands, armed for its round, and the key's `open_round` comes
//!   first, as a leaked key would send it at the slot's first second: it is refused and nothing moves, where the
//!   bounty contract would have taken the deposit, failed to arm the vault and given it back only later, with the
//!   slot gone. The key retires the vault; a vault it makes and retires again opens nothing; it makes the vault
//!   again; a stranger has taken the round's id on the bounty contract first, so `open_safe` is refused, the deposit
//!   comes back and the slot is free again; the key opens the next id in the same slot; a mask wins behind an earlier
//!   seal that never plays, and once the reveal window is over the key settles it; the vault retires;
//! - the key cannot move NEAR, add or delete a key, deploy code, change the terms or call anything but the seven
//!   steps on the house; the terms change only with a full key and one yoctoNEAR, and new terms take a new vault;
//! - on the house's real name, the one `home` sends to: the key's `home` brings a mask's winnings home, and reaches
//!   the round's masks alone.

use anyhow::{bail, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountDetailsPatch, AccountId, Contract, Worker};
use race_runner::build_targets;
use race_runner::round::{
    bounty_wasm_path, build_home, build_house, code_hash, home_wasm_path, house_wasm_path, sandbox, seal_hash,
    NoGitHub, SandboxRpc, SANDBOX_JUDGE,
};
use race_runner::wasm_dir;
use serde_json::{json, Value};
use std::sync::Once;
use std::task::Poll;
use std::time::Duration;

fn built() {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| {
        build_targets().expect("build wasm");
        build_house().expect("build the house contract");
        build_home().expect("build home");
    });
}

const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = ONE_NEAR / 1000;
const BYTE_COST: u128 = 10_000_000_000_000_000_000;
const MINUTE_NS: u64 = 60_000_000_000;
const HOUR_NS: u64 = 60 * MINUTE_NS;
/// The seven steps the key reaches, as the owner adds it (contracts/house/README.md).
const DAY_METHODS: &[&str] = &["home", "unstick", "settle", "refund", "retire", "make_vault", "open_round"];
/// The house `home` (the mainnet build) sends to.
const REAL_HOUSE: &str = "house.maskwars.near";
/// The bytes a plain account with one full key stores: its record and the key.
const PLAIN_ACCOUNT_BYTES: u64 = 182;
const NO_VAULT: &str = "no vault made in this slot: make_vault first";
/// The terms here: rounds of an hour, a slot every 800 minutes (an hour and the 12-hour claim grace fit before the
/// next one), so a round may open in the first 20 minutes of a slot.
const HOURS: u64 = 1;
const EVERY_MINUTES: u64 = 800;
const SAFE: u128 = 5 * ONE_NEAR;
const DEPOSIT: u128 = ONE_NEAR;
/// What the vault and its round's deposit leave the house besides the gas: a contract earns a share of its calls' gas.
const DUST: u128 = ONE_NEAR / 100;

struct Mask {
    id: AccountId,
    account: Account,
}

struct World {
    _node: near_sandbox::Sandbox,
    worker: Worker<Sandbox>,
    /// The house's full key: the owner's, off GitHub.
    owner: Account,
    /// The house's function-call key: what the daily run holds.
    key: Account,
    house: AccountId,
    vault: AccountId,
    bounty: AccountId,
    stub: Contract,
    masks: Vec<Mask>,
    stranger: Account,
    safe_wasm: Vec<u8>,
    first_minute: u64,
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

/// The balance once the gas refunds of the calls so far have landed.
async fn settled(worker: &Worker<Sandbox>, id: &AccountId) -> Result<u128> {
    worker.fast_forward(5).await?;
    balance(worker, id).await
}

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

fn why(r: &ExecutionFinalResult) -> String {
    format!("{:?}", r.failures())
}

fn gas(r: &ExecutionFinalResult) -> String {
    let each: Vec<String> = r
        .receipt_outcomes()
        .iter()
        .map(|o| format!("{} {:.2}", o.executor_id, o.gas_burnt.as_gas() as f64 / 1e12))
        .collect();
    format!(
        "total {:.2} TGas, {:.5} NEAR; {}",
        r.total_gas_burnt.as_gas() as f64 / 1e12,
        burnt(r) as f64 / ONE_NEAR as f64,
        each.join(", ")
    )
}

/// The NEAR a call burnt for gas: all of it the house's, who signed it, the receipts it sent on included.
fn burnt(r: &ExecutionFinalResult) -> u128 {
    r.outcomes().iter().map(|o| o.tokens_burnt.as_yoctonear()).sum()
}

/// How far a balance may stray from what the gas burnt says: gas refunds land in whole steps of the gas price.
const EPS: u128 = MILLI / 10;

fn near_to(got: u128, want: u128) -> bool {
    got.abs_diff(want) <= EPS
}

/// A fresh node with the bounty contract, the masks, a stranger, and the house: its contract deployed and set up by
/// its full key in one transaction, then a function-call key for the seven steps added. The schedule's first slot
/// began a minute ago.
async fn world() -> Result<World> {
    world_at(None).await
}

/// The same, with the house under `name` (put on the node with a full key of the test's own, as the sandbox lets
/// anyone do) instead of a sub-account of the node's root.
async fn world_at(name: Option<&str>) -> Result<World> {
    built();
    let read = |p: std::path::PathBuf| std::fs::read(&p).with_context(|| format!("read {}", p.display()));
    let bounty_wasm = read(bounty_wasm_path())?;
    let safe_wasm = read(wasm_dir().join("live_safe.wasm"))?;
    let stub_wasm = read(wasm_dir().join("outlayer_stub.wasm"))?;
    let house_wasm = read(house_wasm_path())?;
    let safe_code = code_hash(&safe_wasm);

    let (node, worker) = sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &str, near: u128| {
        let root = root.clone();
        let name = name.to_string();
        async move {
            root.create_subaccount(&name)
                .initial_balance(NearToken::from_near(near))
                .transact()
                .await?
                .into_result()
                .with_context(|| format!("create {name}"))
        }
    };
    let owner = match name {
        None => sub("house", 30).await?,
        Some(name) => {
            let id: AccountId = name.parse()?;
            let full = SecretKey::from_random(KeyType::ED25519);
            worker
                .patch(&id)
                .account(
                    AccountDetailsPatch::default().balance(NearToken::from_near(30)).storage_usage(PLAIN_ACCOUNT_BYTES),
                )
                .access_key(full.public_key(), AccessKey::full_access())
                .transact()
                .await
                .with_context(|| format!("put {id} on the node"))?;
            Account::from_secret_key(id, full, &worker)
        }
    };
    let stranger = sub("stranger", 10).await?;
    let mut masks = vec![];
    for name in ["nova", "onyx", "oracle"] {
        let a = sub(name, 10).await?;
        masks.push(Mask { id: a.id().clone(), account: a });
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
                                   "judge_version": SANDBOX_JUDGE, "admin": root.id(), "safe_codes": [safe_code] }))
                .gas(Gas::from_tgas(50)),
        )
        .transact()
        .await?
        .into_result()
        .context("deploy the bounty contract")?;

    let house = owner.id().clone();
    let vault: AccountId = format!("vault.{house}").parse()?;
    let first_minute = now(&worker).await? / MINUTE_NS - 1;
    let mut args = terms(&bounty, &vault, &masks, &safe_code, first_minute);
    args["last_round"] = json!(0);
    let deployed = owner
        .batch(&house)
        .deploy(&house_wasm)
        .call(Function::new("new").args_json(args).gas(Gas::from_tgas(30)))
        .transact()
        .await?;
    assert!(deployed.is_success(), "the owner deploys and sets up the house: {}", why(&deployed));
    let stored = worker.view_account(&house).await?.storage_usage;
    println!(
        "the house contract: {} bytes of code; the account stores {stored} bytes, which lock {} NEAR",
        house_wasm.len(),
        (BYTE_COST * u128::from(stored)) as f64 / ONE_NEAR as f64
    );

    let hot = SecretKey::from_random(KeyType::ED25519);
    // On mainnet the key's allowance is 0.3 NEAR, about a week of days. Here it is 1 NEAR: two days and every refused
    // call besides, each sent with 150 TGas.
    owner
        .batch(&house)
        .add_key(hot.public_key(), AccessKey::function_call_access(&house, DAY_METHODS, Some(NearToken::from_near(1))))
        .transact()
        .await?
        .into_result()
        .context("add the day's key")?;
    let with_key = worker.view_account(&house).await?.storage_usage;
    println!("the day's key stores {} bytes", with_key - stored);
    let key = Account::from_secret_key(house.clone(), hot, &worker);
    Ok(World { _node: node, worker, owner, key, house, vault, bounty, stub, masks, stranger, safe_wasm, first_minute })
}

/// The house's terms for this node, as `new` and `configure` take them.
fn terms(bounty: &AccountId, vault: &AccountId, masks: &[Mask], safe_code: &str, first_minute: u64) -> Value {
    let masks: Vec<&AccountId> = masks.iter().map(|m| &m.id).collect();
    json!({
        "bounty": bounty, "vault": vault, "safe_code": safe_code, "masks": masks, "judge_version": SANDBOX_JUDGE,
        "safe": SAFE.to_string(), "deposit": DEPOSIT.to_string(), "min_loot": ONE_NEAR.to_string(),
        "gas": (100 * MILLI).to_string(), "hours": HOURS, "commit_minutes": 1, "reveal_minutes": 12,
        "first_minute": first_minute, "every_minutes": EVERY_MINUTES,
        "safe_max": (10 * ONE_NEAR).to_string(), "deposit_max": (2 * ONE_NEAR).to_string(),
    })
}

impl World {
    /// One step of the day, sent with `by`'s key to the house.
    async fn step(&self, by: &Account, method: &str, args: Value) -> Result<ExecutionFinalResult> {
        let r = by.call(&self.house, method).args_json(args).gas(Gas::from_tgas(150)).transact().await?;
        println!("{method}: {}", gas(&r));
        Ok(r)
    }

    async fn make_vault(&self, by: &Account, code: &[u8]) -> Result<ExecutionFinalResult> {
        let r = by.call(&self.house, "make_vault").args(code.to_vec()).gas(Gas::from_tgas(150)).transact().await?;
        println!("make_vault: {}", gas(&r));
        Ok(r)
    }

    async fn open_round(&self, id: &str) -> Result<ExecutionFinalResult> {
        self.step(&self.key, "open_round", json!({ "id": id })).await
    }

    async fn house_now(&self) -> Result<Value> {
        view(&self.worker, &self.house, "now", json!({})).await
    }

    async fn house_day(&self) -> Result<Value> {
        view(&self.worker, &self.house, "day", json!({})).await
    }

    /// The day as the house keeps it: the last round, its slot, and the slot of the vault made last (0: none).
    fn day(last_round: u32, last_slot: u64, made_slot: u64) -> Value {
        json!({ "last_round": last_round, "last_slot_ns": last_slot.to_string(), "made_slot_ns": made_slot.to_string() })
    }

    async fn bounty_state(&self, id: &str) -> Result<Value> {
        view(&self.worker, &self.bounty, "get", json!({ "id": id })).await
    }

    /// The slot `k` slots after the first, ns.
    fn slot(&self, k: u64) -> u64 {
        (self.first_minute + k * EVERY_MINUTES) * MINUTE_NS
    }

    /// The key makes the vault: the account with the pinned NEAR, the pinned code, its own owner, the round's masks,
    /// the bounty contract as its arbiter and the house as its team, and no key.
    async fn made(&self) -> Result<()> {
        let before = settled(&self.worker, &self.house).await?;
        let r = self.make_vault(&self.key, &self.safe_wasm).await?;
        assert!(r.is_success(), "the key makes the vault: {}", why(&r));
        let v = self.worker.view_account(&self.vault).await?;
        assert!(format!("{:?}", v.contract_state).contains(&code_hash(&self.safe_wasm)), "the pinned code: {v:?}");
        assert_eq!(self.worker.view_access_keys(&self.vault).await?.len(), 0, "nobody holds a key to the vault");
        let masks: Vec<&AccountId> = self.masks.iter().map(|m| &m.id).collect();
        assert_eq!(view(&self.worker, &self.vault, "get_owner", json!({})).await?, json!(self.vault));
        assert_eq!(view(&self.worker, &self.vault, "team", json!({})).await?, json!(self.house));
        assert_eq!(view(&self.worker, &self.vault, "arbiter", json!({})).await?, json!(self.bounty));
        assert_eq!(view(&self.worker, &self.vault, "masks", json!({})).await?, json!(masks));
        // The vault says what it is, and where its source is (NEP-330).
        assert_eq!(
            view(&self.worker, &self.vault, "about", json!({})).await?,
            json!(
                "MASK WARS arena target. Funded only by MASK WARS. Only the masks of this round can open it. After the \
                 round the rest goes home."
            )
        );
        let meta = view(&self.worker, &self.vault, "contract_source_metadata", json!({})).await?;
        assert_eq!(meta["version"], json!("1.7.0"), "{meta}");
        assert!(
            meta["link"].as_str().is_some_and(|l| l.starts_with("https://github.com/plavutskyi/mask-wars")),
            "{meta}"
        );
        let after = settled(&self.worker, &self.house).await?;
        assert!(near_to(before - after, SAFE + burnt(&r)), "the vault took {SAFE} and the gas: {before} then {after}");
        let n = self.house_now().await?;
        assert_eq!(n["vault_made"], true, "the house records the slot the vault was made in: {n}");
        assert_eq!(self.house_day().await?["made_slot_ns"], n["slot_ns"]);
        Ok(())
    }

    /// The key opens round `id`; the round as the bounty contract holds it, opened by the house on the vault.
    async fn opened(&self, id: &str) -> Result<Value> {
        let before = settled(&self.worker, &self.house).await?;
        let r = self.open_round(id).await?;
        assert!(r.is_success(), "the key opens {id}: {}", why(&r));
        let after = settled(&self.worker, &self.house).await?;
        assert!(
            near_to(before - after, DEPOSIT + burnt(&r)),
            "the deposit went to the bounty contract: {before} then {after}"
        );
        let b = self.bounty_state(id).await?;
        assert_eq!((&b["owner"], &b["status"]["state"]), (&json!(self.house), &json!("open")), "{b}");
        let lock = view(&self.worker, &self.vault, "get_round", json!({})).await?;
        assert_eq!(lock["bounty"], id, "the vault is armed for the round");
        view(&self.worker, &self.bounty, "get_round", json!({ "id": id })).await
    }

    /// The key retires the vault once its round is over: the account goes, and the house has all it held.
    async fn retired(&self) -> Result<()> {
        let held = balance(&self.worker, &self.vault).await?;
        let before = settled(&self.worker, &self.house).await?;
        let r = self.step(&self.key, "retire", json!({})).await?;
        assert!(r.is_success(), "the key retires the vault: {}", why(&r));
        assert!(gone(&self.worker, &self.vault).await?, "the vault is gone");
        let after = settled(&self.worker, &self.house).await?;
        assert!(
            near_to(after + burnt(&r), before + held),
            "the house has all the vault held, {held}: {before} then {after}"
        );
        assert_eq!(self.house_day().await?["made_slot_ns"], "0", "no vault made here stands");
        Ok(())
    }

    /// The key's `open_round` is refused for want of a vault made in this slot, and nothing moves: no bounty on the
    /// bounty contract, the house's NEAR all there but the gas, the day as it was.
    async fn refused_without_a_vault(&self, id: &str) -> Result<()> {
        let day = self.house_day().await?;
        let before = settled(&self.worker, &self.house).await?;
        let r = self.open_round(id).await?;
        assert!(r.is_failure() && why(&r).contains(NO_VAULT), "{id}: {}", why(&r));
        assert!(
            r.receipt_outcomes().iter().all(|o| o.executor_id != self.bounty),
            "nothing reached the bounty contract"
        );
        assert_eq!(self.bounty_state(id).await?, Value::Null, "the bounty contract holds no {id}");
        let after = settled(&self.worker, &self.house).await?;
        assert!(near_to(before - after, burnt(&r)), "nothing left the house but gas: {before} then {after}");
        assert_eq!(self.house_day().await?, day, "the slot is still free");
        Ok(())
    }
}

/// The planted hole: take the vault, sweep `near` NEAR to the mask.
fn the_hole(mask: &AccountId, near: u128) -> Vec<Value> {
    vec![
        json!({ "method": "set_owner", "args": { "new_owner": mask } }),
        json!({ "method": "sweep", "args": { "to": mask, "amount": (near * ONE_NEAR).to_string() } }),
    ]
}

struct Sealed {
    calls: Vec<Value>,
    plan: String,
    salt: String,
}

async fn seal(w: &World, id: &str, mask: usize, calls: Vec<Value>) -> Result<Sealed> {
    let m = &w.masks[mask];
    let plan = serde_json::to_string(&calls)?;
    let salt = format!("mask-{mask:02}-house-salt-0001");
    let hash = seal_hash(id, m.id.as_str(), &salt, &plan);
    m.account
        .call(&w.bounty, "commit")
        .args_json(json!({ "id": id, "hash": hash }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("{} seals", m.id))?;
    Ok(Sealed { calls, plan, salt })
}

/// Lets sandbox time pass until the vault lets the mask in: its slot has come, or an earlier seal missed its own.
async fn until_the_vault_lets_in(w: &World, mask: usize) -> Result<()> {
    for _ in 0..200 {
        let waits = view(&w.worker, &w.vault, "waits_for", json!({ "account_id": w.masks[mask].id })).await?;
        match waits.as_str() {
            None => return Ok(()),
            Some(s) if s.contains("another mask has its turn") || s.contains("an earlier seal goes first") => {}
            Some(s) => bail!("the vault never lets the mask in: {s}"),
        }
        w.worker.fast_forward(20).await?;
    }
    bail!("sandbox time did not reach the mask's turn");
}

async fn play(w: &World, mask: usize, sealed: &Sealed) -> Result<Vec<String>> {
    until_the_vault_lets_in(w, mask).await?;
    let mut txs = vec![];
    for c in &sealed.calls {
        let r = w.masks[mask]
            .account
            .call(&w.vault, c["method"].as_str().unwrap())
            .args_json(&c["args"])
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        txs.push(r.outcome().transaction_hash.to_string());
        r.into_result().with_context(|| format!("{} plays {}", w.masks[mask].id, c["method"]))?;
    }
    Ok(txs)
}

/// The mask reveals and claims its drain; the real judge answers from the sandbox's chain. The bounty afterwards.
async fn reveal_and_claim(w: &World, id: &str, mask: usize, sealed: &Sealed, txs: &[String]) -> Result<Value> {
    let m = &w.masks[mask];
    m.account
        .call(&w.bounty, "reveal")
        .args_json(json!({ "id": id, "plan": sealed.plan, "salt": sealed.salt, "txs": txs }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()
        .context("reveal")?;
    let asked = view(&w.worker, w.stub.id(), "requests", json!({})).await?.as_array().map_or(0, Vec::len);
    let pending = m
        .account
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
    w.bounty_state(id).await
}

#[tokio::test]
async fn two_days_of_the_circle_on_the_function_call_key_alone() -> Result<()> {
    let w = world().await?;
    let n = w.house_now().await?;
    assert_eq!(
        (&n["may_open"], &n["vault_made"], &n["next_round"], &n["opened"]),
        (&json!(false), &json!(false), &json!("race-0001"), &json!(false)),
        "{n}"
    );

    // ---- Day one: make, open, nobody wins, refund ----

    // No round before the vault is made in this slot.
    w.refused_without_a_vault("race-0001").await?;
    // Another code for the vault, or anyone but the house: refused before anything moves.
    let other = std::fs::read(wasm_dir().join("outlayer_stub.wasm"))?;
    let r = w.make_vault(&w.key, &other).await?;
    assert!(r.is_failure() && why(&r).contains("the wasm is not the vault's code"), "{}", why(&r));
    let r = w.make_vault(&w.stranger, &w.safe_wasm).await?;
    assert!(r.is_failure() && why(&r).contains("only the house's own keys"), "{}", why(&r));
    assert!(gone(&w.worker, &w.vault).await?, "no vault yet");
    w.made().await?;
    // The vault stands: a second one is not made, its NEAR comes back to the house, and the vault that stands still
    // counts as made in this slot.
    let before = settled(&w.worker, &w.house).await?;
    let r = w.make_vault(&w.key, &w.safe_wasm).await?;
    assert!(r.is_failure(), "the vault is made once");
    let after = settled(&w.worker, &w.house).await?;
    assert!(near_to(before - after, burnt(&r)), "nothing left the house but gas: {before} then {after}");
    assert_eq!(w.house_day().await?, World::day(0, 0, w.slot(0)));

    // A round id out of turn is refused.
    for (id, said) in [("race-1", "the round's id is race-<n>"), ("race-0000", "must come after the last round's")] {
        let r = w.open_round(id).await?;
        assert!(r.is_failure() && why(&r).contains(said), "{id}: {}", why(&r));
    }
    let round = w.opened("race-0001").await?;
    assert_eq!(w.house_day().await?, World::day(1, w.slot(0), w.slot(0)));
    // One round a slot.
    let r = w.open_round("race-0002").await?;
    assert!(r.is_failure() && why(&r).contains("this slot has its round"), "{}", why(&r));

    // Nobody seals. The vault stays while the round can be played and while its bounty is open; then the key
    // refunds the round, and its bounty is back at the house.
    let deadline: u64 = round["deadline_ns"].as_str().context("deadline")?.parse()?;
    wait_until(&w.worker, deadline).await?;
    let r = w.step(&w.key, "retire", json!({})).await?;
    assert!(r.is_failure() && why(&r).contains("the round is not over"), "{}", why(&r));
    let r = w.step(&w.key, "refund", json!({ "id": "race-0001" })).await?;
    assert!(r.is_failure() && why(&r).contains("the masks can still claim"), "{}", why(&r));
    wait_until(&w.worker, deadline + 12 * HOUR_NS + MINUTE_NS).await?;
    let before = settled(&w.worker, &w.house).await?;
    let r = w.step(&w.key, "refund", json!({ "id": "race-0001" })).await?;
    assert!(r.is_success(), "the key refunds the round nobody won: {}", why(&r));
    assert_eq!(w.bounty_state("race-0001").await?["status"]["state"], "refunded");
    let after = settled(&w.worker, &w.house).await?;
    assert!(after > before + DEPOSIT / 2, "the bounty came back to the house: {before} then {after}");
    // Thirteen hours on, it is still the slot that had its round: no other opens before the next slot.
    let r = w.open_round("race-0002").await?;
    assert!(r.is_failure() && why(&r).contains("this slot has its round"), "{}", why(&r));

    // ---- Day two, the next slot: yesterday's vault, retire, make, a squatted id, open, a win, settle, retire ----

    wait_until(&w.worker, w.slot(1)).await?;
    let n = w.house_now().await?;
    assert_eq!(
        (&n["may_open"], &n["vault_made"], &n["slot_ns"]),
        (&json!(false), &json!(false), &json!(w.slot(1).to_string())),
        "{n}"
    );
    // Yesterday's vault still stands, armed for race-0001. A leaked key's `open_round` at the slot's first second
    // would have had the bounty contract take the deposit, fail to arm the vault and give it back in `on_armed`,
    // and the slot would be gone for the day. It is refused before anything leaves the house.
    let lock = view(&w.worker, &w.vault, "get_round", json!({})).await?;
    assert_eq!(lock["bounty"], "race-0001", "yesterday's vault is armed for its round");
    w.refused_without_a_vault("race-0002").await?;
    w.retired().await?;
    // A vault made and retired at once (a vault that took no round goes at once) counts for nothing.
    w.made().await?;
    w.retired().await?;
    w.refused_without_a_vault("race-0002").await?;
    w.made().await?;

    // A stranger takes the id `race-0002` on the bounty contract first. The house's `open_safe` is refused, the
    // deposit comes back, and the slot is free again: the key opens the next id in the same slot.
    let masks: Vec<&AccountId> = w.masks.iter().map(|m| &m.id).collect();
    w.stranger
        .call(&w.bounty, "open")
        .args_json(
            json!({ "id": "race-0002", "target": "squat", "hours": 1, "judge_version": SANDBOX_JUDGE, "masks": masks }),
        )
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()
        .context("the stranger takes race-0002")?;
    let before = settled(&w.worker, &w.house).await?;
    let r = w.open_round("race-0002").await?;
    assert!(r.is_failure(), "the bounty contract refuses an id that is taken: {:?}", r.logs());
    assert!(r.logs().iter().any(|l| l.contains("the slot is free again")), "{:?}", r.logs());
    let after = settled(&w.worker, &w.house).await?;
    assert!(near_to(before - after, burnt(&r)), "the deposit came back: {before} then {after}");
    assert_eq!(w.house_day().await?, World::day(1, w.slot(0), w.slot(1)), "the slot is free, the vault still made");
    let round = w.opened("race-0003").await?;

    // ONYX seals first and never plays; NOVA seals the hole second, plays once ONYX's turn is missed, and claims.
    // The judge confirms, and NOVA waits: ONYX could still reveal until the reveal window ends. Then the key settles.
    let _ = seal(&w, "race-0003", 1, vec![json!({ "method": "set_owner", "args": { "new_owner": w.masks[1].id } })])
        .await?;
    let sealed = seal(&w, "race-0003", 0, the_hole(&w.masks[0].id, 2)).await?;
    wait_until(&w.worker, round["commit_until"].as_str().context("commit_until")?.parse()?).await?;
    let txs = play(&w, 0, &sealed).await?;
    let b = reveal_and_claim(&w, "race-0003", 0, &sealed, &txs).await?;
    assert_eq!(b["status"]["state"], "open", "NOVA is confirmed and waits for the earlier seal: {b}");
    let r = w.step(&w.key, "settle", json!({ "id": "race-0003" })).await?;
    assert!(r.is_failure(), "nobody settles while an earlier seal can still win: {}", why(&r));
    wait_until(&w.worker, round["reveal_until"].as_str().context("reveal_until")?.parse()?).await?;
    let nova = settled(&w.worker, &w.masks[0].id).await?;
    let r = w.step(&w.key, "settle", json!({ "id": "race-0003" })).await?;
    assert!(r.is_success(), "the key settles the round: {}", why(&r));
    let b = w.bounty_state("race-0003").await?;
    assert_eq!((&b["status"]["state"], &b["status"]["winner"]), (&json!("drained"), &json!(w.masks[0].id)), "{b}");
    assert!(settled(&w.worker, &w.masks[0].id).await? > nova + DEPOSIT / 2, "the bounty went to NOVA, not the house");

    wait_until(&w.worker, round["deadline_ns"].as_str().context("deadline")?.parse()?).await?;
    w.retired().await?;
    assert_eq!(w.house_day().await?, World::day(3, w.slot(1), 0));
    Ok(())
}

#[tokio::test]
async fn the_days_key_reaches_the_seven_steps_and_nothing_else() -> Result<()> {
    let w = world().await?;
    let start = settled(&w.worker, &w.house).await?;

    // No NEAR moves with the key, no key is added or deleted, no code is deployed: the node refuses the transaction.
    let tries = [
        w.key.transfer_near(w.stranger.id(), NearToken::from_near(1)).await.map(|r| r.is_success()),
        w.key
            .batch(&w.house)
            .add_key(SecretKey::from_random(KeyType::ED25519).public_key(), AccessKey::full_access())
            .transact()
            .await
            .map(|r| r.is_success()),
        w.key.batch(&w.house).delete_key(w.owner.secret_key().public_key()).transact().await.map(|r| r.is_success()),
        w.key.batch(&w.house).deploy(&w.safe_wasm).transact().await.map(|r| r.is_success()),
        w.key.batch(&w.house).delete_account(w.stranger.id()).transact().await.map(|r| r.is_success()),
    ];
    for (i, t) in tries.iter().enumerate() {
        assert!(!matches!(t, Ok(true)), "action #{i} went through with the day's key");
    }
    // Only the seven steps, and only on the house: not the terms, not the callbacks, not `new`, not another contract.
    for method in ["configure", "on_opened", "on_made", "new"] {
        let r = w.key.call(&w.house, method).args_json(json!({})).transact().await;
        assert!(!matches!(r, Ok(ref x) if x.is_success()), "{method} with the day's key");
        if let Ok(x) = r {
            assert!(why(&x).contains("MethodNameMismatch") || x.is_failure(), "{method}: {}", why(&x));
        }
    }
    // `unstick` reaches the bounty contract with arguments it reads: its own answer comes back, about the claim.
    let r = w.step(&w.key, "unstick", json!({ "id": "race-0001", "claim": "7" })).await?;
    assert!(r.is_failure() && why(&r).contains("no such claim with the judge"), "{}", why(&r));
    let r = w.key.call(&w.bounty, "settle").args_json(json!({ "id": "x" })).transact().await;
    assert!(!matches!(r, Ok(ref x) if x.is_success()), "the key reaches the house alone");
    let keys = w.worker.view_access_keys(&w.house).await?;
    assert_eq!(keys.len(), 2, "the owner's full key and the day's key, nothing added");
    let limited =
        keys.iter().filter(|k| matches!(k.access_key.permission, AccessKeyPermission::FunctionCall(_))).count();
    assert_eq!(limited, 1);

    // Nobody but the house's keys runs a step.
    for method in ["home", "retire", "settle", "refund", "open_round", "unstick", "on_opened", "on_made"] {
        let r =
            w.stranger.call(&w.house, method).args_json(json!({ "id": "race-0001", "claim": "0" })).transact().await?;
        assert!(r.is_failure() && why(&r).contains("only the house's own keys"), "{method}: {}", why(&r));
    }
    // The callbacks answer the house's own calls only, even to the owner's own key.
    let r = w.step(&w.owner, "on_opened", json!({ "last_round": 9, "last_slot_ns": "0", "made_slot_ns": "0" })).await?;
    assert!(r.is_failure() && why(&r).contains("on_opened is a callback only"), "{}", why(&r));
    let slot = w.slot(0).to_string();
    let r = w.step(&w.owner, "on_made", json!({ "slot_ns": slot, "before_ns": slot })).await?;
    assert!(r.is_failure() && why(&r).contains("on_made is a callback only"), "{}", why(&r));
    assert_eq!(w.house_day().await?, World::day(0, 0, 0));
    // `home` reaches the round's masks alone: not the house, the vault, the bounty contract or anyone else.
    for mask in [w.house.as_str(), w.vault.as_str(), w.bounty.as_str(), w.stranger.id().as_str()] {
        let r = w.step(&w.key, "home", json!({ "mask": mask })).await?;
        assert!(r.is_failure() && why(&r).contains("home: only one of the round's masks"), "{mask}: {}", why(&r));
    }

    // The terms change with the owner's full key and one yoctoNEAR, and with checked terms only. `new` runs once.
    let config = view(&w.worker, &w.house, "config", json!({})).await?;
    let mut changed = config.clone();
    changed["gas"] = json!((200 * MILLI).to_string());
    let r = w.owner.call(&w.house, "configure").args_json(&changed).transact().await?;
    assert!(r.is_failure() && why(&r).contains("attach exactly one yoctoNEAR"), "{}", why(&r));
    let mut bad = changed.clone();
    bad["vault"] = json!(w.stranger.id());
    let r =
        w.owner.call(&w.house, "configure").args_json(&bad).deposit(NearToken::from_yoctonear(1)).transact().await?;
    assert!(r.is_failure() && why(&r).contains("the vault is a direct sub-account of the house"), "{}", why(&r));
    let mut unknown = changed.clone();
    unknown["fee"] = json!("1");
    let r = w
        .owner
        .call(&w.house, "configure")
        .args_json(&unknown)
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?;
    assert!(r.is_failure() && why(&r).contains("a field the house does not know"), "{}", why(&r));
    // The key makes the vault; then the owner changes the terms. A vault made under the old terms takes no round under
    // the new ones (its masks, its code may differ, and it would not arm): the record of it goes with the old terms.
    w.made().await?;
    let configure = |args: Value| {
        let owner = w.owner.clone();
        let house = w.house.clone();
        async move { owner.call(&house, "configure").args_json(args).deposit(NearToken::from_yoctonear(1)).transact().await }
    };
    let mut with_round = changed.clone();
    with_round["last_round"] = json!(41);
    let r = configure(with_round).await?;
    assert!(r.is_success(), "the owner changes the terms: {}", why(&r));
    assert_eq!(view(&w.worker, &w.house, "config", json!({})).await?, changed);
    assert_eq!(w.house_now().await?["next_round"], "race-0042");
    assert_eq!(w.house_day().await?, World::day(41, 0, 0), "the vault made under the old terms counts no more");
    w.refused_without_a_vault("race-0042").await?;
    // The same terms again leave the vault made under them as it is; `last_slot_ns` says which slot had its round.
    w.retired().await?;
    w.made().await?;
    let mut with_slot = changed.clone();
    with_slot["last_slot_ns"] = json!(w.slot(0).to_string());
    let r = configure(with_slot).await?;
    assert!(r.is_success(), "{}", why(&r));
    assert_eq!(w.house_day().await?, World::day(41, w.slot(0), w.slot(0)));
    let n = w.house_now().await?;
    assert_eq!((&n["opened"], &n["vault_made"], &n["may_open"]), (&json!(true), &json!(true), &json!(false)), "{n}");
    let r = w.open_round("race-0042").await?;
    assert!(r.is_failure() && why(&r).contains("this slot has its round"), "{}", why(&r));
    let mut free_slot = changed.clone();
    free_slot["last_slot_ns"] = json!("0");
    assert!(configure(free_slot).await?.is_success());
    assert_eq!(w.house_now().await?["may_open"], true);
    w.retired().await?;
    let mut again = config.clone();
    again["last_round"] = json!(0);
    let r = w.owner.call(&w.house, "new").args_json(&again).transact().await?;
    assert!(r.is_failure() && why(&r).contains("the house is set up already"), "{}", why(&r));
    assert_eq!(view(&w.worker, &w.house, "version", json!({})).await?, json!("1.2.0"));
    let meta = view(&w.worker, &w.house, "contract_source_metadata", json!({})).await?;
    assert_eq!((&meta["version"], &meta["standards"][0]["standard"]), (&json!("1.2.0"), &json!("nep330")), "{meta}");
    assert!(meta["link"].as_str().is_some_and(|l| l.starts_with("https://github.com/plavutskyi/mask-wars")), "{meta}");

    // A slot whose window has passed with no round in it opens none: a round opened now would run into the next.
    wait_until(&w.worker, w.slot(0) + 21 * MINUTE_NS).await?;
    let n = w.house_now().await?;
    assert_eq!((&n["opened"], &n["may_open"]), (&json!(false), &json!(false)), "{n}");
    let r = w.open_round("race-0042").await?;
    assert!(r.is_failure() && why(&r).contains("too late in the slot"), "{}", why(&r));

    // All that cost the house only gas: some forty calls, two vaults made and retired among them.
    let end = settled(&w.worker, &w.house).await?;
    assert!(start - end < 4 * DUST, "nothing left the house but gas: {start} then {end}");
    Ok(())
}

/// The day's step 0 through the house contract: `home` on a mask that runs contracts/home brings everything above
/// what the mask keeps to the house, and nowhere else. Here the house has its real name, the one written into the
/// mainnet build of `home`.
#[tokio::test]
async fn the_key_brings_the_masks_winnings_home() -> Result<()> {
    let w = world_at(Some(REAL_HOUSE)).await?;
    let home_wasm = std::fs::read(home_wasm_path("mainnet")).context("read the home wasm")?;
    let (nova, onyx) = (&w.masks[0], &w.masks[1]);
    nova.account.deploy(&home_wasm).await?.into_result().context("deploy home on NOVA")?;
    let keep = |storage: u64| 4 * ONE_NEAR / 10 + BYTE_COST * u128::from(storage);

    // NOVA won: it holds its 10 NEAR, less the stake of its code. The key's `home` sends the rest to the house.
    w.worker.fast_forward(5).await?;
    let held = balance(&w.worker, &nova.id).await?;
    let kept = keep(w.worker.view_account(&nova.id).await?.storage_usage);
    let before = balance(&w.worker, &w.house).await?;
    let r = w.step(&w.key, "home", json!({ "mask": nova.id })).await?;
    assert!(r.is_success(), "the key brings NOVA's winnings home: {}", why(&r));
    let event = r.logs().iter().find_map(|l| l.strip_prefix("EVENT_JSON:")).map(str::to_string).context("event")?;
    let event: Value = serde_json::from_str(&event)?;
    assert_eq!(event["data"]["to"], REAL_HOUSE, "{event}");
    assert_eq!(event["data"]["amount"], (held - kept).to_string(), "everything above what NOVA keeps: {event}");
    // Only the house and NOVA ran anything, and NOVA's call had exactly the gas the house gives it.
    for o in r.receipt_outcomes() {
        assert!([&w.house, &nova.id].contains(&&o.executor_id), "{} ran a receipt", o.executor_id);
        if o.executor_id == nova.id {
            assert!(o.gas_burnt.as_gas() < 10 * 1_000_000_000_000, "home() within its 10 TGas: {:?}", o.gas_burnt);
        }
    }
    let after = settled(&w.worker, &w.house).await?;
    assert!(near_to(after + burnt(&r), before + held - kept), "the house got NOVA's winnings: {before} then {after}");
    let left = settled(&w.worker, &nova.id).await?;
    assert!((kept..kept + MILLI).contains(&left), "NOVA keeps {kept} and its gas share: {left}");

    // Nothing more above what NOVA keeps: nothing goes. ONYX runs no code: its call fails and nothing moves.
    let r = w.step(&w.key, "home", json!({ "mask": nova.id })).await?;
    assert!(r.is_success() && r.logs().iter().any(|l| l.starts_with("home: nothing above")), "{:?}", r.logs());
    let onyx_held = balance(&w.worker, &onyx.id).await?;
    let r = w.step(&w.key, "home", json!({ "mask": onyx.id })).await?;
    assert!(r.is_failure(), "ONYX runs no home: {}", why(&r));
    assert_eq!(settled(&w.worker, &onyx.id).await?, onyx_held, "ONYX's NEAR stays where it is");
    Ok(())
}
