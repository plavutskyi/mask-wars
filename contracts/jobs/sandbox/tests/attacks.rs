//! The attacks on jobs, in a real sandbox: fuel farmed without an attempt, a contribution claimed by another mask, a
//! judge that is not the job's, a puppet army, a squatter on the slots, and a job the judge never decides.

use anyhow::{ensure, Result};
use jobs_sandbox::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

/// The client opens `id`: an AI review with 0.05 NEAR of fuel for each of `slots` masks.
async fn review(w: &World, id: &str, slots: u8) -> Result<serde_json::Value> {
    let r = w.open(id, "ai_review", 2 * ONE_NEAR, 50 * MILLI, slots, Some(REVIEW_V), None).await?;
    ensure!(r.is_success(), "open: {}", why(&r));
    w.pass_check(id).await
}

fn fails_with(r: &near_workspaces::result::ExecutionFinalResult, want: &str) -> bool {
    r.is_failure() && why(r).contains(want)
}

/// A mask takes a slot, its mind burns its whole cap, and it never shows any work. The job pays nothing for it: the
/// fuel goes back to the client, and the farmer gains nothing, since fuel never reaches a mask. It held a slot and
/// revealed nothing, so half its bond goes to the company.
#[tokio::test(flavor = "multi_thread")]
async fn fuel_farmed_without_an_attempt_is_not_paid_and_goes_back_to_the_client() -> Result<()> {
    let w = World::new(&build()?).await?;
    let id = "farm-0001";
    let job = review(&w, id, 3).await?;
    for m in [&w.farm, &w.onyx] {
        w.enlist(m, id).await?;
    }
    let onyx_work = boxed("review: ONYX's review");
    let o = w.seal(&w.onyx, id, &onyx_work).await?;

    // The farmer books fuel for its own mind: its job key cannot even call `burn`, and its owner's key is not the
    // meter's.
    let r = w.burn(&w.farm.on_jobs, id, &w.farm.id, 50 * MILLI).await;
    let refused = format!("{:?}", r.as_ref().err());
    ensure!(refused.contains("MethodNameMismatch"), "a mask's job key does not even reach burn: {refused}");
    let owner = w.worker.root_account()?;
    let r = w.burn(&owner, id, &w.farm.id, 50 * MILLI).await?;
    ensure!(fails_with(&r, "only the job's meter books fuel"), "{}", why(&r));
    // The meter books what the farmer's mind really burned: everything it may. Not a yocto more.
    w.burn(&w.meter, id, &w.farm.id, 50 * MILLI).await?.into_result()?;
    let r = w.burn(&w.meter, id, &w.farm.id, 1).await?;
    ensure!(fails_with(&r, "a mask burns at most fuel_per_mask on a job"), "{}", why(&r));
    w.burn(&w.meter, id, &w.onyx.id, 20 * MILLI).await?.into_result()?;

    w.wait_until(yocto(&job["terms"]["work_until"]) as u64).await?;
    w.reveal(&w.onyx, id, o, &onyx_work).await?.into_result()?;
    w.wait_until(yocto(&job["terms"]["reveal_until"]) as u64).await?;
    let (pending, index, _) = w.ask_judge(&w.client, id).await?;
    w.answer(pending, index, &verdict(id, Some(1), &[o])).await?.into_result()?;
    let job = w.job(id).await?;
    let fuel = w.view(&w.jobs, "fuel", json!({ "id": id })).await?;
    let farm_fuel = fuel.as_array().unwrap().iter().find(|f| f["mask"] == json!(w.farm.id)).cloned().unwrap();
    ensure!(farm_fuel["burned"] == "50000000000000000000000" && farm_fuel["covered"] == "0", "{farm_fuel}");
    w.wait_until(yocto(&job["verdict"]["at_ns"]) as u64 + 10 * MIN_NS).await?;
    let (farm, treasury, client) =
        (w.balance(&w.farm.id).await?, w.balance(w.treasury.id()).await?, w.balance(w.client.id()).await?);
    let company = w.balance(w.company.id()).await?;
    let (reserve, budget) = (yocto(&job["reserve"]), yocto(&job["judge_budget"]));
    let r = w.settle(&w.bob, id).await?;
    ensure!(r.is_success(), "settle: {}", why(&r));
    let event = settle_event(&r);
    let to_treasury = w.balance(w.treasury.id()).await? - treasury;
    let to_client = w.balance(w.client.id()).await? - client;
    ensure!(w.balance(&w.farm.id).await? == farm, "the farmer gets nothing");
    ensure!(to_treasury == 20 * MILLI, "NEAR AI is paid only for ONYX's real attempt: {}", n3(to_treasury));
    // 3 slots × 0.05 less ONYX's 0.02: the farmer's 0.05 comes back, with the storage the masks took.
    ensure!(to_client == yocto(&event["back"]) && to_client > 130 * MILLI + budget + reserve, "{}", n3(to_client));
    let farm_line = event["fuel"].as_array().unwrap().iter().find(|f| f["mask"] == json!(w.farm.id)).cloned();
    ensure!(farm_line.is_some_and(|f| f["covered"] == "0"), "the settle event shows the farmer's fuel uncovered");
    let fee = 2 * ONE_NEAR * 5 / 100;
    ensure!(w.balance(w.company.id()).await? - company == fee + 25 * MILLI, "the fee and half the farmer's bond");
    let farm_bond = bonds_of(&event).into_iter().find(|b| b.0 == w.farm.id.as_str()).unwrap();
    ensure!(farm_bond.2 == 25 * MILLI, "the farmer's idle seat costs half its bond: {event}");
    println!(
        "farmer burned 0.050 NEAR with no step: covered 0, NEAR AI got {} (ONYX), the client got {} back",
        n3(to_treasury),
        n3(to_client)
    );
    Ok(())
}

