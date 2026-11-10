//! A `tee_tests` job against the real jobs contract, from `open` and its check to `settle` and the delivery, with the
//! judge's own verdict: a private benchmark on NEAR account ids. Every work is sealed for the judge; a mask whose work
//! is objectively no work loses its bond to the company, never to the winner; a work that loads but fails the private
//! set keeps its bond; only the client gets the winning module, and only once the job is paid. A test set nobody can
//! pass never opens to masks. Then the client, with a puppet that sealed first, swaps its test set after the check and
//! appeals; and a contract that is not ours asks the judge and gets nothing.

use anyhow::{ensure, Result};
use job_judges_sandbox::*;
use jobs_sandbox::{build, World};
use maskwars_judge_tests::sealed;
use maskwars_judge_tests::{answer, Secrets};
use serde_json::{json, Value};
use near_workspaces::types::{Gas, NearToken};
use std::sync::Arc;

/// The judge's TEE seed in the sandbox. On OutLayer it is generated inside the TEE and nobody sees it.
const SEED: &str = "5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed";

fn judge_key() -> sealed::JudgePublic {
    let seed: [u8; 32] = maskwars_judge_tests::job::unhex(SEED).unwrap().try_into().unwrap();
    sealed::JudgePublic::from(&sealed::judge_secret(&seed))
}

/// A mask seals its work module for the judge's key, as an agent does before it seals the step.
fn sealed_for(w: &World, mask: &Mask, job: &str, module: &[u8], salt: u8) -> String {
    sealed::seal(&judge_key(), w.jobs.as_str(), job, mask.id.as_str(), module, [salt; 32], [salt; 12]).unwrap()
}

/// Text sealed for the judge: a finding, or a striker's "work" that holds no module.
fn text_for(w: &World, mask: &Mask, job: &str, text: &str, salt: u8) -> String {
    sealed::seal_text(&judge_key(), w.jobs.as_str(), job, mask.id.as_str(), text, [salt; 32], [salt; 12]).unwrap()
}

/// The judge as OutLayer runs it for this job, with its project's storage `kept` from run to run. The client's row
/// supplies `MASKWARS_TESTS` only when the contract names it: at the check.
fn run_judge(w: &World, tests: Option<String>, kept: Arc<Kept>) -> impl FnOnce(Value) -> Value {
    let (a, b) = sources(w);
    let caller = caller(w, TESTS_PROJECT);
    let client = w.client.id().to_string();
    move |input| {
        let tests = if input["check"] == json!(true) { tests } else { None };
        let secrets = Secrets { seed: Some(SEED.into()), tests, tests_owner: Some(client), tests_profile: Some("bench-tests".into()) };
        serde_json::to_value(answer(Some(input), &caller, &secrets, &[&a, &b], &*kept)).unwrap()
    }
}

const SPEC: &[u8] = b"Export alloc and run; answer yes if the input is a valid NEAR account id, no otherwise.";

