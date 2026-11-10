//! A NEAR sandbox that stays up, with the real jobs and crews contracts deployed as testnet gets them (one transaction
//! each that adds no key) and a job in every phase a job goes through. The jobs reader records its fixtures against
//! it, the site's screenshots read it, and an outside agent takes a job in it over MCP.
//!
//!   cargo run --release -- <world.json>
//!
//! It deploys through the jobs contracts' own sandbox harness (`contracts/jobs/sandbox`): the same stand-ins for
//! OutLayer, a bounty contract's round and a mask factory, the same narrow keys for the masks, and the same judge keys:
//! the public halves of the judges' sandbox seeds. Every mask's work is a real box sealed for its judge's key with the
//! judges' own code (`services/judge-tests/src/sealed.rs`), so nothing of it is readable on chain. This program is the
//! stand-in judge: it answers in the judge modules' format and, once a job is paid, opens the winner's boxes with the
//! judge's sandbox seed and seals the work again for the client's key, into the judge project's public storage (a
//! folder next to `world.json` that the indexer stand-in serves). `world.json` gets the RPC address, the contracts,
//! every actor's sandbox key and the judges' sandbox seeds (throwaway secrets of a local chain), then the program waits
//! until it is stopped.

use anyhow::{ensure, Context, Result};
use jobs_sandbox::*;
use maskwars_judge_tests::sealed;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The judges' TEE seeds in the sandbox (`services/judge-tests/sandbox`, `services/judge-review/sandbox`). On OutLayer
/// each is generated inside the TEE and nobody sees it.
const TESTS_SEED: &str = "5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed";
const REVIEW_SEED: &str = "be5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5ebe5e";
const REVIEW_INFO: &[u8] = b"maskwars:judge-review:x25519:v1";
const REVIEW_PROJECT: &str = "maskwars.testnet/review";
const TESTS_PROJECT: &str = "maskwars.testnet/tests";
/// A Wasm module's header: the smallest module a `tee_tests` box carries in this world.
const MODULE: &[u8] = b"\0asm\x01\0\0\0";

/// A mask of the world: its account and its two narrow keys, as the keeper gives them, and who locks its bonds.
struct M {
    name: &'static str,
    id: AccountId,
    on_jobs: Account,
    on_crews: Account,
    owner: Account,
}

fn seed(text: &str) -> [u8; 32] {
    maskwars_judge_tests::job::unhex(text).unwrap().try_into().unwrap()
}

fn judge_secret(kind: &str) -> sealed::JudgeSecret {
    match kind {
        "tee_tests" => sealed::judge_secret(&seed(TESTS_SEED)),
        _ => sealed::judge_secret_for(&seed(REVIEW_SEED), REVIEW_INFO),
    }
}

fn project(kind: &str) -> &'static str {
    if kind == "tee_tests" {
        TESTS_PROJECT
    } else {
        REVIEW_PROJECT
    }
}

/// Fresh-looking bytes for a box's ephemeral key and nonce, the same on every run of the world.
fn bytes_of<const N: usize>(label: &str) -> [u8; N] {
    let h = maskwars_judge_tests::job::unhex(&sha256_hex(label.as_bytes())).unwrap();
    let mut out = [0u8; N];
    for (i, b) in out.iter_mut().enumerate() {
        *b = h[i % 32] ^ (i as u8);
    }
    out
}

/// A mask's work sealed for its judge's key, for this contract, this job and this mask: text, or for a `tee_tests`
/// striker a module. What an agent does on its own machine before it seals the step.
fn boxed_for(w: &World, kind: &str, job: &str, mask: &AccountId, work: &str) -> Result<String> {
    let key = sealed::JudgePublic::from(&judge_secret(kind));
    let label = format!("{job}:{mask}:{work}");
    let (eph, nonce) = (bytes_of::<32>(&format!("eph:{label}")), bytes_of::<12>(&format!("nonce:{label}")));
    let contract = w.jobs.as_str();
    let out = if work == "module" {
        sealed::seal(&key, contract, job, mask.as_str(), MODULE, eph, nonce)
    } else {
        sealed::seal_text(&key, contract, job, mask.as_str(), work, eph, nonce)
    };
    out.map_err(|e| anyhow::anyhow!("seal {job} for {mask}: {e}"))
}

/// A mask forged by the world's factory (`<name>.masks.test.near`), owned by `owner`, with its narrow keys.
async fn forged(w: &World, name: &'static str, owner: &Account) -> Result<M> {
    let account = w
        .factory
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(2))
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("forge {name}"))?;
    w.factory
        .call(w.factory.id(), "set_mask")
        .args_json(json!({ "name": name, "owner": owner.id() }))
        .transact()
        .await?
        .into_result()?;
    narrow(w, name, &account, owner).await
}

/// A mask on its own account (`<name>.test.near`), with its narrow keys; the arena's root locks its bonds.
async fn plain(w: &World, name: &'static str) -> Result<M> {
    let root = w.worker.root_account()?;
    let account = root
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(2))
        .transact()
        .await?
        .into_result()
        .with_context(|| format!("create {name}"))?;
    narrow(w, name, &account, &root).await
}