/// ONYX tries to take KIRA's finding as its own every way it can: copy the seal, reveal KIRA's step, seal the same
/// content later, slip into KIRA's crew. Nothing counts for ONYX, and the split pays KIRA.
#[tokio::test(flavor = "multi_thread")]
async fn a_mask_cannot_take_another_mask_s_contribution() -> Result<()> {
    let w = World::new(&build()?).await?;
    let id = "steal-0001";
    let job = review(&w, id, 4).await?;
    let members = json!([{ "mask": w.kira.id, "role": "scout" }, { "mask": w.nova.id, "role": "striker" }]);
    w.ann
        .call(&w.crews, "form")
        .args_json(
            json!({ "id": "duo", "members": members, "split": { "scout": 3000, "striker": 7000, "verifier": 0 } }),
        )
        .deposit(NearToken::from_millinear(100))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    w.nova
        .on_crews
        .call(&w.crews, "join")
        .args_json(json!({ "id": "duo", "version": 1 }))
        .transact()
        .await?
        .into_result()?;
    let r = w
        .ann
        .call(&w.crews, "join_for")
        .args_json(json!({ "id": "duo", "version": 1, "mask": w.kira.id }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    ensure!(r.json::<bool>()?);
    // ONYX cannot sit in the crew: it has no seat, and nobody but the crews contract hands a crew to a job.
    let r = w.onyx.on_crews.call(&w.crews, "join").args_json(json!({ "id": "duo", "version": 1 })).transact().await?;
    ensure!(fails_with(&r, "no seat for this mask"), "{}", why(&r));
    let members = json!([{ "mask": w.onyx.id, "role": "scout" }, { "mask": w.nova.id, "role": "striker" }]);
    let split = json!({ "scout": 3000, "striker": 7000, "verifier": 0 });
    let forged = json!({ "crew": "duo", "version": 1, "split": split, "members": members });
    let r = w.bob.call(&w.jobs, "enlist_crew").args_json(json!({ "id": id, "ticket": forged })).transact().await?;
    ensure!(fails_with(&r, "only the crews contract enlists a crew"), "{}", why(&r));
    w.bond_all(id, &[&w.kira, &w.nova]).await?;
    w.ann
        .call(&w.crews, "enlist")
        .args_json(json!({ "id": "duo", "jobs": w.jobs, "job": id }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    w.enlist(&w.onyx, id).await?;

    // KIRA's finding is a box for the judge. ONYX copies the box (it never sees what is inside) every way it can.
    let finding = boxed("finding: the proposal's quorum math divides before it multiplies");
    let finding = finding.as_str();
    let review_box = boxed("review: the quorum bug");
    let k = w.seal(&w.kira, id, finding).await?;
    let n = w.seal(&w.nova, id, &review_box).await?;
    // ONYX copies KIRA's seal off the chain into a step of its own.
    let steps = w.view(&w.jobs, "steps", json!({ "id": id })).await?;
    let kira_hash = steps[k as usize]["hash"].as_str().unwrap().to_string();
    let r = w.onyx.on_jobs.call(&w.jobs, "step").args_json(json!({ "id": id, "hash": kira_hash })).transact().await?;
    let copied = r.into_result()?.json::<serde_json::Value>()?["seq"].as_u64().unwrap() as u32;
    // And it seals the same text, as if it had heard it off chain, after KIRA.
    let later = w.seal(&w.onyx, id, finding).await?;

    w.wait_until(yocto(&job["terms"]["work_until"]) as u64).await?;
    let r =
        w.onyx.on_jobs.call(&w.jobs, "step").args_json(json!({ "id": id, "hash": "ab".repeat(32) })).transact().await?;
    ensure!(fails_with(&r, "the work window is over"), "{}", why(&r));
    // ONYX reveals KIRA's step itself: only the mask that sealed a step reveals it.
    let r = w.reveal(&w.onyx, id, k, finding).await?;
    ensure!(fails_with(&r, "only the mask that sealed a step reveals it"), "{}", why(&r));
    w.reveal(&w.kira, id, k, finding).await?.into_result()?;
    // The copied seal holds KIRA's name: no content under ONYX's name matches it.
    let r = w.reveal(&w.onyx, id, copied, finding).await?;
    ensure!(fails_with(&r, "this content and salt are not what was sealed"), "{}", why(&r));
    // The same text sealed later counts for KIRA's earlier seal only.
    let s: serde_json::Value = w.reveal(&w.onyx, id, later, finding).await?.into_result()?.json()?;
    ensure!(s["copy_of"] == k, "ONYX's step is KIRA's copy: {s}");
    w.reveal(&w.nova, id, n, &review_box).await?.into_result()?;

    w.wait_until(yocto(&job["terms"]["reveal_until"]) as u64).await?;
    // A judge that counted ONYX's copy would be wrong: the contract takes no such verdict.
    let (pending, index, _) = w.ask_judge(&w.bob, id).await?;
    w.answer(pending, index, &verdict(id, Some(0), &[k, n, later])).await?.into_result()?;
    ensure!(w.job(id).await?["status"]["state"] == "open", "a verdict on a copy decides nothing");
    let (pending, index, _) = w.ask_judge(&w.bob, id).await?;
    w.answer(pending, index, &verdict(id, Some(0), &[k, n])).await?.into_result()?;
    let job = w.job(id).await?;
    w.wait_until(yocto(&job["verdict"]["at_ns"]) as u64 + 10 * MIN_NS).await?;
    let (kira, onyx) = (w.balance(&w.kira.id).await?, w.balance(&w.onyx.id).await?);
    w.settle(&w.bob, id).await?.into_result()?;
    let net = 2 * ONE_NEAR - 2 * ONE_NEAR * 5 / 100;
    ensure!(w.balance(&w.kira.id).await? - kira == net * 3 / 10, "KIRA keeps the scout's 30%");
    ensure!(w.balance(&w.onyx.id).await? == onyx, "ONYX gets nothing");
    println!(
        "ONYX copied KIRA's seal, revealed KIRA's step, sealed KIRA's text later: refused, refused, copy; KIRA paid {}",
        n3(net * 3 / 10)
    );
    Ok(())
}

/// A judge that is not the job's decides nothing: the client cannot open with its own judge or its own bounty
/// contract, nobody calls the callbacks, an answer for another job changes nothing, and a new judge applies only to
/// jobs opened after it.
#[tokio::test(flavor = "multi_thread")]
async fn a_judge_that_is_not_the_job_s_decides_nothing() -> Result<()> {
    let w = World::new(&build()?).await?;
    // The client names a judge the contract does not serve this kind with.
    let r = w.open("judge-0000", "ai_review", 2 * ONE_NEAR, 50 * MILLI, 2, Some(TESTS_V), None).await?;
    ensure!(fails_with(&r, "the judge you agree to must be the contract's judge"), "{}", why(&r));
    let own = "f".repeat(64);
    let r = w.open("judge-0000", "ai_review", 2 * ONE_NEAR, 50 * MILLI, 2, Some(&own), None).await?;
    ensure!(fails_with(&r, "the judge you agree to must be the contract's judge"), "{}", why(&r));
    // A drain that follows a "bounty contract" of the client's own.
    let r = w
        .open(
            "judge-0000",
            "drain",
            2 * ONE_NEAR,
            50 * MILLI,
            2,
            None,
            Some(json!({ "bounty": w.bob.id(), "id": "r1" })),
        )
        .await?;
    ensure!(fails_with(&r, "a bounty contract this contract follows"), "{}", why(&r));

    let id = "judge-0001";
    let job = review(&w, id, 2).await?;
    w.enlist(&w.onyx, id).await?;
    let onyx_work = boxed("review: ONYX's review");
    let o = w.seal(&w.onyx, id, &onyx_work).await?;
    w.wait_until(yocto(&job["terms"]["work_until"]) as u64).await?;
    w.reveal(&w.onyx, id, o, &onyx_work).await?.into_result()?;
    w.wait_until(yocto(&job["terms"]["reveal_until"]) as u64).await?;

    // Nobody but the contract itself calls its callbacks.
    for method in ["on_judged", "on_round", "on_delivered"] {
        let r = w.bob.call(&w.jobs, method).args_json(json!({ "id": id, "run": 1 })).transact().await?;
        ensure!(fails_with(&r, "is private"), "{method}: {}", why(&r));
    }

    // OutLayer answers the job's run with a verdict on another job: nothing is decided.
    let (pending, index, _) = w.ask_judge(&w.bob, id).await?;
    w.answer(pending, index, &verdict("judge-9999", Some(0), &[o])).await?.into_result()?;
    let j = w.job(id).await?;
    ensure!(j["status"]["state"] == "open" && j["verdict"].is_null(), "{j}");

    // The admin moves ai_review to a new judge. The job keeps the one it opened with.
    let new = "9".repeat(64);
    w.admin
        .call(&w.jobs, "propose")
        .args_json(json!({ "change": { "kind": "judge", "judge":
            { "kind": "ai_review", "project": "maskwars.testnet/review", "version": new, "key": REVIEW_KEY } } }))
        .transact()
        .await?
        .into_result()?;
    let ready = yocto(&w.view(&w.jobs, "pending", json!({})).await?["ready_ns"]) as u64;
    w.wait_until(ready).await?;
    w.bob.call(&w.jobs, "apply").transact().await?.into_result()?;
    let (pending, index, request) = w.ask_judge(&w.bob, id).await?;
    let source: serde_json::Value = serde_json::from_str(request["source"].as_str().unwrap())?;
    ensure!(source["Project"]["version_key"] == REVIEW_V, "the job's run goes to its own judge: {source}");
    w.answer(pending, index, &verdict(id, Some(0), &[o])).await?.into_result()?;
    ensure!(w.job(id).await?["verdict"]["winner"] == 0);
    // A new job opens only with the new judge.
    let r = w.open("judge-0002", "ai_review", 2 * ONE_NEAR, 50 * MILLI, 2, Some(REVIEW_V), None).await?;
    ensure!(fails_with(&r, "the judge you agree to must be the contract's judge"), "{}", why(&r));
    let r = w.open("judge-0002", "ai_review", 2 * ONE_NEAR, 50 * MILLI, 2, Some(&new), None).await?;
    ensure!(r.is_success(), "{}", why(&r));
    let (_, _, request) = w.ask_check(&w.bob, "judge-0002").await?;
    let source: serde_json::Value = serde_json::from_str(request["source"].as_str().unwrap())?;
    ensure!(source["Project"]["version_key"] == json!(new), "the new job's check goes to the new judge: {source}");
    println!(
        "own judge, own bounty contract, forged callbacks, another job's verdict: refused; the open job kept {}…",
        &REVIEW_V[..8]
    );
    Ok(())
}

/// A puppet army: the client's own masks (ONYX and FARM) take slots next to the duo and reveal junk, hoping for a
/// part of the reward. The judge calls their steps fake: each loses its bond to the company, never to the winner
/// (third review, finding 2), so no puppet that wins could collect them either. The crew that did the work takes the
/// reward. The puppets' owner pays for the army and nobody profits from it.
#[tokio::test(flavor = "multi_thread")]
async fn a_puppet_army_loses_its_bonds_to_the_company_and_nobody_profits() -> Result<()> {
    let w = World::new(&build()?).await?;
    let id = "puppets-0001";
    let job = review(&w, id, 4).await?;
    form_duo(&w).await?;
    w.bond_all(id, &[&w.kira, &w.nova]).await?;
    w.ann
        .call(&w.crews, "enlist")
        .args_json(json!({ "id": "duo", "jobs": w.jobs, "job": id }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    let root = w.worker.root_account()?;
    w.enlist(&w.onyx, id).await?;
    w.enlist(&w.farm, id).await?;
    let (finding, review, junk_o, junk_f) =
        (boxed("finding: quorum math"), boxed("review: the quorum bug, with a fix"), boxed("lorem ipsum"), boxed("."));
    let k = w.seal(&w.kira, id, &finding).await?;
    let n = w.seal(&w.nova, id, &review).await?;
    let o = w.seal(&w.onyx, id, &junk_o).await?;
    let f = w.seal(&w.farm, id, &junk_f).await?;
    w.wait_until(yocto(&job["terms"]["work_until"]) as u64).await?;
    for (mask, seq, content) in
        [(&w.kira, k, &finding), (&w.nova, n, &review), (&w.onyx, o, &junk_o), (&w.farm, f, &junk_f)]
    {
        w.reveal(mask, id, seq, content).await?.into_result()?;
    }
    w.wait_until(yocto(&job["terms"]["reveal_until"]) as u64).await?;
    let (pending, index, _) = w.ask_judge(&w.bob, id).await?;
    w.answer(pending, index, &verdict_with_fakes(id, Some(0), &[k, n], &[o, f])).await?.into_result()?;
    let job = w.job(id).await?;
    ensure!(job["verdict"]["fake"] == json!([o, f]), "{job}");
    w.wait_until(yocto(&job["verdict"]["at_ns"]) as u64 + 10 * MIN_NS).await?;
    let ids = [&w.kira.id, &w.nova.id, &w.onyx.id, &w.farm.id, w.ann.id(), root.id(), w.company.id()];
    let mut before = vec![];
    for i in ids {
        before.push(w.balance(i).await?);
    }
    let r = w.settle(&w.bob, id).await?;
    ensure!(r.is_success(), "settle: {}", why(&r));
    let event = settle_event(&r);
    let mut got = vec![];
    for (i, a) in ids.iter().enumerate() {
        got.push(w.balance(a).await? as i128 - before[i] as i128);
    }
    let fee = 2 * ONE_NEAR * 5 / 100;
    let net = 2 * ONE_NEAR - fee;
    ensure!(
        got[0] == (net * 3 / 10) as i128 && got[1] == (net - net * 3 / 10) as i128,
        "the duo takes the reward, and no bond: {got:?}"
    );
    ensure!(got[2] == 0 && got[3] == 0, "the puppets get nothing");
    ensure!(got[4] == (50 * MILLI) as i128, "ANN gets KIRA's bond back");
    ensure!(got[5] == (50 * MILLI) as i128, "the root gets NOVA's bond back, not ONYX's or FARM's");
    ensure!(got[6] == (fee + 100 * MILLI) as i128, "the company: its fee and the puppets' two bonds");
    let lost: Vec<_> = bonds_of(&event).into_iter().filter(|b| b.2 == b.1).collect();
    ensure!(yocto(&event["forfeit"]) == 100 * MILLI && lost.len() == 2, "{event}");
    println!(
        "{id}: two puppets revealed junk, the judge called it fake: their 2 × 0.050 NEAR bonds went to the company, \
         not the winner; KIRA {} NEAR, NOVA {} NEAR",
        n3(got[0] as u128),
        n3(got[1] as u128)
    );
    Ok(())
}

/// A squatter (FARM) takes a slot of a full two-slot job next to ONYX, so NOVA cannot get in (third review, finding 6).
/// Before, leaving gave its whole bond back and kept the slot taken, and sitting to the end did too. Now FARM's leave
/// gives the slot back, at the cost of the share of the window it held; NOVA takes the slot and wins. ONYX sits on its
/// slot to the end and reveals nothing: half its bond goes to the company.
#[tokio::test(flavor = "multi_thread")]
async fn a_squatter_pays_for_the_slot_it_holds_and_leaving_gives_it_back() -> Result<()> {
    let w = World::new(&build()?).await?;
    let id = "squat-0001";
    let job = review(&w, id, 2).await?;
    w.enlist(&w.farm, id).await?;
    w.enlist(&w.onyx, id).await?;
    let r = w.bond(&w.worker.root_account()?, id, &w.nova.id).await?;
    ensure!(r.is_success(), "NOVA's owner may lock a bond: {}", why(&r));
    let r = w.nova.on_jobs.call(&w.jobs, "enlist").args_json(json!({ "id": id })).transact().await?;
    ensure!(fails_with(&r, "no slot left"), "the job is full: {}", why(&r));
    let company = w.balance(w.company.id()).await?;
    let r = w.farm.on_jobs.call(&w.jobs, "leave").args_json(json!({ "id": id })).transact().await?;
    ensure!(r.is_success(), "leave: {}", why(&r));
    let (back, lost) = left_of(&r).expect("a leave event");
    ensure!(back + lost == 50 * MILLI && lost > 0 && lost < 25 * MILLI, "held a few seconds of five minutes: {lost}");
    ensure!(w.balance(w.company.id()).await? - company == lost, "what holding the slot cost goes to the company");
    let v = w.job(id).await?;
    ensure!(v["masks"] == 1 && v["left"] == 1, "the slot came back: {v}");
    let r = w.nova.on_jobs.call(&w.jobs, "enlist").args_json(json!({ "id": id })).transact().await?;
    ensure!(r.json::<u32>()? == 2, "NOVA takes the slot FARM gave back");
    let review_ = boxed("review: the quorum bug, with a fix");
    let n = w.seal(&w.nova, id, &review_).await?;
    w.wait_until(yocto(&job["terms"]["work_until"]) as u64).await?;
    let r = w.onyx.on_jobs.call(&w.jobs, "leave").args_json(json!({ "id": id })).transact().await?;
    ensure!(fails_with(&r, "the work window is over"), "ONYX cannot slip out after the window: {}", why(&r));
    w.reveal(&w.nova, id, n, &review_).await?.into_result()?;
    w.wait_until(yocto(&job["terms"]["reveal_until"]) as u64).await?;
    let (pending, index, _) = w.ask_judge(&w.bob, id).await?;
    w.answer(pending, index, &verdict(id, Some(2), &[n])).await?.into_result()?;
    let job = w.job(id).await?;
    w.wait_until(yocto(&job["verdict"]["at_ns"]) as u64 + 10 * MIN_NS).await?;
    let root = w.worker.root_account()?;
    let (company, owner) = (w.balance(w.company.id()).await?, w.balance(root.id()).await?);
    let r = w.settle(&w.bob, id).await?;
    ensure!(r.is_success(), "settle: {}", why(&r));
    let event = settle_event(&r);
    let fee = 2 * ONE_NEAR * 5 / 100;
    ensure!(w.balance(w.company.id()).await? - company == fee + 25 * MILLI, "the fee and half ONYX's bond");
    ensure!(w.balance(root.id()).await? - owner == 50 * MILLI + 25 * MILLI, "NOVA's bond, the other half of ONYX's");
    let onyx = bonds_of(&event).into_iter().find(|b| b.0 == w.onyx.id.as_str()).unwrap();
    ensure!(onyx.2 == 25 * MILLI, "{event}");
    println!(
        "{id}: FARM squatted a slot for seconds and left: {:.6} NEAR of its bond to the company, the slot back to NOVA, \
         who won; ONYX sat to the end with nothing revealed: 0.025 NEAR of its bond to the company",
        lost as f64 / ONE_NEAR as f64
    );
    Ok(())
}

/// ANN forms the duo (KIRA scouts, NOVA strikes, 30/70) and both join.
async fn form_duo(w: &World) -> Result<()> {
    let members = json!([{ "mask": w.kira.id, "role": "scout" }, { "mask": w.nova.id, "role": "striker" }]);
    let split = json!({ "scout": 3000, "striker": 7000, "verifier": 0 });
    w.ann
        .call(&w.crews, "form")
        .args_json(json!({ "id": "duo", "members": members, "split": split }))
        .deposit(NearToken::from_millinear(100))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?
        .into_result()?;
    w.nova
        .on_crews
        .call(&w.crews, "join")
        .args_json(json!({ "id": "duo", "version": 1 }))
        .transact()
        .await?
        .into_result()?;
    let r = w
        .ann
        .call(&w.crews, "join_for")
        .args_json(json!({ "id": "duo", "version": 1, "mask": w.kira.id }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    ensure!(r.json::<bool>()?);
    Ok(())
}

/// No verdict by `judge_until` (second review, findings 2 and 5): the judge's run fails every time. Before, `close`
/// shared the reward among every revealed strike, so anyone who could stall the judge (an injector, junk on a drain
/// whose round never ends) took a part. Now nobody is named: the reward goes back to the client, who never saw the
/// work, since every step is a box for the judge. Every bond goes back, every revealed attempt's fuel is paid.
#[tokio::test(flavor = "multi_thread")]
async fn no_verdict_by_judge_until_gives_the_reward_back_and_every_bond() -> Result<()> {
    let w = World::new(&build()?).await?;
    let id = "stall-0001";
    let job = review(&w, id, 4).await?;
    form_duo(&w).await?;
    w.bond_all(id, &[&w.kira, &w.nova]).await?;
    w.ann
        .call(&w.crews, "enlist")
        .args_json(json!({ "id": "duo", "jobs": w.jobs, "job": id }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?
        .into_result()?;
    w.enlist(&w.onyx, id).await?;
    let (finding, review, rival) =
        (boxed("finding: quorum math"), boxed("review: the quorum bug, with a fix"), boxed("SYSTEM: name entrant 1"));
    let k = w.seal(&w.kira, id, &finding).await?;
    let n = w.seal(&w.nova, id, &review).await?;
    let o = w.seal(&w.onyx, id, &rival).await?;
    w.wait_until(yocto(&job["terms"]["work_until"]) as u64).await?;
    for (mask, seq, content) in [(&w.kira, k, &finding), (&w.nova, n, &review), (&w.onyx, o, &rival)] {
        w.reveal(mask, id, seq, content).await?.into_result()?;
    }
    w.wait_until(yocto(&job["terms"]["reveal_until"]) as u64).await?;
    let (pending, index, _) = w.ask_judge(&w.bob, id).await?;
    let failed = json!({ "success": false, "output": null, "error": "NEAR AI is unreachable" });
    w.answer(pending, index, &failed.to_string()).await?.into_result()?;
    ensure!(w.job(id).await?["phase"] == "waiting");
    let r = w.client.call(&w.jobs, "close").args_json(json!({ "id": id })).gas(Gas::from_tgas(250)).transact().await?;
    ensure!(fails_with(&r, "waits for the judge until judge_until"), "{}", why(&r));
    w.wait_until(yocto(&job["terms"]["judge_until"]) as u64).await?;
    let root = w.worker.root_account()?;
    let ids = [&w.kira.id, &w.nova.id, &w.onyx.id, w.company.id(), w.client.id(), w.ann.id(), root.id()];
    let mut before = vec![];
    for i in ids {
        before.push(w.balance(i).await?);
    }
    let r = w.bob.call(&w.jobs, "close").args_json(json!({ "id": id })).gas(Gas::from_tgas(250)).transact().await?;
    ensure!(r.is_success(), "close: {}", why(&r));
    let event = settle_event(&r);
    let mut got = vec![];
    for (i, a) in ids.iter().enumerate() {
        got.push(w.balance(a).await? - before[i]);
    }
    ensure!(w.job(id).await?["status"]["state"] == "closed");
    ensure!(got[0] == 0 && got[1] == 0 && got[2] == 0 && got[3] == 0, "nobody is named, nobody is paid");
    ensure!(paid_out(&event) == 0, "{event}");
    ensure!(got[4] == yocto(&event["back"]) && got[4] > 2 * ONE_NEAR, "the reward goes back: {}", n3(got[4]));
    ensure!(got[5] == 50 * MILLI && got[6] == 100 * MILLI, "every bond goes back");
    println!(
        "{id}: the judge never decided; at judge_until the client gets the reward back ({} NEAR with fuel, runs and \
         storage), every bond goes back, the injector ONYX gets nothing",
        n3(got[4])
    );
    Ok(())
}
