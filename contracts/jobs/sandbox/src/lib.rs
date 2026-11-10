//! Jobs and crews in a real local NEAR sandbox. Both contracts are the real code, deployed the way testnet gets them:
//! created, funded, deployed and initialized in one transaction that adds no key. Every mask signs only with a narrow
//! function-call key on the contract it calls, as the keeper gives it one for a job, and takes a job with a bond its
//! owner locked for it. The stand-ins (`../stub`) are OutLayer, whose answer the test hands back as the judge module
//! would; a bounty contract's round; and a mask factory that says who owns a mask.
//!
//! On a `tee_tests` or `ai_review` job a revealed step is a box sealed for the judge's key. Here the stand-in judge
//! opens nothing, so `boxed` makes boxes of the right form; `services/judge-tests/sandbox` seals real ones.

use anyhow::{bail, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::{Function, TransactionStatus};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::task::Poll;
use std::time::Duration;

pub const ONE_NEAR: u128 = 10u128.pow(24);
pub const MILLI: u128 = ONE_NEAR / 1000;
/// The judge wasm the contract serves `ai_review` with, and the one `tee_tests` with.
pub const REVIEW_V: &str = "5048c29063c3c1f3b5ac86e66f8153eb0f28083b671fe33967a29e8512b808b0";
pub const TESTS_V: &str = "018b7143aa00000000000000000000000000000000000000000000000000c200";
/// The judges' TEE keys: the public halves of the sandbox judges' seeds (`5eed…` for tests, `be5e…` for reviews, in
/// `services/judge-tests/sandbox` and `services/judge-review/sandbox`), which masks seal their work for.
pub const TESTS_KEY: &str = "x25519:6c8fed6f2acd4093f45f4921108f6234ab86cf6b1b4ef2c1c8668b8ba1f53864";
pub const REVIEW_KEY: &str = "x25519:7c8a393f8708112b7cd720c8f66296a659ccb3a5c7594692a5599a76dd47514d";
/// The client's X25519 key: the public half of `[0xc1; 32]`. The judge seals the winning work for it.
pub const CLIENT_KEY: &str = "x25519:42575d5c8a93833255e09f04054a4f6246d36ed163c1c7f80c1fc9a58a0e912d";
pub const CLIENT_SECRET: [u8; 32] = [0xc1; 32];
/// What the masks may do on a job with their key, and on a crew.
pub const JOB_METHODS: [&str; 4] = ["enlist", "step", "reveal", "leave"];
pub const CREW_METHODS: [&str; 2] = ["join", "leave"];
pub const MIN_NS: u64 = 60_000_000_000;

pub struct Wasm {
    pub jobs: Vec<u8>,
    pub crews: Vec<u8>,
    pub stub: Vec<u8>,
}

pub fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Builds the jobs and crews contracts and the stand-ins for wasm, into their own target dir so it never contends
/// with the outer `cargo` lock.
pub fn build() -> Result<Wasm> {
    let root = workspace_root();
    let target = root.join("target").join("sandbox-wasm");
    let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .current_dir(&root)
        .env("RUSTFLAGS", "--cfg near -C link-arg=-s")
        .env("CARGO_TARGET_DIR", &target)
        .args(["build", "--release", "--target", "wasm32-unknown-unknown"])
        .args(["-p", "maskwars-jobs", "-p", "maskwars-crews", "-p", "jobs-stub"])
        .status()
        .context("run cargo build")?;
    if !status.success() {
        bail!("wasm build failed");
    }
    let dir = target.join("wasm32-unknown-unknown").join("release");
    let read = |f: &str| std::fs::read(dir.join(f)).with_context(|| format!("read {f}"));
    Ok(Wasm { jobs: read("maskwars_jobs.wasm")?, crews: read("maskwars_crews.wasm")?, stub: read("jobs_stub.wasm")? })
}

pub fn near(yocto: u128) -> NearToken {
    NearToken::from_yoctonear(yocto)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The seal of a step, as a mask computes it: sha256 of `maskwars-step:<job>:<mask>:<salt>:<content>`.
pub fn step_hash(job: &str, mask: &AccountId, salt: &str, content: &str) -> String {
    sha256_hex(format!("maskwars-step:{job}:{mask}:{salt}:{content}").as_bytes())
}

pub fn salt_of(mask: &AccountId) -> String {
    format!("salt-{}", mask.as_str().replace('.', "-"))
}

/// A box of the form a `tee_tests` or `ai_review` step takes, `mw1.` and 934 base64url characters, made from `text`
/// for a stand-in judge that opens nothing: the same text, the same box.
pub fn boxed(text: &str) -> String {
    const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let seed = Sha256::digest(text.as_bytes());
    let body: String = (0..934).map(|i| B64[(seed[i % 32] as usize + i) % 64] as char).collect();
    format!("mw1.{body}")
}

/// Why a transaction failed, short.
pub fn why(res: &ExecutionFinalResult) -> String {
    format!("{:?}", res.failures())
}

/// A mask: its account, and the narrow keys it signs with.
pub struct Mask {
    pub id: AccountId,
    /// Signs with a function-call key on the jobs contract: `enlist`, `step`, `reveal`, `leave`.
    pub on_jobs: Account,
    /// Signs with a function-call key on the crews contract: `join`, `leave`.
    pub on_crews: Account,
}

pub struct World {
    pub worker: Worker<Sandbox>,
    pub admin: Account,
    pub client: Account,
    /// The person who owns KIRA.
    pub ann: Account,
    pub bob: Account,
    pub meter: Account,
    pub treasury: Account,
    pub company: Account,
    pub outlayer: Account,
    pub bounty: Account,
    pub factory: Account,
    pub jobs: AccountId,
    pub crews: AccountId,
    /// KIRA, a person's mask forged by the factory; NOVA, the arena's own; ONYX, a rival; FARM, a fuel farmer.
    pub kira: Mask,
    pub nova: Mask,
    pub onyx: Mask,
    pub farm: Mask,
}

impl World {
    pub async fn new(wasm: &Wasm) -> Result<Self> {
        let worker = near_workspaces::sandbox().await.context("start sandbox")?;
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
        let admin = sub("admin", 10).await?;
        let client = sub("dao", 50).await?;
        let ann = sub("ann", 10).await?;
        let bob = sub("bob", 10).await?;
        let meter = sub("keeper", 10).await?;
        let treasury = sub("treasury", 1).await?;
        let company = sub("company", 1).await?;
        let outlayer = sub("outlayer", 10).await?;
        let bounty = sub("bounty", 10).await?;
        let factory = sub("masks", 10).await?;
        for stub in [&outlayer, &bounty, &factory] {
            stub.deploy(&wasm.stub).await?.into_result()?;
            stub.call(stub.id(), "new").transact().await?.into_result()?;
        }

        let jobs: AccountId = format!("jobs.{}", root.id()).parse()?;
        let crews: AccountId = format!("crews.{}", root.id()).parse()?;
        let new_jobs = json!({
            "admin": admin.id(), "meter": meter.id(), "treasury": treasury.id(), "outlayer": outlayer.id(),
            "crews": crews, "bounties": [bounty.id()], "factories": [factory.id()], "fee_bps": 500,
            "fee_to": company.id(),
            "judges": [
                { "kind": "ai_review", "project": "maskwars.testnet/review", "version": REVIEW_V, "key": REVIEW_KEY },
                { "kind": "tee_tests", "project": "maskwars.testnet/tests", "version": TESTS_V, "key": TESTS_KEY },
            ],
        });
        // One transaction each that adds no key: nobody can sign for either contract.
        root.batch(&jobs)
            .create_account()
            .transfer(NearToken::from_near(10))
            .deploy(&wasm.jobs)
            .call(Function::new("new").args_json(new_jobs).gas(Gas::from_tgas(100)))
            .transact()
            .await?
            .into_result()
            .context("deploy the jobs contract")?;
        root.batch(&crews)
            .create_account()
            .transfer(NearToken::from_near(5))
            .deploy(&wasm.crews)
            .call(
                Function::new("new")
                    .args_json(json!({ "admin": admin.id(), "factories": [factory.id()] }))
                    .gas(Gas::from_tgas(100)),
            )
            .transact()
            .await?
            .into_result()
            .context("deploy the crews contract")?;

        // KIRA lives under the factory, as every forged mask does; ANN owns it.
        let kira = factory
            .create_subaccount("kira")
            .initial_balance(NearToken::from_near(2))
            .transact()
            .await?
            .into_result()
            .context("create kira")?;
        factory
            .call(factory.id(), "set_mask")
            .args_json(json!({ "name": "kira", "owner": ann.id() }))
            .transact()
            .await?
            .into_result()?;
        let nova = sub("nova", 2).await?;
        let onyx = sub("onyx", 2).await?;
        let farm = sub("farm", 2).await?;
        let mut masks = vec![];
        for account in [kira, nova, onyx, farm] {
            masks.push(Self::narrow(&worker, &account, &jobs, &crews).await?);
        }
        let farm = masks.pop().unwrap();
        let onyx = masks.pop().unwrap();
        let nova = masks.pop().unwrap();
        let kira = masks.pop().unwrap();
        Ok(Self {
            worker,
            admin,
            client,
            ann,
            bob,
            meter,
            treasury,
            company,
            outlayer,
            bounty,
            factory,
            jobs,
            crews,
            kira,
            nova,
            onyx,
            farm,
        })
    }

    /// Gives a mask its two narrow keys, as the keeper does for a job: function-call keys that cannot attach NEAR.
    async fn narrow(worker: &Worker<Sandbox>, account: &Account, jobs: &AccountId, crews: &AccountId) -> Result<Mask> {
        let on_jobs = SecretKey::from_random(KeyType::ED25519);
        let on_crews = SecretKey::from_random(KeyType::ED25519);
        account
            .batch(account.id())
            .add_key(
                on_jobs.public_key(),
                AccessKey::function_call_access(jobs, &JOB_METHODS, Some(NearToken::from_millinear(250))),
            )
            .add_key(
                on_crews.public_key(),
                AccessKey::function_call_access(crews, &CREW_METHODS, Some(NearToken::from_millinear(50))),
            )
            .transact()
            .await?
            .into_result()
            .with_context(|| format!("give {} its keys", account.id()))?;
        Ok(Mask {
            id: account.id().clone(),
            on_jobs: Account::from_secret_key(account.id().clone(), on_jobs, worker),
            on_crews: Account::from_secret_key(account.id().clone(), on_crews, worker),
        })
    }

    pub async fn view(&self, contract: &AccountId, method: &str, args: Value) -> Result<Value> {
        Ok(self.worker.view(contract, method).args_json(args).await?.json()?)
    }

    pub async fn job(&self, id: &str) -> Result<Value> {
        self.view(&self.jobs, "get", json!({ "id": id })).await
    }

    pub async fn balance(&self, id: &AccountId) -> Result<u128> {
        Ok(self.worker.view_account(id).await?.balance.as_yoctonear())
    }

    pub async fn now(&self) -> Result<u64> {
        Ok(self.worker.view_block().await?.timestamp())
    }

    /// Lets sandbox time pass until `at`, ns. Long waits (the hours until `judge_until`) jump most of the way at
    /// the pace the sandbox shows, then close in a hundred blocks at a time.
    pub async fn wait_until(&self, at: u64) -> Result<()> {
        loop {
            let now = self.now().await?;
            if now >= at {
                return Ok(());
            }
            let before = self.worker.view_block().await?.height();
            self.worker.fast_forward(100).await?;
            let (after, later) = (self.worker.view_block().await?.height(), self.now().await?);
            let per_block = (later - now) / (after - before).max(1);
            let left = at.saturating_sub(later);
            if per_block > 0 && left > 600 * per_block {
                // Nine tenths of what is left, so no window is overshot.
                self.worker.fast_forward(left / per_block * 9 / 10).await?;
            }
        }
    }

    /// The client opens a job with exactly what `quote` says it takes.
    #[allow(clippy::too_many_arguments)]
    pub async fn open(
        &self,
        id: &str,
        kind: &str,
        reward: u128,
        fuel: u128,
        slots: u8,
        judge_version: Option<&str>,
        round: Option<Value>,
    ) -> Result<ExecutionFinalResult> {
        let quote = self
            .view(
                &self.jobs,
                "quote",
                json!({ "reward": reward.to_string(), "fuel_per_mask": fuel.to_string(), "slots": slots }),
            )
            .await?;
        let total: u128 = quote["total"].as_str().context("quote")?.parse()?;
        let rubric = (kind != "drain").then(|| sha256_hex(b"Score 0-10: does the review find the quorum bug?"));
        let bar = (kind != "drain").then(|| json!({ "win_at": 60, "reference": boxed("the client's own review") }));
        let client_key = (kind != "drain").then_some(CLIENT_KEY);
        Ok(self
            .client
            .call(&self.jobs, "open")
            .args_json(json!({
                "id": id, "kind": kind, "brief": "Review the treasury proposal against the published rubric",
                "spec": sha256_hex(b"spec: the treasury proposal #42"), "rubric": rubric,
                "judge_version": judge_version, "round": round, "secrets": null, "bar": bar,
                "reward": reward.to_string(), "fuel_per_mask": fuel.to_string(), "slots": slots,
                "open_to": { "who": "anyone" }, "work_minutes": 5, "reveal_minutes": 5, "appeal_minutes": 10,
                "client_key": client_key,
            }))
            .deposit(near(total))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// `by` locks the job's bond for `mask`, with room for its record; what the record does not take comes back.
    pub async fn bond(&self, by: &Account, job: &str, mask: &AccountId) -> Result<ExecutionFinalResult> {
        let bond: u128 = self.job(job).await?["terms"]["bond"].as_str().context("bond")?.parse()?;
        Ok(by
            .call(&self.jobs, "bond")
            .args_json(json!({ "id": job, "mask": mask }))
            .deposit(near(bond + 10 * MILLI))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?)
    }

    /// The owner of a mask locks its bond (ANN for KIRA, the root for the arena's own masks), then the mask takes the
    /// job alone with its narrow key. Returns its entrant number.
    pub async fn enlist(&self, mask: &Mask, job: &str) -> Result<u32> {
        self.bond(&self.owner_of(mask)?, job, &mask.id)
            .await?
            .into_result()
            .with_context(|| format!("bond {}", mask.id))?;
        let r = mask.on_jobs.call(&self.jobs, "enlist").args_json(json!({ "id": job })).transact().await?;
        let failed = why(&r);
        r.json::<u32>().with_context(|| format!("{} enlists: {failed}", mask.id))
    }

    /// Every member's owner locks its bond on `job`, as a crew's members do before the captain enlists it.
    pub async fn bond_all(&self, job: &str, masks: &[&Mask]) -> Result<()> {
        for m in masks {
            self.bond(&self.owner_of(m)?, job, &m.id).await?.into_result().with_context(|| format!("bond {}", m.id))?;
        }
        Ok(())
    }

    /// Who locks a mask's bond here: ANN owns KIRA; the arena's root holds the rest.
    pub fn owner_of(&self, mask: &Mask) -> Result<Account> {
        Ok(if mask.id == self.kira.id { self.ann.clone() } else { self.worker.root_account()? })
    }

    /// A mask seals a step with its job key; returns the step's number.
    pub async fn seal(&self, mask: &Mask, job: &str, content: &str) -> Result<u32> {
        let hash = step_hash(job, &mask.id, &salt_of(&mask.id), content);
        let res = mask
            .on_jobs
            .call(&self.jobs, "step")
            .args_json(json!({ "id": job, "hash": hash }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?;
        let step: Value =
            res.clone().into_result().with_context(|| format!("{} seals: {}", mask.id, why(&res)))?.json()?;
        Ok(step["seq"].as_u64().context("seq")? as u32)
    }

    pub async fn reveal(&self, mask: &Mask, job: &str, seq: u32, content: &str) -> Result<ExecutionFinalResult> {
        Ok(mask
            .on_jobs
            .call(&self.jobs, "reveal")
            .args_json(json!({ "id": job, "seq": seq, "salt": salt_of(&mask.id), "content": content }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?)
    }

    pub async fn burn(&self, by: &Account, job: &str, mask: &AccountId, amount: u128) -> Result<ExecutionFinalResult> {
        Ok(by
            .call(&self.jobs, "burn")
            .args_json(json!({ "id": job, "mask": mask, "amount": amount.to_string() }))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?)
    }

    /// Anyone asks the judge. Returns the pending transaction once its question reached OutLayer, with the request's
    /// index and input; `Err` with the reason when the contract refused before asking.
    pub async fn ask_judge(&self, by: &Account, job: &str) -> Result<(TransactionStatus, u32, Value)> {
        self.ask(by, "judge", job).await
    }

    /// Anyone asks the job's judge to check the client's material, as `ask_judge` does for a verdict.
    pub async fn ask_check(&self, by: &Account, job: &str) -> Result<(TransactionStatus, u32, Value)> {
        self.ask(by, "check", job).await
    }

    /// The judge checks the job's material and passes it: the work window starts. Returns the job.
    pub async fn pass_check(&self, job: &str) -> Result<Value> {
        let (pending, index, request) = self.ask_check(&self.bob, job).await?;
        let input: Value = serde_json::from_str(request["input"].as_str().context("input")?)?;
        if input["check"] != json!(true) {
            bail!("the judge was not asked to check: {input}");
        }
        let passed = json!({ "success": true, "output": { "job": job, "checked": true }, "error": null }).to_string();
        let r = self.answer(pending, index, &passed).await?;
        if !r.is_success() {
            bail!("the check's callback: {}", why(&r));
        }
        let v = self.job(job).await?;
        if v["checked"] != json!(true) {
            bail!("the job was not checked: {v}");
        }
        Ok(v)
    }

    async fn ask(&self, by: &Account, method: &str, job: &str) -> Result<(TransactionStatus, u32, Value)> {
        let asked = self.view(self.outlayer.id(), "requests", json!({})).await?.as_array().map_or(0, Vec::len);
        let pending = by
            .call(&self.jobs, method)
            .args_json(json!({ "id": job }))
            .gas(Gas::from_tgas(250))
            .transact_async()
            .await?;
        for _ in 0..300 {
            if let Poll::Ready(r) = pending.status().await? {
                bail!("the contract did not ask the judge: {}", why(&r));
            }
            let requests = self.view(self.outlayer.id(), "requests", json!({})).await?;
            if let Some(r) = requests.as_array().and_then(|r| r.get(asked)) {
                return Ok((pending, asked as u32, r.clone()));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        bail!("the question never reached OutLayer")
    }

    /// OutLayer hands request `index` the judge module's stdout, and the job's callback runs.
    pub async fn answer(&self, pending: TransactionStatus, index: u32, stdout: &str) -> Result<ExecutionFinalResult> {
        self.bob
            .call(self.outlayer.id(), "answer")
            .args_json(json!({ "index": index, "output": stdout }))
            .gas(Gas::from_tgas(50))
            .transact()
            .await?
            .into_result()
            .context("answer the judge's request")?;
        for _ in 0..300 {
            if let Poll::Ready(r) = pending.status().await? {
                return Ok(r);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        bail!("the judge's answer never came back")
    }

    /// `by` asks the judge of a paid job to seal the winning work for the client's key, paying the run. Returns the
    /// pending transaction once OutLayer has the question, with the request's index and input.
    pub async fn ask_delivery(&self, by: &Account, job: &str) -> Result<(TransactionStatus, u32, Value)> {
        let asked = self.view(self.outlayer.id(), "requests", json!({})).await?.as_array().map_or(0, Vec::len);
        let pending = by
            .call(&self.jobs, "deliver")
            .args_json(json!({ "id": job }))
            .deposit(near(10 * MILLI))
            .gas(Gas::from_tgas(250))
            .transact_async()
            .await?;
        for _ in 0..300 {
            if let Poll::Ready(r) = pending.status().await? {
                bail!("the contract did not ask for a delivery: {}", why(&r));
            }
            let requests = self.view(self.outlayer.id(), "requests", json!({})).await?;
            if let Some(r) = requests.as_array().and_then(|r| r.get(asked)) {
                return Ok((pending, asked as u32, r.clone()));
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        bail!("the delivery never reached OutLayer")
    }

    pub async fn settle(&self, by: &Account, job: &str) -> Result<ExecutionFinalResult> {
        Ok(by.call(&self.jobs, "settle").args_json(json!({ "id": job })).gas(Gas::from_tgas(250)).transact().await?)
    }

    /// Every access key on an account.
    pub async fn keys(&self, id: &AccountId) -> Result<usize> {
        Ok(self.worker.view_access_keys(id).await?.len())
    }
}

/// The `settle` event a transaction logged: who got what when the job ended.
pub fn settle_event(res: &ExecutionFinalResult) -> Value {
    res.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .find(|e| e["event"] == "settle")
        .map(|e| e["data"].clone())
        .unwrap_or(Value::Null)
}

/// What a job's end paid its masks and the company, from its `settle` event: under the main rule, all of the reward.
pub fn paid_out(event: &Value) -> u128 {
    let payouts: u128 = event["payouts"].as_array().map_or(0, |p| p.iter().map(|x| yocto(&x["amount"])).sum());
    payouts + yocto(&event["fee"])
}

/// The judge module's stdout for a verdict.
pub fn verdict(job: &str, winner: Option<u32>, counted: &[u32]) -> String {
    json!({ "success": true, "output": { "job": job, "winner": winner, "counted": counted }, "error": null })
        .to_string()
}

/// The judge module's stdout for a verdict that calls some steps fake.
pub fn verdict_with_fakes(job: &str, winner: Option<u32>, counted: &[u32], fake: &[u32]) -> String {
    json!({ "success": true, "output": { "job": job, "winner": winner, "counted": counted, "fake": fake }, "error": null })
        .to_string()
}

/// Where each bond went, from a `settle` event: `(mask, bond, lost to the company)`. A fake mask loses all of it, a
/// seat with no revealed step half.
pub fn bonds_of(event: &Value) -> Vec<(String, u128, u128)> {
    event["bonds"]
        .as_array()
        .map(|b| {
            b.iter()
                .map(|x| (x["mask"].as_str().unwrap_or_default().to_string(), yocto(&x["bond"]), yocto(&x["lost"])))
                .collect()
        })
        .unwrap_or_default()
}

/// The `leave` event of a call: `(back to whoever locked the bond, lost to the company)`.
pub fn left_of(res: &ExecutionFinalResult) -> Option<(u128, u128)> {
    res.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .find(|e| e["event"] == "leave")
        .map(|e| (yocto(&e["data"]["back"]), yocto(&e["data"]["lost"])))
}

pub fn yocto(v: &Value) -> u128 {
    v.as_str().and_then(|s| s.parse().ok()).unwrap_or_else(|| panic!("not a yocto amount: {v}"))
}

/// NEAR with three decimals, for the log.
pub fn n3(yocto: u128) -> String {
    format!("{}.{:03}", yocto / ONE_NEAR, (yocto % ONE_NEAR) / MILLI)
}