async fn narrow(w: &World, name: &'static str, account: &Account, owner: &Account) -> Result<M> {
    let on_jobs = SecretKey::from_random(KeyType::ED25519);
    let on_crews = SecretKey::from_random(KeyType::ED25519);
    account
        .batch(account.id())
        .add_key(
            on_jobs.public_key(),
            AccessKey::function_call_access(&w.jobs, &JOB_METHODS, Some(NearToken::from_millinear(250))),
        )
        .add_key(
            on_crews.public_key(),
            AccessKey::function_call_access(&w.crews, &CREW_METHODS, Some(NearToken::from_millinear(50))),
        )
        .transact()
        .await?
        .into_result()?;
    Ok(M {
        name,
        id: account.id().clone(),
        on_jobs: Account::from_secret_key(account.id().clone(), on_jobs, &w.worker),
        on_crews: Account::from_secret_key(account.id().clone(), on_crews, &w.worker),
        owner: owner.clone(),
    })
}

struct Open<'a> {
    id: &'a str,
    kind: &'a str,
    brief: &'a str,
    spec: &'a str,
    rubric: Option<&'a str>,
    round: Option<&'a str>,
    reward: u128,
    fuel: u128,
    bond: Option<u128>,
    slots: u8,
    work: u32,
    reveal: u32,
    appeal: u32,
}

/// The client opens a job with exactly what `quote` says it takes. A private job names the judge's version, the bar
/// with the client's own reference work sealed for the judge, and the client's key the winning work is sealed for.
async fn open(w: &World, o: Open<'_>) -> Result<Value> {
    let quote = w
        .view(
            &w.jobs,
            "quote",
            json!({ "reward": o.reward.to_string(), "fuel_per_mask": o.fuel.to_string(), "slots": o.slots }),
        )
        .await?;
    let total: u128 = quote["total"].as_str().context("quote")?.parse()?;
    let (judge, bar, secrets, client_key) = match o.kind {
        "ai_review" => {
            let reference = boxed_for(w, o.kind, o.id, w.client.id(), "reference review: the quorum bug, proven, with a fix")?;
            (Some(REVIEW_V), Some(json!({ "win_at": 60, "reference": reference })), None, Some(CLIENT_KEY))
        }
        "tee_tests" => {
            let reference = boxed_for(w, o.kind, o.id, w.client.id(), "module")?;
            let bar = json!({ "win_at": 10, "cases": 12, "fuel": "1000000", "reference": reference });
            let secrets = json!({ "profile": "vault-tests", "account_id": w.client.id() });
            (Some(TESTS_V), Some(bar), Some(secrets), Some(CLIENT_KEY))
        }
        _ => (None, None, None, None),
    };
    let round = o.round.map(|r| json!({ "bounty": w.bounty.id(), "id": r }));
    let r = w
        .client
        .call(&w.jobs, "open")
        .args_json(json!({
            "id": o.id, "kind": o.kind, "brief": o.brief, "spec": sha256_hex(o.spec.as_bytes()),
            "rubric": o.rubric.map(|r| sha256_hex(r.as_bytes())), "judge_version": judge, "round": round,
            "secrets": secrets, "bar": bar, "reward": o.reward.to_string(), "fuel_per_mask": o.fuel.to_string(),
            "slots": o.slots, "open_to": { "who": "anyone" }, "work_minutes": o.work, "reveal_minutes": o.reveal,
            "appeal_minutes": o.appeal, "bond": o.bond.map(|b| b.to_string()), "client_key": client_key,
        }))
        .deposit(near(total))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    ensure!(r.is_success(), "open {}: {}", o.id, why(&r));
    println!("{} opened: {} · reward {} NEAR, fuel {} × {}", o.id, o.kind, n3(o.reward), n3(o.fuel), o.slots);
    w.job(o.id).await
}

/// The judge passes the client's material: the job's windows start now.
async fn checked(w: &World, job: &str) -> Result<Value> {
    let v = w.pass_check(job).await?;
    println!("{job}: the judge checked the client's material: masks may start");
    Ok(v)
}

/// `captain` forms crew `id` and every seat joins: a forged mask by its owner's word (`join_for`), any other with its
/// own key.
async fn crew(w: &World, captain: &Account, id: &str, seats: &[(&M, &str, bool)], split: Value) -> Result<()> {
    let members: Vec<Value> = seats.iter().map(|(m, role, _)| json!({ "mask": m.id, "role": role })).collect();
    let r = crews_call(w, captain, "form", json!({ "id": id, "members": members, "split": split }), 100).await?;
    ensure!(r.is_success(), "form {id}: {}", why(&r));
    for (m, _, by_owner) in seats {
        let r = if *by_owner {
            crews_call(w, &m.owner, "join_for", json!({ "id": id, "version": 1, "mask": m.id }), 0).await?
        } else {
            m.on_crews.call(&w.crews, "join").args_json(json!({ "id": id, "version": 1 })).transact().await?
        };
        ensure!(r.is_success(), "{} joins {id}: {}", m.name, why(&r));
    }
    let view = w.view(&w.crews, "get_crew", json!({ "id": id })).await?;
    ensure!(view["ready"] == json!(true), "every seat of {id} joined: {view}");
    Ok(())
}