/// The client opens a job on its private set with the bar it publishes: the set's `win_at`, cases and fuel, and its
/// own solution sealed for the judge with its own account as the mask. Then anyone asks for the check.
async fn open_and_check(w: &World, id: &str, tests: &str, solution: &[u8], reward: u128, slots: u8, kept: Arc<Kept>) -> Result<(Value, Value)> {
    let t: Value = serde_json::from_str(tests)?;
    let reference = sealed::seal(&judge_key(), w.jobs.as_str(), id, w.client.id().as_str(), solution, [99; 32], [99; 12]).unwrap();
    let bar = json!({ "win_at": t["win_at"], "cases": t["cases"].as_array().unwrap().len(), "fuel": t["fuel"].to_string(),
                      "reference": reference });
    let secrets = json!({ "profile": "bench-tests", "account_id": w.client.id() });
    let job = open(w, id, "tee_tests", TESTS_V, &sha256_hex(SPEC), &sha256_hex(tests.as_bytes()), Some(secrets.clone()), bar.clone(), reward, slots).await?;
    ensure!(job["terms"]["bar"] == bar && job["terms"]["secrets"] == secrets && job["phase"] == "checking", "{job}");
    ensure!(job["terms"]["judge"]["key"] == sealed::key_text(&judge_key()), "the job pins the key this judge holds: {job}");
    let r = w.onyx.on_jobs.call(&w.jobs, "enlist").args_json(json!({ "id": id })).transact().await?;
    ensure!(r.is_failure(), "no mask enlists before the check");
    check_with(w, id, run_judge(w, Some(tests.to_string()), kept)).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_private_benchmark_pays_the_work_that_passes_the_most_cases() -> Result<()> {
    let w = World::new(&build()?).await?;
    let id = "bench-0001";
    let tests = account_tests();
    let kept = Arc::new(Kept::default());
    let (nova_module, onyx_module) = (work_module(false)?, work_module(true)?);

    // 1. The client opens the job: 3 NEAR, 0.05 NEAR of fuel for each of 5 masks, its test set's hash, its own secrets,
    //    the bar (win_at 10 of 12 cases, 20 000 fuel a case) and its own solution. The judge checks it all in its TEE
    //    before anyone starts, the client's solution passes 12 of 12, and the judge keeps the set for itself.
    let (out, job) = open_and_check(&w, id, &tests, &nova_module, 3 * ONE_NEAR, 5, kept.clone()).await?;
    let c = &out["output"];
    ensure!(c["checked"] == true && c["reference"] == json!({ "passed": 12, "of": 12 }), "{out}");
    ensure!(job["checked"] == true && job["phase"] == "enlisting", "{job}");
    ensure!(kept.count("tests/") == 1, "the judge keeps the client's set in its private storage");
    println!("{id}: the judge checked the private set and the client's own solution (12/12) and kept the set: masks may start");

    // 2. The duo (KIRA scouts, NOVA strikes), ONYX and FARM take it, each on a 0.05 NEAR bond its owner locked.
    ensure!(duo_on(&w, "duo", id).await? == 0);
    ensure!(enlist(&w, &w.onyx, id).await? == 1);
    ensure!(enlist(&w, &w.farm, id).await? == 2);

    // 3. Every step is a box for the judge's key. NOVA's and ONYX's works are Rust compiled to Wasm (453 and 302
    //    bytes); KIRA's finding is text; FARM's "work" is text that holds no module.
    let nova_box = sealed_for(&w, &w.nova, id, &nova_module, 11);
    let onyx_box = sealed_for(&w, &w.onyx, id, &onyx_module, 12);
    let finding = text_for(&w, &w.kira, id, "finding: separators may not lead, trail or repeat; 2 to 64 characters", 13);
    let farm_box = text_for(&w, &w.farm, id, "work: trust me, it passes", 14);
    let o = w.seal(&w.onyx, id, &onyx_box).await?;
    let k = w.seal(&w.kira, id, &finding).await?;
    let n = w.seal(&w.nova, id, &nova_box).await?;
    let f = w.seal(&w.farm, id, &farm_box).await?;
    for (mask, milli) in [(&w.kira.id, 10), (&w.nova.id, 40), (&w.onyx.id, 30), (&w.farm.id, 50)] {
        w.burn(&w.meter, id, mask, milli * MILLI).await?.into_result()?;
    }

    // 4. Reveal; the judge reads the job from the chain, opens the boxes in its TEE and runs the set it kept.
    reveal_all(&w, &job, &[(&w.onyx, o, &onyx_box), (&w.kira, k, &finding), (&w.nova, n, &nova_box), (&w.farm, f, &farm_box)])
        .await?;
    let steps = w.view(&w.jobs, "steps", json!({ "id": id })).await?;
    ensure!(steps.as_array().unwrap().iter().all(|s| s["content"].as_str().unwrap().starts_with("mw1.")), "no work in the open");
    let (out, request, job) = judge_with(&w, id, false, run_judge(&w, Some(tests.clone()), kept.clone())).await?;
    ensure!(request["secrets"].is_null(), "after the check the contract names no secrets of the client");
    let v = &out["output"];
    ensure!(v["winner"] == 0 && v["counted"] == json!([o, k, n]) && v["fake"] == json!([f]), "{out}");
    ensure!(v["works"][0] == json!({ "step": o, "entrant": 1, "passed": 8, "of": 12 }), "ONYX passes 8 of 12: {v}");
    ensure!(v["works"][1] == json!({ "step": n, "entrant": 0, "passed": 12, "of": 12 }), "NOVA passes 12 of 12: {v}");
    ensure!(job["status"]["state"] == "decided" && job["verdict"]["winner"] == 0 && job["verdict"]["fake"] == json!([f]), "{job}");
    println!("{id}: NOVA's work passes 12/12, ONYX's 8/12 (below win_at 10, a real attempt), FARM's box holds no module: fake");

    // 5. Nobody gets the work before the job is paid.
    let r = w.client.call(&w.jobs, "deliver").args_json(json!({ "id": id })).deposit(near_workspaces::types::NearToken::from_millinear(10)).gas(near_workspaces::types::Gas::from_tgas(250)).transact().await?;
    ensure!(r.is_failure() && jobs_sandbox::why(&r).contains("once the job is paid"), "{}", jobs_sandbox::why(&r));

    // 6. After the appeal window, anyone settles. The duo splits 3 NEAR, less 5%; FARM's lost bond goes to the company,
    //    not into the duo's part; NEAR AI gets the fuel of the three real attempts; FARM's fuel goes back to the client;
    //    the other bonds go back.
    w.wait_until(yocto(&job["verdict"]["at_ns"]) as u64 + 10 * MIN_NS).await?;
    let root = w.worker.root_account()?;
    let ids = [&w.kira.id, &w.nova.id, &w.onyx.id, &w.farm.id, w.treasury.id(), w.client.id(), w.ann.id(), root.id(), w.company.id()];
    let before = balances(&w, &ids).await?;
    let r = w.settle(&w.bob, id).await?;
    ensure!(r.is_success(), "settle: {}", jobs_sandbox::why(&r));
    let after = balances(&w, &ids).await?;
    let got: Vec<u128> = after.iter().zip(&before).map(|(a, b)| a - b).collect();
    let fee = 3 * ONE_NEAR * 5 / 100;
    let net = 3 * ONE_NEAR - fee;
    ensure!(got[0] == net * 3 / 10 && got[1] == net - net * 3 / 10, "the duo splits 30/70: {} {}", n3(got[0]), n3(got[1]));
    ensure!(got[2] == 0 && got[3] == 0, "ONYX and FARM get nothing");
    ensure!(got[4] == 80 * MILLI, "NEAR AI is paid KIRA's, NOVA's and ONYX's fuel: {}", n3(got[4]));
    ensure!(got[5] == yocto(&settle_event(&r)["back"]), "the client gets the rest back, FARM's fuel with it");
    ensure!(got[6] == 50 * MILLI && got[7] == 100 * MILLI, "KIRA's, NOVA's and ONYX's bonds go back; FARM's is lost");
    ensure!(got[8] == fee + 50 * MILLI, "the company: its fee and FARM's bond: {}", n3(got[8]));
    ensure!(w.job(id).await?["status"] == json!({ "state": "paid", "winner": 0 }));
    println!(
        "settled: KIRA {} NEAR, NOVA {} NEAR, FARM's 0.050 bond to the company, NEAR AI {} NEAR for three real attempts, client back {} NEAR",
        n3(got[0]),
        n3(got[1]),
        n3(got[4]),
        n3(got[5])
    );

    // 7. The client asks for the work: the judge seals NOVA's module (and KIRA's finding) for the client's key.
    let (out, request, event) = deliver_with(&w, id, run_judge(&w, None, kept.clone())).await?;
    ensure!(request["secrets"].is_null(), "{request}");
    let at = out["output"]["delivered"].as_str().unwrap().to_string();
    ensure!(event["at"] == json!(at) && event["sha256"] == out["output"]["sha256"], "{event}");
    let boxed = String::from_utf8(kept.public(&at).unwrap())?;
    let client = x25519_dalek::StaticSecret::from(CLIENT_SECRET);
    let work: Value = serde_json::from_slice(&sealed::open_delivery(&client, w.jobs.as_str(), id, w.client.id().as_str(), &boxed).map_err(anyhow::Error::msg)?)?;
    let module = work["work"].as_array().unwrap().iter().find(|s| s["mask"] == json!(w.nova.id)).unwrap()["module"].as_str().unwrap().to_string();
    ensure!(sealed::unb64url(&module).map_err(anyhow::Error::msg)? == nova_module, "the client gets NOVA's very module");
    ensure!(!work.to_string().contains(w.onyx.id.as_str()), "ONYX's work goes to nobody");
    println!("{id}: delivered after settle: the client opens NOVA's {}-byte module with its own key; ONYX's and FARM's work stay theirs", nova_module.len());
    Ok(())
}

/// A test set nobody can pass, or one the client's own solution does not pass, never opens to masks: the check
/// refuses it, and the client gets everything back before anyone works.
#[tokio::test(flavor = "multi_thread")]
async fn a_test_set_the_client_s_own_solution_cannot_pass_never_opens() -> Result<()> {
    let w = World::new(&build()?).await?;
    let id = "fail-0001";
    let before = w.balance(w.client.id()).await?;
    // The client's "solution" is the sloppy one: 8 of 12, below win_at 10.
    let (out, job) = open_and_check(&w, id, &account_tests(), &work_module(true)?, ONE_NEAR, 2, Arc::new(Kept::default())).await?;
    let c = &out["output"];
    ensure!(c["checked"] == false && c["why"] == "the client's own solution passes 8 of 12 cases, below win_at 10", "{out}");
    ensure!(job["status"]["state"] == "cancelled", "{job}");
    let r = w.onyx.on_jobs.call(&w.jobs, "enlist").args_json(json!({ "id": id })).transact().await?;
    ensure!(r.is_failure(), "nobody starts on a refused job");
    let spent = before - w.balance(w.client.id()).await?;
    ensure!(spent < 30 * MILLI, "the client paid only the check's run, the record and gas: {}", n3(spent));
    println!("{id}: the client's own solution passes 8/12, below win_at 10 → refused before anyone started, {} NEAR spent", n3(spent));
    Ok(())
}

/// Finding 1 of the second review. The client's puppet (ONYX) seals a guess first; NOVA does the work. After the
/// check the client removes its test set from its row, or swaps it for one the work fails, and appeals. Before, the
/// judge read the swapped row, answered `shared`, and the puppet took half. Now the contract names no secrets after the
/// check and the judge reads only the set it kept: NOVA wins both times, the appeal upholds it and its bond goes to the
/// company, and the puppet, whose "work" holds no module, loses its bond to the company.
#[tokio::test(flavor = "multi_thread")]
async fn a_client_who_hides_or_swaps_its_test_set_after_the_check_changes_nothing() -> Result<()> {
    let w = World::new(&build()?).await?;
    let tests = account_tests();
    let mut swapped: Value = serde_json::from_str(&tests)?;
    swapped["cases"][1]["expect"] = json!("no");
    let swapped = swapped.to_string();
    ensure!(swapped != tests, "the swapped set says a1 is not a valid account");

    for (id, row) in [("hide-0001", None), ("swap-0001", Some(swapped))] {
        let kept = Arc::new(Kept::default());
        let (_, job) = open_and_check(&w, id, &tests, &work_module(false)?, ONE_NEAR, 2, kept.clone()).await?;
        enlist(&w, &w.onyx, id).await?;
        enlist(&w, &w.nova, id).await?;
        let nova_box = sealed_for(&w, &w.nova, id, &work_module(false)?, 21);
        let onyx_box = text_for(&w, &w.onyx, id, "work: a guess, sealed early", 22);
        let o = w.seal(&w.onyx, id, &onyx_box).await?;
        let n = w.seal(&w.nova, id, &nova_box).await?;
        reveal_all(&w, &job, &[(&w.onyx, o, &onyx_box), (&w.nova, n, &nova_box)]).await?;
        let (out, request, job) = judge_with(&w, id, false, run_judge(&w, row.clone(), kept.clone())).await?;
        ensure!(request["secrets"].is_null(), "the verdict names no secrets: {request}");
        let v = &out["output"];
        ensure!(v["winner"] == 1 && v["counted"] == json!([n]) && v["fake"] == json!([o]) && v.get("shared").is_none(), "{out}");
        // The client appeals, its row still swapped or gone.
        let company = w.balance(w.company.id()).await?;
        let (second, request, job2) = judge_with(&w, id, true, run_judge(&w, row, kept.clone())).await?;
        ensure!(request["secrets"].is_null(), "the appeal names no secrets either: {request}");
        ensure!(second["output"]["winner"] == 1 && job2["verdict"]["final"] == true, "{second}");
        ensure!(w.balance(w.company.id()).await? > company, "the upheld appeal's bond goes to the company");
        let ids = [&w.onyx.id, &w.nova.id];
        let before = balances(&w, &ids).await?;
        let r = w.settle(&w.bob, id).await?;
        ensure!(r.is_success(), "settle: {}", jobs_sandbox::why(&r));
        let after = balances(&w, &ids).await?;
        let net = ONE_NEAR - ONE_NEAR * 5 / 100;
        ensure!(after[0] == before[0] && after[1] - before[1] == net, "NOVA takes the reward, and no bond");
        let lost = bonds_of(&settle_event(&r)).into_iter().find(|b| b.0 == w.onyx.id.as_str()).unwrap();
        ensure!(lost.2 == 50 * MILLI, "the puppet's bond is lost, to the company");
        ensure!(w.job(id).await?["status"] == json!({ "state": "paid", "winner": 1 }));
        let _ = job;
        println!(
            "{id}: the client {} its row after the check and appealed → the judge read the set it kept: NOVA {} NEAR, the puppet ONYX 0 and its bond lost to the company",
            if id.starts_with("hide") { "emptied" } else { "swapped" },
            n3(net)
        );
    }
    Ok(())
}

/// An appeal runs the private set three times in three orders and upholds a stable verdict; the bond goes to the
/// company that pays for the judges.
#[tokio::test(flavor = "multi_thread")]
async fn an_appeal_reruns_the_set_three_times_and_upholds_a_stable_verdict() -> Result<()> {
    let w = World::new(&build()?).await?;
    let id = "bench-0002";
    let tests = account_tests();
    let kept = Arc::new(Kept::default());
    let (_, job) = open_and_check(&w, id, &tests, &work_module(false)?, ONE_NEAR, 2, kept.clone()).await?;
    enlist(&w, &w.onyx, id).await?;
    enlist(&w, &w.nova, id).await?;
    let onyx_box = sealed_for(&w, &w.onyx, id, &work_module(true)?, 31);
    let nova_box = sealed_for(&w, &w.nova, id, &work_module(false)?, 32);
    let o = w.seal(&w.onyx, id, &onyx_box).await?;
    let n = w.seal(&w.nova, id, &nova_box).await?;
    reveal_all(&w, &job, &[(&w.onyx, o, &onyx_box), (&w.nova, n, &nova_box)]).await?;
    let (first, _, job) = judge_with(&w, id, false, run_judge(&w, None, kept.clone())).await?;
    ensure!(job["verdict"]["winner"] == 1 && job["verdict"]["final"] == false, "{first}");

    let company = w.balance(w.company.id()).await?;
    let (second, request, job) = judge_with(&w, id, true, run_judge(&w, None, kept)).await?;
    let input: Value = serde_json::from_str(request["input"].as_str().unwrap())?;
    ensure!(input["appeal"] == true && input["prior"]["winner"] == 1, "the judge is told it is an appeal: {input}");
    ensure!(second["output"]["rule"] == "tests, three runs", "{second}");
    ensure!(second["output"]["works"][1]["runs"] == 3 && second["output"]["works"][1]["passed"] == 12, "NOVA ran three times: {second}");
    ensure!(second["output"]["works"][0] == first["output"]["works"][0], "ONYX, below win_at, needs no recheck");
    ensure!(job["verdict"]["winner"] == 1 && job["verdict"]["final"] == true, "{job}");
    let bond = w.balance(w.company.id()).await? - company;
    ensure!(bond > 0, "the bond of an upheld appeal goes to the company: {}", n3(bond));
    println!("{id}: the appeal ran the private set three times, NOVA's 12/12 held, the verdict is final");
    Ok(())
}

/// Third review, finding 2. The client's puppet ONYX knows the private set and seals the right module; NOVA and FARM,
/// who cannot see the set, read "yes" and "no" as "true" and "false": their modules load and run and pass no case.
/// Before, both were fake and their bonds went to the winner: the puppet collected them, and the client got its reward
/// back less the fee. Now a work that loads is never fake for the cases it failed, and the puppet wins the reward and
/// no bond, so the client's trick costs it the fee and wins it nothing. Fourth review, finding 1: a work that passes
/// no case is not counted either, so a seat that holds one is not free: NOVA's and FARM's seats each pay half their
/// bonds to the company, where before they got all of it back and fifteen such puppets held a job's slots for free.
#[tokio::test(flavor = "multi_thread")]
async fn a_puppet_on_the_hidden_set_collects_no_bond() -> Result<()> {
    let w = World::new(&build()?).await?;
    let id = "puppet-0001";
    let tests = account_tests();
    let kept = Arc::new(Kept::default());
    let (_, job) = open_and_check(&w, id, &tests, &work_module(false)?, ONE_NEAR, 3, kept.clone()).await?;
    enlist(&w, &w.onyx, id).await?;
    enlist(&w, &w.nova, id).await?;
    enlist(&w, &w.farm, id).await?;
    // Answers "true" for every input: the right length for nothing the set expects.
    let misread = wat::parse_str(
        r#"(module (memory (export "memory") 1) (data (i32.const 512) "true")
          (func (export "alloc") (param i32) (result i32) (i32.const 64))
          (func (export "run") (param i32 i32) (result i64) (i64.const 0x0000020000000004)))"#,
    )?;
    let onyx_box = sealed_for(&w, &w.onyx, id, &work_module(false)?, 41);
    let nova_box = sealed_for(&w, &w.nova, id, &misread, 42);
    let farm_box = sealed_for(&w, &w.farm, id, &misread, 43);
    let o = w.seal(&w.onyx, id, &onyx_box).await?;
    let n = w.seal(&w.nova, id, &nova_box).await?;
    let f = w.seal(&w.farm, id, &farm_box).await?;
    reveal_all(&w, &job, &[(&w.onyx, o, &onyx_box), (&w.nova, n, &nova_box), (&w.farm, f, &farm_box)]).await?;
    let (out, _, job) = judge_with(&w, id, false, run_judge(&w, None, kept.clone())).await?;
    let v = &out["output"];
    ensure!(v["winner"] == 0 && v["counted"] == json!([o]) && v["fake"] == json!([]), "{out}");
    ensure!(v["works"][1] == json!({ "step": n, "entrant": 1, "passed": 0, "of": 12 }), "NOVA's work ran: {v}");
    w.wait_until(yocto(&job["verdict"]["at_ns"]) as u64 + 10 * MIN_NS).await?;
    let root = w.worker.root_account()?;
    let ids = [&w.onyx.id, root.id(), w.company.id()];
    let before = balances(&w, &ids).await?;
    let r = w.settle(&w.bob, id).await?;
    ensure!(r.is_success(), "settle: {}", jobs_sandbox::why(&r));
    let after = balances(&w, &ids).await?;
    let got: Vec<u128> = after.iter().zip(&before).map(|(a, b)| a - b).collect();
    let fee = ONE_NEAR * 5 / 100;
    ensure!(got[0] == ONE_NEAR - fee, "the puppet takes the reward and nothing more: {}", n3(got[0]));
    ensure!(got[1] == 50 * MILLI + 2 * 25 * MILLI, "ONYX's bond, and half of NOVA's and of FARM's: {}", n3(got[1]));
    ensure!(got[2] == fee + 2 * 25 * MILLI, "the company: its fee and the idle halves, never a whole bond: {}", n3(got[2]));
    let mut lost: Vec<(String, u128)> = bonds_of(&settle_event(&r)).into_iter().filter(|b| b.2 > 0).map(|b| (b.0, b.2)).collect();
    let mut idle = vec![(w.nova.id.to_string(), 25 * MILLI), (w.farm.id.to_string(), 25 * MILLI)];
    lost.sort();
    idle.sort();
    ensure!(lost == idle, "the idle halves of NOVA and FARM, nothing else: {lost:?}");
    println!("{id}: the puppet knew the set and won; NOVA and FARM misread it (0/12, loaded): not fake, not counted, half of each bond (0.025 NEAR) to the company, never to the winner; the puppet got {} NEAR and no bond", n3(got[0]));
    Ok(())
}