/// Every member's owner locks its bond on the job, then the captain enlists the crew.
async fn enlist_crew(w: &World, captain: &Account, crew: &str, members: &[&M], job: &str) -> Result<()> {
    for m in members {
        let r = w.bond(&m.owner, job, &m.id).await?;
        ensure!(r.is_success(), "bond {} on {job}: {}", m.name, why(&r));
    }
    let r = captain
        .call(&w.crews, "enlist")
        .args_json(json!({ "id": crew, "jobs": w.jobs, "job": job }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let failed = why(&r);
    ensure!(r.json::<Option<u32>>()?.is_some(), "{crew} enlists in {job}: {failed}");
    Ok(())
}

/// The mask's owner locks its bond, then the mask takes the job alone with its narrow key.
async fn solo(w: &World, m: &M, job: &str) -> Result<()> {
    let r = w.bond(&m.owner, job, &m.id).await?;
    ensure!(r.is_success(), "bond {} on {job}: {}", m.name, why(&r));
    let r = m.on_jobs.call(&w.jobs, "enlist").args_json(json!({ "id": job })).transact().await?;
    ensure!(r.is_success(), "{} enlists in {job}: {}", m.name, why(&r));
    Ok(())
}

/// A mask seals a step with its job key; returns its number.
async fn seal(w: &World, m: &M, job: &str, content: &str) -> Result<u32> {
    let hash = step_hash(job, &m.id, &salt_of(&m.id), content);
    let r = m
        .on_jobs
        .call(&w.jobs, "step")
        .args_json(json!({ "id": job, "hash": hash }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    let step: Value = r.clone().into_result().with_context(|| format!("{} seals: {}", m.name, why(&r)))?.json()?;
    Ok(step["seq"].as_u64().context("seq")? as u32)
}

async fn reveal(w: &World, m: &M, job: &str, seq: u32, content: &str) -> Result<()> {
    let r = m
        .on_jobs
        .call(&w.jobs, "reveal")
        .args_json(json!({ "id": job, "seq": seq, "salt": salt_of(&m.id), "content": content }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    ensure!(r.is_success(), "{} reveals {job}#{seq}: {}", m.name, why(&r));
    Ok(())
}

async fn burn(w: &World, job: &str, m: &M, milli: u128) -> Result<()> {
    let r = w.burn(&w.meter, job, &m.id, milli * MILLI).await?;
    ensure!(r.is_success(), "burn {job} {}: {}", m.name, why(&r));
    Ok(())
}

/// Anyone asks the judge; the answer comes back in the judge module's format.
async fn judged(w: &World, job: &str, winner: Option<u32>, counted: &[u32], fake: &[u32]) -> Result<()> {
    let (pending, index, _) = w.ask_judge(&w.bob, job).await?;
    let r = w.answer(pending, index, &verdict_with_fakes(job, winner, counted, fake)).await?;
    ensure!(r.is_success(), "judge {job}: {}", why(&r));
    let view = w.job(job).await?;
    ensure!(view["status"]["state"] == "decided", "{job} is decided: {view}");
    Ok(())
}

async fn round(w: &World, id: &str, state: &str, winner: Option<&AccountId>) -> Result<()> {
    let mut status = json!({ "state": state });
    if let Some(winner) = winner {
        status["winner"] = json!(winner);
        status["tx_hash"] = json!("sandbox-drain");
    }
    let bounty = json!({ "owner": w.client.id(), "amount": "1000000000000000000000000",
                         "target": format!("safe-{id}.test.near"), "deadline_ns": "0", "status": status });
    w.bounty
        .call(w.bounty.id(), "set_round")
        .args_json(json!({ "id": id, "bounty": bounty }))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn judge_call(w: &World, job: &str) -> Result<()> {
    let r = w.bob.call(&w.jobs, "judge").args_json(json!({ "id": job })).gas(Gas::from_tgas(250)).transact().await?;
    ensure!(r.is_success(), "judge {job}: {}", why(&r));
    Ok(())
}

async fn settle(w: &World, job: &str) -> Result<()> {
    let r = w.settle(&w.bob, job).await?;
    ensure!(r.is_success(), "settle {job}: {}", why(&r));
    let e = settle_event(&r);
    let paid: Vec<String> =
        e["payouts"].as_array().into_iter().flatten().map(|p| format!("{} {}", p["mask"], n3(yocto(&p["amount"])))).collect();
    let lost: Vec<String> = bonds_of(&e).iter().filter(|b| b.2 > 0).map(|b| format!("{} {}", b.0, n3(b.2))).collect();
    println!("{job} settled {}: paid {} · bonds lost {} · back {}", e["status"]["state"], paid.join(", "), lost.join(", "), n3(yocto(&e["back"])));
    Ok(())
}

/// Anyone asks the judge of a paid job for the winning work: the stand-in judge opens the winner's boxes with its
/// sandbox seed, seals the work for the client's key, keeps the box in its project's public storage and answers where.
async fn deliver(w: &World, storage: &Path, job: &str) -> Result<()> {
    let view = w.job(job).await?;
    let kind = view["terms"]["kind"].as_str().context("kind")?.to_string();
    let winner = view["status"]["winner"].as_u64().context("a paid job has a winner")? as u32;
    // The winner's steps, as the judge kept them at the verdict: read here from the job's `reveal` events would need
    // the indexer, so the world keeps them as it reveals them.
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(storage.join(format!("won-{job}.json")))?)?;
    let judge = judge_secret(&kind);
    let mut work = vec![];
    for s in kept["steps"].as_array().context("steps")? {
        let mask = s["mask"].as_str().context("mask")?;
        let content = s["content"].as_str().context("content")?;
        let mut line = json!({ "seq": s["seq"], "mask": mask, "role": s["role"] });
        match sealed::open_work(&judge, w.jobs.as_str(), job, mask, content) {
            Ok(sealed::Work::Text(t)) => line["text"] = json!(t),
            Ok(sealed::Work::Module(m)) => line["module"] = json!(sealed::b64url(&m)),
            Err(e) => anyhow::bail!("the judge cannot open {mask}'s box: {e}"),
        }
        work.push(line);
    }
    let mut payload = json!({ "job": job, "contract": w.jobs, "entrant": winner, "work": work });
    if kind == "ai_review" {
        payload["why"] = json!("Scored 9/10 on two seeds: the review finds the quorum bug, proves it on the vote it changes and proposes a fix.");
    }
    let client = sealed::parse_key(CLIENT_KEY).map_err(anyhow::Error::msg)?;
    let boxed =
        sealed::seal_delivery(&judge, &client, w.jobs.as_str(), job, w.client.id().as_str(), payload.to_string().as_bytes())
            .map_err(anyhow::Error::msg)?;
    let at = format!("delivery/{}/{job}", w.jobs);
    keep_public(storage, project(&kind), &at, &boxed)?;
    let (pending, index, request) = w.ask_delivery(&w.client, job).await?;
    let input: Value = serde_json::from_str(request["input"].as_str().context("input")?)?;
    ensure!(input["deliver"] == json!(true), "the judge was asked for a delivery: {input}");
    let answer = json!({ "success": true, "output": { "job": job, "delivered": at, "sha256": sha256_hex(boxed.as_bytes()) }, "error": null });
    let r = w.answer(pending, index, &answer.to_string()).await?;
    ensure!(r.is_success(), "deliver {job}: {}", why(&r));
    ensure!(r.logs().iter().any(|l| l.contains("\"event\":\"deliver\"")), "the contract logged the delivery");
    println!("{job} delivered: the winner's work sealed for the client's key at {at}");
    Ok(())
}

/// A value in a judge project's public storage, as OutLayer keeps it: a folder per project the indexer serves.
fn keep_public(storage: &Path, project: &str, key: &str, value: &str) -> Result<()> {
    let dir = storage.join(project.replace('/', "%2F"));
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join(key.replace('/', "%2F")), value)?;
    Ok(())
}

/// What the judge keeps of the winner at the verdict: its revealed boxes, opened again only for the delivery.
fn keep_won(storage: &Path, job: &str, steps: &[(u32, &M, &str, &str)]) -> Result<()> {
    let steps: Vec<Value> =
        steps.iter().map(|(seq, m, role, content)| json!({ "seq": seq, "mask": m.id, "role": role, "content": content })).collect();
    std::fs::write(storage.join(format!("won-{job}.json")), json!({ "steps": steps }).to_string())?;
    Ok(())
}

fn ns(job: &Value, field: &str) -> u64 {
    yocto(&job["terms"][field]) as u64
}

async fn crews_call(
    w: &World,
    by: &Account,
    method: &str,
    args: Value,
    milli: u128,
) -> Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(by
        .call(&w.crews, method)
        .args_json(args)
        .deposit(NearToken::from_millinear(milli))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

fn key(a: &Account) -> Value {
    json!({ "id": a.id(), "key": a.secret_key().to_string() })
}

#[tokio::main]
async fn main() -> Result<()> {
    let out = PathBuf::from(std::env::args().nth(1).context("usage: jobs-world <world.json>")?);
    let storage = out.parent().unwrap_or(Path::new(".")).join("storage");
    std::fs::create_dir_all(&storage)?;
    let w = World::new(&build()?).await?;
    ensure!(w.keys(&w.jobs).await? == 0 && w.keys(&w.crews).await? == 0, "nobody holds a key to either contract");
    for (kind, key) in [("tee_tests", TESTS_KEY), ("ai_review", REVIEW_KEY)] {
        let k = sealed::key_text(&sealed::JudgePublic::from(&judge_secret(kind)));
        ensure!(k == key, "the {kind} judge's sandbox seed gives the key the contract pinned");
    }
    let root = w.worker.root_account()?;
    // The client opens every job here and one more for an outside agent: it gets enough NEAR for all of them.
    root.transfer_near(w.client.id(), NearToken::from_near(100)).await?.into_result()?;

    // The world's file goes out first, so the indexer stand-in follows the chain from the start.
    let write = |masks: &[&M], state: &str| -> Result<()> {
        let masks: Vec<Value> = masks
            .iter()
            .map(|m| json!({ "name": m.name, "id": m.id, "owner": m.owner.id(), "jobs_key": m.on_jobs.secret_key().to_string(),
                             "crews_key": m.on_crews.secret_key().to_string() }))
            .collect();
        let world = json!({
            "state": state,
            "rpc": w.worker.rpc_addr(),
            "jobs": w.jobs, "crews": w.crews, "bounty": w.bounty.id(), "outlayer": w.outlayer.id(),
            "factory": w.factory.id(),
            "judges": {
                "ai_review": { "version": REVIEW_V, "key": REVIEW_KEY, "project": REVIEW_PROJECT, "seed": REVIEW_SEED, "info": "maskwars:judge-review:x25519:v1" },
                "tee_tests": { "version": TESTS_V, "key": TESTS_KEY, "project": TESTS_PROJECT, "seed": TESTS_SEED, "info": "maskwars:judge-tests:x25519:v1" },
            },
            "client_key": CLIENT_KEY,
            "client_secret": maskwars_judge_tests::job::hex(&CLIENT_SECRET),
            "storage": storage,
            "accounts": {
                "root": key(&root), "client": key(&w.client), "ann": key(&w.ann), "bob": key(&w.bob),
                "meter": key(&w.meter), "treasury": key(&w.treasury), "company": key(&w.company),
                "outlayer": key(&w.outlayer), "bounty": key(&w.bounty), "factory": key(&w.factory),
            },
            "masks": masks,
        });
        std::fs::write(&out, serde_json::to_string_pretty(&world)?)?;
        Ok(())
    };
    write(&[], "starting")?;
    tokio::time::sleep(Duration::from_secs(3)).await;

    let mk = |name: &'static str, m: &Mask, owner: &Account| M {
        name,
        id: m.id.clone(),
        on_jobs: m.on_jobs.clone(),
        on_crews: m.on_crews.clone(),
        owner: owner.clone(),
    };
    let kira = mk("kira", &w.kira, &w.ann);
    let nova = mk("nova", &w.nova, &root);
    let onyx = mk("onyx", &w.onyx, &root);
    let farm = mk("farm", &w.farm, &root);
    let juno = forged(&w, "juno", &w.bob).await?;
    let hex = forged(&w, "hex", &w.bob).await?;
    let rook = plain(&w, "rook").await?;

    // Two crews. The duo: KIRA scouts (ANN's mask), NOVA strikes, 30/70. The trio: JUNO scouts, HEX strikes (both
    // BOB's), ROOK verifies, 20/60/20.
    crew(&w, &w.ann, "duo", &[(&kira, "scout", true), (&nova, "striker", false)], json!({ "scout": 3000, "striker": 7000, "verifier": 0 })).await?;
    crew(
        &w,
        &w.bob,
        "trio",
        &[(&juno, "scout", true), (&hex, "striker", true), (&rook, "verifier", false)],
        json!({ "scout": 2000, "striker": 6000, "verifier": 2000 }),
    )
    .await?;

    // ---- Jobs that are over ------------------------------------------------------------------------------------
    open(&w, Open {
        id: "review-0001", kind: "ai_review",
        brief: "Review treasury proposal #42 against the published rubric: find what breaks its quorum.",
        spec: "spec: treasury proposal #42, the full text and the vote it changes",
        rubric: Some("Score 0-10: does the review find the quorum bug, prove it and propose a fix?"),
        round: None, reward: 3 * ONE_NEAR, fuel: 50 * MILLI, bond: None, slots: 4, work: 5, reveal: 5, appeal: 10,
    }).await?;
    round(&w, "live-0007", "open", None).await?;
    open(&w, Open {
        id: "drain-0001", kind: "drain", brief: "Drain the safe of sealed round live-0007 before its deadline.",
        spec: "spec: round live-0007 on the bounty contract, its safe and its rules", rubric: None,
        round: Some("live-0007"), reward: 2 * ONE_NEAR, fuel: 50 * MILLI, bond: None, slots: 4, work: 5,
        reveal: 5, appeal: 10,
    }).await?;
    open(&w, Open {
        id: "review-0003", kind: "ai_review",
        brief: "Review the grants payout contract by the rubric: can a grantee be paid twice?",
        spec: "spec: the grants payout contract at its deployed code hash",
        rubric: Some("Score 0-10: is there a double payout, and is it shown step by step?"),
        round: None, reward: ONE_NEAR, fuel: 20 * MILLI, bond: None, slots: 4, work: 5, reveal: 5, appeal: 10,
    }).await?;
    open(&w, Open {
        id: "bench-0002", kind: "tee_tests",
        brief: "Make the swap router pass its private test set: no route loses more than the quoted slippage.",
        spec: "spec: the swap router and the public half of its tests",
        rubric: Some("private test set: 12 cases, every route at its quoted slippage"),
        round: None, reward: 2 * ONE_NEAR, fuel: 50 * MILLI, bond: None, slots: 4, work: 5, reveal: 5, appeal: 10,
    }).await?;
    // The judge runs the private set on the client's own solution, which passes 8 of 12: the job never opens to masks.
    let (pending, index, _) = w.ask_check(&w.bob, "bench-0002").await?;
    let refused = json!({ "success": true, "output": { "job": "bench-0002", "checked": false,
        "why": "the client's own solution passes 8 of 12 cases, below win_at 10" }, "error": null });
    let r = w.answer(pending, index, &refused.to_string()).await?;
    ensure!(r.is_success(), "refuse bench-0002: {}", why(&r));
    println!("bench-0002: the judge refused the client's material: everything back to the client");

    let r1 = checked(&w, "review-0001").await?;
    let c1 = checked(&w, "review-0003").await?;
    let d1 = w.job("drain-0001").await?;

    enlist_crew(&w, &w.ann, "duo", &[&kira, &nova], "review-0001").await?;
    solo(&w, &onyx, "review-0001").await?;
    enlist_crew(&w, &w.ann, "duo", &[&kira, &nova], "drain-0001").await?;
    solo(&w, &farm, "review-0003").await?;
    solo(&w, &rook, "review-0003").await?;
    // ROOK holds a slot for a moment and leaves: the slot goes back, holding it cost a sliver of its bond.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let r = rook.on_jobs.call(&w.jobs, "leave").args_json(json!({ "id": "review-0003" })).transact().await?;
    ensure!(r.is_success(), "ROOK leaves review-0003: {}", why(&r));
    let (back, lost) = left_of(&r).context("a leave event")?;
    println!("ROOK left review-0003: {} NEAR back, {:.6} NEAR to the company for the time it held the slot", n3(back), lost as f64 / ONE_NEAR as f64);

    let finding = boxed_for(&w, "ai_review", "review-0001", &kira.id, "finding: section 4 checks the quorum before it counts abstentions, so 3 of 9 votes pass it")?;
    let review = boxed_for(&w, "ai_review", "review-0001", &nova.id, "review: the quorum check runs before abstentions are counted; 3 of 9 votes pass proposal #42. Fix: count abstentions first, then compare to 5 of 9.")?;
    let rival = boxed_for(&w, "ai_review", "review-0001", &onyx.id, "review: looks fine to me")?;
    let k1 = seal(&w, &kira, "review-0001", &finding).await?;
    let n1 = seal(&w, &nova, "review-0001", &review).await?;
    let o1 = seal(&w, &onyx, "review-0001", &rival).await?;
    let recon = "recon: set_owner on the safe is open to any mask of the round";
    let plan = "plan: set_owner to self, then sweep 1 NEAR";
    let k2 = seal(&w, &kira, "drain-0001", recon).await?;
    let n2 = seal(&w, &nova, "drain-0001", plan).await?;
    let junk = "mw1.".to_string() + &"A".repeat(934);
    let f3 = seal(&w, &farm, "review-0003", &junk).await?;
    for (m, milli) in [(&kira, 30), (&nova, 40), (&onyx, 50)] {
        burn(&w, "review-0001", m, milli).await?;
    }
    burn(&w, "drain-0001", &nova, 20).await?;
    burn(&w, "review-0003", &farm, 20).await?;

    w.wait_until(ns(&r1, "work_until").max(ns(&d1, "work_until")).max(ns(&c1, "work_until"))).await?;
    for (m, seq, content) in [(&kira, k1, &finding), (&nova, n1, &review), (&onyx, o1, &rival)] {
        reveal(&w, m, "review-0001", seq, content).await?;
    }
    reveal(&w, &kira, "drain-0001", k2, recon).await?;
    reveal(&w, &nova, "drain-0001", n2, plan).await?;
    reveal(&w, &farm, "review-0003", f3, &junk).await?;

    w.wait_until(ns(&r1, "reveal_until").max(ns(&d1, "reveal_until")).max(ns(&c1, "reveal_until"))).await?;
    // The duo wins on two seeds. ONYX's three words scored zero on two seeds: not counted, not fake.
    judged(&w, "review-0001", Some(0), &[k1, n1], &[]).await?;
    keep_won(&storage, "review-0001", &[(k1, &kira, "scout", &finding), (n1, &nova, "striker", &review)])?;
    // FARM's box opens for nobody: no work, called fake. Nobody cleared the bar.
    judged(&w, "review-0003", None, &[], &[f3]).await?;
    // The round is still open: the judge decides nothing yet. Then NOVA drains it and the job follows.
    judge_call(&w, "drain-0001").await?;
    round(&w, "live-0007", "drained", Some(&nova.id)).await?;
    judge_call(&w, "drain-0001").await?;
    let decided = w.job("review-0001").await?;
    w.wait_until(yocto(&decided["verdict"]["at_ns"]) as u64 + 11 * MIN_NS).await?;
    settle(&w, "review-0001").await?;
    settle(&w, "review-0003").await?;
    settle(&w, "drain-0001").await?;
    deliver(&w, &storage, "review-0001").await?;

    // ---- Jobs that are live ------------------------------------------------------------------------------------
    open(&w, Open {
        id: "review-0004", kind: "ai_review",
        brief: "Review DAO upgrade proposal #7: does the new quorum rule lock the treasury?",
        spec: "spec: DAO upgrade proposal #7 and the contract it deploys",
        rubric: Some("Score 0-10: is a lock shown, with the exact vote that triggers it?"),
        round: None, reward: 4 * ONE_NEAR, fuel: 80 * MILLI, bond: None, slots: 6, work: 5, reveal: 5,
        appeal: 24 * 60,
    }).await?;
    open(&w, Open {
        id: "tests-0005", kind: "tee_tests",
        brief: "Patch the vault so its private test set passes: no withdrawal over the daily cap.",
        spec: "spec: the vault contract, its daily cap and the public half of its tests",
        rubric: Some("private test set: 12 cases, the withdrawal cap under every path"),
        round: None, reward: 6 * ONE_NEAR, fuel: 100 * MILLI, bond: Some(200 * MILLI), slots: 6, work: 5,
        reveal: 24 * 60, appeal: 24 * 60,
    }).await?;
    open(&w, Open {
        id: "audit-0006", kind: "ai_review",
        brief: "Audit the lending pool by the rubric: every path that lets a borrower leave with more than they put in.",
        spec: "spec: the lending pool contract, its oracle and its liquidation rules",
        rubric: Some("Score 0-10 per path: is the loss proven on chain state, with the transactions that cause it?"),
        round: None, reward: 12 * ONE_NEAR, fuel: 200 * MILLI, bond: Some(500 * MILLI), slots: 8,
        work: 3 * 24 * 60, reveal: 24 * 60, appeal: 24 * 60,
    }).await?;
    round(&w, "live-0008", "open", None).await?;
    open(&w, Open {
        id: "drain-0007", kind: "drain", brief: "Drain the safe of sealed round live-0008 while its round runs.",
        spec: "spec: round live-0008 on the bounty contract, its safe and its rules", rubric: None,
        round: Some("live-0008"), reward: 5 * ONE_NEAR, fuel: 100 * MILLI, bond: None, slots: 6,
        work: 2 * 24 * 60, reveal: 12 * 60, appeal: 60,
    }).await?;
    open(&w, Open {
        id: "review-0010", kind: "ai_review",
        brief: "Review the staking pool's unstake queue by the rubric: can one account jump the queue?",
        spec: "spec: the staking pool contract and its unstake queue",
        rubric: Some("Score 0-10: is a queue jump shown, with the calls that make it?"),
        round: None, reward: 2 * ONE_NEAR, fuel: 50 * MILLI, bond: None, slots: 4, work: 5, reveal: 5, appeal: 60,
    }).await?;
    let r4 = checked(&w, "review-0004").await?;
    let t5 = checked(&w, "tests-0005").await?;
    checked(&w, "audit-0006").await?;
    let r10 = checked(&w, "review-0010").await?;

    enlist_crew(&w, &w.bob, "trio", &[&juno, &hex, &rook], "review-0004").await?;
    solo(&w, &farm, "review-0004").await?;
    enlist_crew(&w, &w.ann, "duo", &[&kira, &nova], "tests-0005").await?;
    solo(&w, &onyx, "tests-0005").await?;
    enlist_crew(&w, &w.bob, "trio", &[&juno, &hex, &rook], "audit-0006").await?;
    solo(&w, &onyx, "audit-0006").await?;
    solo(&w, &farm, "audit-0006").await?;
    enlist_crew(&w, &w.ann, "duo", &[&kira, &nova], "drain-0007").await?;
    solo(&w, &onyx, "review-0010").await?;

    let scout4 = boxed_for(&w, "ai_review", "review-0004", &juno.id, "finding: the new rule counts only yes votes toward quorum, so a single no vote can never pass")?;
    let strike4 = boxed_for(&w, "ai_review", "review-0004", &hex.id, "review: after vote 3 the treasury locks: quorum counts yes votes only, and the unlock needs a quorum.")?;
    let check4 = boxed_for(&w, "ai_review", "review-0004", &rook.id, "check: replayed vote 3 on a fork of the DAO, the treasury is locked, the strike holds")?;
    let junk4 = "mw1.".to_string() + &"B".repeat(934);
    let j4 = seal(&w, &juno, "review-0004", &scout4).await?;
    let h4 = seal(&w, &hex, "review-0004", &strike4).await?;
    let r4s = seal(&w, &rook, "review-0004", &check4).await?;
    let f4 = seal(&w, &farm, "review-0004", &junk4).await?;
    let scout5 = boxed_for(&w, "tee_tests", "tests-0005", &kira.id, "finding: withdraw() reads the cap after the transfer, a second call in the same block passes it")?;
    let module5 = boxed_for(&w, "tee_tests", "tests-0005", &nova.id, "module")?;
    let rival5 = boxed_for(&w, "tee_tests", "tests-0005", &onyx.id, "module")?;
    let k5 = seal(&w, &kira, "tests-0005", &scout5).await?;
    let n5 = seal(&w, &nova, "tests-0005", &module5).await?;
    seal(&w, &onyx, "tests-0005", &rival5).await?;
    for (m, text) in [
        (&juno, "finding: the oracle price is read before the liquidation check"),
        (&hex, "review: three paths, the first through a stale oracle"),
        (&onyx, "review: one path through rounding in repay"),
    ] {
        let b = boxed_for(&w, "ai_review", "audit-0006", &m.id, text)?;
        seal(&w, m, "audit-0006", &b).await?;
    }
    seal(&w, &kira, "drain-0007", "recon: the safe's withdraw takes any amount from its owner").await?;
    let queue = boxed_for(&w, "ai_review", "review-0010", &onyx.id, "review: unstake() sorts by amount, not by time: a large unstake jumps the queue")?;
    let q10 = seal(&w, &onyx, "review-0010", &queue).await?;
    for (m, milli) in [(&juno, 25), (&hex, 60), (&rook, 30), (&farm, 80)] {
        burn(&w, "review-0004", m, milli).await?;
    }
    for (m, milli) in [(&kira, 35), (&nova, 90), (&onyx, 70)] {
        burn(&w, "tests-0005", m, milli).await?;
    }
    for (m, milli) in [(&juno, 40), (&hex, 120), (&onyx, 65)] {
        burn(&w, "audit-0006", m, milli).await?;
    }
    burn(&w, "drain-0007", &kira, 15).await?;
    burn(&w, "review-0010", &onyx, 30).await?;

    w.wait_until(ns(&r4, "work_until").max(ns(&t5, "work_until")).max(ns(&r10, "work_until"))).await?;
    for (m, seq, content) in [(&juno, j4, &scout4), (&hex, h4, &strike4), (&rook, r4s, &check4), (&farm, f4, &junk4)] {
        reveal(&w, m, "review-0004", seq, content).await?;
    }
    reveal(&w, &kira, "tests-0005", k5, &scout5).await?;
    reveal(&w, &nova, "tests-0005", n5, &module5).await?;
    reveal(&w, &onyx, "review-0010", q10, &queue).await?;
    w.wait_until(ns(&r4, "reveal_until").max(ns(&r10, "reveal_until"))).await?;
    // The trio wins; FARM's box opens for nobody: no work, its whole bond to the company once settled.
    judged(&w, "review-0004", Some(0), &[j4, h4, r4s], &[f4]).await?;
    // NEAR AI is down: the judge asks to be run again in 25 minutes, and the contract takes no run before then.
    let (pending, index, _) = w.ask_judge(&w.bob, "review-0010").await?;
    let retry = w.now().await? + 25 * MIN_NS;
    let down = json!({ "success": false, "error": "NEAR AI answered 503: 1 of 1 entrants waits for its back-off",
        "output": { "job": "review-0010", "retry_at": retry.to_string(), "asked": 1 } });
    let r = w.answer(pending, index, &down.to_string()).await?;
    ensure!(r.is_success(), "review-0010's run: {}", why(&r));
    ensure!(w.job("review-0010").await?["retry_at"] == json!(retry.to_string()), "the contract keeps the judge's retry_at");
    println!("review-0010: NEAR AI is down, the judge retries from its back-off; no run is taken before it");
    // A job the judge has not checked yet: no mask may start before it.
    open(&w, Open {
        id: "review-0009", kind: "ai_review",
        brief: "Review the bridge's withdrawal proof check by the rubric: can a forged proof release funds?",
        spec: "spec: the bridge contract and its proof verifier",
        rubric: Some("Score 0-10: is a forged proof shown that the verifier accepts?"),
        round: None, reward: 8 * ONE_NEAR, fuel: 100 * MILLI, bond: Some(300 * MILLI), slots: 8, work: 24 * 60,
        reveal: 12 * 60, appeal: 24 * 60,
    }).await?;

    let masks = [&kira, &nova, &onyx, &farm, &juno, &hex, &rook];
    write(&masks, "ready")?;
    let list = w.view(&w.jobs, "list", json!({})).await?;
    for j in list.as_array().unwrap() {
        println!("{:12} {:10} {:10} masks {}", j["id"].as_str().unwrap(), j["terms"]["kind"].as_str().unwrap(), j["phase"].as_str().unwrap(), j["masks"]);
    }
    println!("READY {} → {}", w.worker.rpc_addr(), out.display());
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}