/// Third review, finding 3. Someone deploys a jobs contract of their own, copies a client's job (its private set's
/// hash, our judge and its key) and asks our judge to check it, then to judge it: an oracle on the private set the
/// check kept, and calls on the judge's keys. The judge serves only the jobs contract written into it: both answers
/// are a refusal, nothing is read or kept, and the copy stays unchecked.
#[tokio::test(flavor = "multi_thread")]
async fn a_contract_that_is_not_ours_gets_nothing_from_the_judge() -> Result<()> {
    let w = World::new(&build()?).await?;
    let tests = account_tests();
    let kept = Arc::new(Kept::default());
    let (_, victim) = open_and_check(&w, "bench-0003", &tests, &work_module(false)?, ONE_NEAR, 2, kept.clone()).await?;
    ensure!(victim["checked"] == true && kept.count("tests/") == 1);
    // MALLORY's own jobs contract, the same code, OutLayer the same, our judge pinned.
    let wasm = build()?;
    let root = w.worker.root_account()?;
    let mallory = root.create_subaccount("fake-jobs").initial_balance(NearToken::from_near(20)).transact().await?.into_result()?;
    mallory.deploy(&wasm.jobs).await?.into_result()?;
    let judges = json!([{ "kind": "tee_tests", "project": TESTS_PROJECT, "version": TESTS_V, "key": TESTS_KEY }]);
    mallory
        .call(mallory.id(), "new")
        .args_json(json!({ "admin": mallory.id(), "meter": mallory.id(), "treasury": mallory.id(), "outlayer": w.outlayer.id(),
                           "crews": w.crews, "judges": judges, "bounties": [], "factories": [], "fee_bps": 0, "fee_to": mallory.id() }))
        .transact()
        .await?
        .into_result()?;
    let quote = w.view(mallory.id(), "quote", json!({ "reward": ONE_NEAR.to_string(), "fuel_per_mask": (50 * MILLI).to_string(), "slots": 2 })).await?;
    let total: u128 = quote["total"].as_str().unwrap().parse()?;
    let terms = &victim["terms"];
    let secrets = json!({ "profile": "bench-tests", "account_id": mallory.id() });
    mallory
        .call(mallory.id(), "open")
        .args_json(json!({
            "id": "bench-0003", "kind": "tee_tests", "brief": "copy", "spec": terms["spec"], "rubric": terms["rubric"],
            "judge_version": TESTS_V, "round": null, "secrets": secrets, "bar": terms["bar"],
            "reward": ONE_NEAR.to_string(), "fuel_per_mask": (50 * MILLI).to_string(), "slots": 2,
            "open_to": { "who": "anyone" }, "work_minutes": 5, "reveal_minutes": 5, "appeal_minutes": 10, "client_key": CLIENT_KEY,
        }))
        .deposit(NearToken::from_yoctonear(total))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let asked = w.view(w.outlayer.id(), "requests", json!({})).await?.as_array().map_or(0, Vec::len);
    let pending = w.bob.call(mallory.id(), "check").args_json(json!({ "id": "bench-0003" })).gas(Gas::from_tgas(250)).transact_async().await?;
    let mut request = Value::Null;
    for _ in 0..300 {
        if let Some(r) = w.view(w.outlayer.id(), "requests", json!({})).await?.as_array().and_then(|r| r.get(asked)).cloned() {
            request = r;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    ensure!(request["caller"] == json!(mallory.id()), "OutLayer says who asked: {request}");
    // The judge as OutLayer runs it: the predecessor is MALLORY's contract; the contract it serves is ours.
    let (a, b) = sources(&w);
    let caller = Caller { predecessor: Some(mallory.id().to_string()), project: Some(TESTS_PROJECT.into()), served: vec![w.jobs.to_string()] };
    let secrets_row = Secrets { seed: Some(SEED.into()), tests: Some(tests.clone()), tests_owner: Some(mallory.id().to_string()), tests_profile: Some("bench-tests".into()) };
    let input: Value = serde_json::from_str(request["input"].as_str().unwrap())?;
    let out = answer(Some(input), &caller, &secrets_row, &[&a, &b], &*kept);
    ensure!(out.error.as_deref() == Some("this judge serves only the jobs contract written into it"), "{out:?}");
    let r = w.answer(pending, asked as u32, &serde_json::to_string(&out)?).await?;
    ensure!(r.is_success(), "{}", jobs_sandbox::why(&r));
    let copy = w.view(mallory.id(), "get", json!({ "id": "bench-0003" })).await?;
    ensure!(copy["checked"] == false && copy["phase"] == "checking", "the copy stays unchecked: {copy}");
    // A verdict asked for the same id, as a contract that answers its views as it likes would: refused the same way.
    let verdict = json!({ "job": "bench-0003", "contract": mallory.id(), "kind": "tee_tests", "appeal": false, "prior": null });
    let out = answer(Some(verdict), &caller, &Secrets { tests: None, ..secrets_row }, &[&a, &b], &*kept);
    ensure!(out.error.as_deref() == Some("this judge serves only the jobs contract written into it"), "{out:?}");
    ensure!(kept.count("tests/") == 1, "nothing more was kept");
    println!("fake-jobs: a contract that is not ours copied bench-0003 and asked our judge twice: refused both times, nothing read or kept");
    Ok(())
}
