//! A crew takes a job on its client's fuel, each mask on a bond its owner locked; the work is sealed for the judge, the
//! judge decides, the reward splits by contribution, every bond and every unused yocto goes back, and only then does
//! the client get the winning work, sealed for its own key. Then a drain job follows a sealed round of the bounty
//! contract.

use anyhow::{ensure, Result};
use jobs_sandbox::*;
use near_workspaces::types::{Gas, NearToken};
use serde_json::{json, Value};

const ID: &str = "review-0001";

/// ANN forms the duo (KIRA scouts, NOVA strikes, 30/70); NOVA joins with its own key, ANN joins for KIRA on the
/// factory's word; each mask's owner locks its bond on the job; ANN enlists the crew in `job`.
async fn duo_on(w: &World, job: &str) -> Result<()> {
    let members = json!([{ "mask": w.kira.id, "role": "scout" }, { "mask": w.nova.id, "role": "striker" }]);
    let r = w
        .ann
        .call(&w.crews, "form")
        .args_json(
            json!({ "id": "duo", "members": members, "split": { "scout": 3000, "striker": 7000, "verifier": 0 } }),
        )
        .deposit(NearToken::from_millinear(100))
        .gas(Gas::from_tgas(50))
        .transact()
        .await?;
    ensure!(r.is_success(), "form: {}", why(&r));
    let r = w.nova.on_crews.call(&w.crews, "join").args_json(json!({ "id": "duo", "version": 1 })).transact().await?;
    ensure!(r.is_success(), "NOVA joins: {}", why(&r));
    let r = w
        .ann
        .call(&w.crews, "join_for")
        .args_json(json!({ "id": "duo", "version": 1, "mask": w.kira.id }))
        .gas(Gas::from_tgas(60))
        .transact()
        .await?;
    let logs = format!("{:?}", r.logs());
    ensure!(r.json::<bool>()?, "ANN joins for KIRA: {logs}");
    let crew = w.view(&w.crews, "get_crew", json!({ "id": "duo" })).await?;
    ensure!(crew["ready"] == json!(true), "every seat joined: {crew}");
    w.bond_all(job, &[&w.kira, &w.nova]).await?;
    let r = w
        .ann
        .call(&w.crews, "enlist")
        .args_json(json!({ "id": "duo", "jobs": w.jobs, "job": job }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?;
    let failed = why(&r);
    ensure!(r.json::<Option<u32>>()? == Some(0), "the crew is entrant 0: {failed}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crew_takes_a_job_on_fuel_and_splits_the_reward_by_contribution() -> Result<()> {
    let w = World::new(&build()?).await?;
    ensure!(w.keys(&w.jobs).await? == 0 && w.keys(&w.crews).await? == 0, "nobody holds a key to either contract");

    // 1. The client opens a review job: 3 NEAR for the work, 0.05 NEAR of fuel for each of 4 masks.
    let r = w.open(ID, "ai_review", 3 * ONE_NEAR, 50 * MILLI, 4, Some(REVIEW_V), None).await?;
    ensure!(r.is_success(), "open: {}", why(&r));
    ensure!(w.job(ID).await?["phase"] == "checking", "no mask starts before the judge checks the material");
    let r = w.onyx.on_jobs.call(&w.jobs, "enlist").args_json(json!({ "id": ID })).transact().await?;
    ensure!(r.is_failure() && why(&r).contains("the judge has not passed"), "{}", why(&r));
    // The judge checks the rubric and the spec by their hashes before anyone starts: the work window starts now.
    let job = w.pass_check(ID).await?;
    let terms = &job["terms"];
    ensure!(terms["judge"]["version"] == REVIEW_V, "the job pins its judge");
    println!(
        "{ID} opened: reward {} NEAR, fuel {} NEAR × {} masks, judge {}…",
        n3(yocto(&terms["reward"])),
        n3(yocto(&terms["fuel_per_mask"])),
        terms["slots"],
        &REVIEW_V[..8]
    );

    // 2. Two masks of a crew take it, and ONYX alone. Every mask takes the job on a bond its owner locked: ONYX's own
    //    key cannot attach NEAR, and without a bond it cannot enlist.
    duo_on(&w, ID).await?;
    let r = w.onyx.on_jobs.call(&w.jobs, "enlist").args_json(json!({ "id": ID })).transact().await?;
    ensure!(r.is_failure() && why(&r).contains("a bond locked for it first"), "{}", why(&r));
    ensure!(w.enlist(&w.onyx, ID).await? == 1, "ONYX is entrant 1");
    let bond = w.view(&w.jobs, "bond_of", json!({ "id": ID, "mask": w.onyx.id })).await?;
    ensure!(bond["enlisted"] == true && yocto(&bond["amount"]) == 50 * MILLI, "the bond sits on ONYX's seat: {bond}");
    let entrants = w.view(&w.jobs, "entrants", json!({ "id": ID })).await?;
    ensure!(entrants[0]["split"] == json!({ "scout": 3000, "striker": 7000, "verifier": 0 }), "{entrants}");

    // 3. Each mask seals its own steps with its job key; the meter books what each mind burned. The work itself is a
    //    box for the judge's key: the client and the other masks see only ciphertext, on chain and after.
    let finding = boxed("finding: section 4 checks the quorum before it counts abstentions");
    let review = boxed("review: section 4 lets abstentions meet quorum; fix: count yes and no only");
    let rival = boxed("review: no quorum bug");
    let (finding, review, rival) = (finding.as_str(), review.as_str(), rival.as_str());
    let k = w.seal(&w.kira, ID, finding).await?;
    let n = w.seal(&w.nova, ID, review).await?;
    let o = w.seal(&w.onyx, ID, rival).await?;
    for (mask, burned) in [(&w.kira.id, 30), (&w.nova.id, 40), (&w.onyx.id, 50)] {
        let r = w.burn(&w.meter, ID, mask, burned * MILLI).await?;
        ensure!(r.is_success(), "burn: {}", why(&r));
    }

    // 4. The work window closes: the steps are revealed, each as its box. Plain text is refused.
    w.wait_until(yocto(&terms["work_until"]) as u64).await?;
    let r = w.reveal(&w.onyx, ID, o, "review: no quorum bug").await?;
    ensure!(r.is_failure() && why(&r).contains("no work is revealed in the open"), "{}", why(&r));
    for (mask, seq, content) in [(&w.kira, k, finding), (&w.nova, n, review), (&w.onyx, o, rival)] {
        let r = w.reveal(mask, ID, seq, content).await?;
        ensure!(r.is_success(), "reveal: {}", why(&r));
    }

    // 5. The reveal window closes: anyone asks the judge, at the version the job pinned.
    w.wait_until(yocto(&terms["reveal_until"]) as u64).await?;
    let (pending, index, request) = w.ask_judge(&w.bob, ID).await?;
    let source: Value = serde_json::from_str(request["source"].as_str().unwrap())?;
    ensure!(source["Project"]["version_key"] == REVIEW_V, "{source}");
    let input: Value = serde_json::from_str(request["input"].as_str().unwrap())?;
    ensure!(
        input
            == json!({ "job": ID, "contract": w.jobs, "kind": "ai_review", "appeal": false, "prior": null, "check": false,
                      "deliver": false })
    );
    ensure!(request["secrets"].is_null(), "after the check no run names the client's secrets");
    // The judge module reads the job from the chain, as the real one does: three revealed boxes, two entrants.
    let steps = w.view(&w.jobs, "steps", json!({ "id": ID })).await?;
    ensure!(steps
        .as_array()
        .unwrap()
        .iter()
        .all(|s| s["content"].as_str().is_some_and(|c| c.starts_with("mw1.")) && s["copy_of"].is_null()));
    // NOVA's review wins; every step is a real attempt, ONYX's too.
    let r = w.answer(pending, index, &verdict(ID, Some(0), &[k, n, o])).await?;
    ensure!(r.is_success(), "judge: {}", why(&r));
    let job = w.job(ID).await?;
    ensure!(job["status"]["state"] == "decided" && job["verdict"]["winner"] == 0, "{job}");

    // Before it pays, the job shows what it will cover: every real attempt's fuel.
    let fuel = w.view(&w.jobs, "fuel", json!({ "id": ID })).await?;
    for f in fuel.as_array().unwrap() {
        ensure!(f["covered"] == f["burned"], "every real attempt's fuel is covered: {f}");
    }

    // Nobody gets the work before the job is paid, the client included.
    let r = w
        .client
        .call(&w.jobs, "deliver")
        .args_json(json!({ "id": ID }))
        .deposit(near(10 * MILLI))
        .gas(Gas::from_tgas(250))
        .transact()
        .await?;
    ensure!(r.is_failure() && why(&r).contains("once the job is paid"), "{}", why(&r));

    // 6. The appeal window passes: anyone settles.
    let at = yocto(&job["verdict"]["at_ns"]) as u64 + 10 * MIN_NS;
    w.wait_until(at).await?;
    let root = w.worker.root_account()?;
    let ids =
        [&w.kira.id, &w.nova.id, &w.onyx.id, w.company.id(), w.treasury.id(), w.client.id(), w.ann.id(), root.id()];
    let mut before = vec![];
    for id in ids {
        before.push(w.balance(id).await?);
    }
    let (reserve, budget) = (yocto(&job["reserve"]), yocto(&job["judge_budget"]));
    let r = w.settle(&w.bob, ID).await?;
    ensure!(r.is_success(), "settle: {}", why(&r));
    let event = settle_event(&r);
    let gas = r.total_gas_burnt.as_tgas();
    let mut got = vec![];
    for (i, id) in ids.iter().enumerate() {
        got.push(w.balance(id).await? - before[i]);
    }
    let fee = 3 * ONE_NEAR * 5 / 100;
    let net = 3 * ONE_NEAR - fee;
    // The client gets the fuel nobody burned, the judge runs left, the reserve left and the storage the masks took.
    let base = 4 * 50 * MILLI - 120 * MILLI + budget + reserve;
    let back = yocto(&event["back"]);
    ensure!(back > base, "the masks' storage comes back too: {} over {}", n3(back), n3(base));
    ensure!(got[0] == net * 3 / 10, "KIRA, the scout, takes 30%: {}", n3(got[0]));
    ensure!(got[1] == net - net * 3 / 10, "NOVA, the striker, takes 70%: {}", n3(got[1]));
    ensure!(got[2] == 0, "ONYX lost");
    ensure!(got[3] == fee, "the company's 5%");
    ensure!(got[4] == 120 * MILLI, "the fuel of three real attempts goes to NEAR AI: {}", n3(got[4]));
    ensure!(got[5] == back, "the client gets back {} and got {}", n3(back), n3(got[5]));
    ensure!(
        got[6] == 50 * MILLI && got[7] == 100 * MILLI,
        "every bond goes back to its owner: ANN {}, root {}",
        n3(got[6]),
        n3(got[7])
    );
    ensure!(bonds_of(&event).iter().all(|(_, b, lost)| *b == 50 * MILLI && *lost == 0), "{event}");
    let job = w.job(ID).await?;
    ensure!(job["status"] == json!({ "state": "paid", "winner": 0 }), "{job}");
    let steps = w.view(&w.jobs, "steps", json!({ "id": ID })).await?;
    ensure!(steps.as_array().unwrap().is_empty(), "the job's steps are cleared, their storage back with the client");
    println!(
        "duo won {ID}: KIRA (scout) {} NEAR, NOVA (striker) {} NEAR, company {} NEAR; settle burned {gas} TGas",
        n3(got[0]),
        n3(got[1]),
        n3(got[3])
    );
    println!(
        "fuel: KIRA 0.030, NOVA 0.040, ONYX 0.050 → NEAR AI {} NEAR; back to the client {} NEAR \
         (unburned and empty-slot fuel 0.080, judge runs {}, storage {}); bonds 3 × 0.050 back to their owners",
        n3(got[4]),
        n3(got[5]),
        n3(budget),
        n3(got[5] - 80 * MILLI - budget)
    );

    // 7. Now the client asks for the work: the judge seals the winner's work for the client's key, and nobody else's.
    let (pending, index, request) = w.ask_delivery(&w.client, ID).await?;
    let input: Value = serde_json::from_str(request["input"].as_str().unwrap())?;
    ensure!(input["deliver"] == true && request["secrets"].is_null(), "{request}");
    let at = format!("delivery/{}/{ID}", w.jobs);
    let answer =
        json!({ "success": true, "output": { "job": ID, "delivered": at, "sha256": "ab".repeat(32) }, "error": null });
    let r = w.answer(pending, index, &answer.to_string()).await?;
    let delivered = r
        .logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .find(|e| e["event"] == "deliver")
        .map(|e| e["data"].clone())
        .unwrap_or(Value::Null);
    ensure!(delivered["at"] == json!(at) && delivered["key"] == CLIENT_KEY, "{delivered}");
    println!("{ID} paid, then delivered: the winning work sealed for the client's key at {at}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_drain_job_follows_its_round_and_pays_the_striker_s_crew() -> Result<()> {
    let w = World::new(&build()?).await?;
    let id = "drain-0001";
    let round = json!({ "owner": w.client.id(), "amount": "1000000000000000000000000", "target": "safe.test.near",
                        "deadline_ns": "0", "status": { "state": "open" } });
    w.bounty
        .call(w.bounty.id(), "set_round")
        .args_json(json!({ "id": "live-0007", "bounty": round }))
        .transact()
        .await?
        .into_result()?;
    let r = w
        .open(
            id,
            "drain",
            2 * ONE_NEAR,
            50 * MILLI,
            4,
            None,
            Some(json!({ "bounty": w.bounty.id(), "id": "live-0007" })),
        )
        .await?;
    ensure!(r.is_success(), "open: {}", why(&r));
    duo_on(&w, id).await?;
    let job = w.job(id).await?;
    let k = w.seal(&w.kira, id, "recon: set_owner is open to the round's masks").await?;
    let n = w.seal(&w.nova, id, "plan: set_owner, sweep 1 NEAR").await?;
    w.burn(&w.meter, id, &w.nova.id, 20 * MILLI).await?.into_result()?;
    w.wait_until(yocto(&job["terms"]["work_until"]) as u64).await?;
    w.reveal(&w.kira, id, k, "recon: set_owner is open to the round's masks").await?.into_result()?;
    w.reveal(&w.nova, id, n, "plan: set_owner, sweep 1 NEAR").await?.into_result()?;
    w.wait_until(yocto(&job["terms"]["reveal_until"]) as u64).await?;
    let judge = |w: &World| {
        let bob = w.bob.clone();
        let jobs = w.jobs.clone();
        async move { bob.call(&jobs, "judge").args_json(json!({ "id": id })).gas(Gas::from_tgas(250)).transact().await }
    };
    // The round is still open: the job waits for it.
    judge(&w).await?.into_result()?;
    ensure!(w.job(id).await?["status"]["state"] == "open");
    // NOVA drained the safe and the bounty contract paid it: the duo wins the job, final at once.
    let status = json!({ "state": "drained", "winner": w.nova.id, "tx_hash": "4AiB…" });
    let drained = json!({ "owner": w.client.id(), "amount": "1000000000000000000000000", "target": "safe.test.near",
                          "deadline_ns": "0", "status": status });
    w.bounty
        .call(w.bounty.id(), "set_round")
        .args_json(json!({ "id": "live-0007", "bounty": drained }))
        .transact()
        .await?
        .into_result()?;
    judge(&w).await?.into_result()?;
    let job = w.job(id).await?;
    ensure!(job["verdict"]["winner"] == 0 && job["verdict"]["final"] == true, "{job}");
    let (kira, nova) = (w.balance(&w.kira.id).await?, w.balance(&w.nova.id).await?);
    w.settle(&w.bob, id).await?.into_result()?;
    let net = 2 * ONE_NEAR - 2 * ONE_NEAR * 5 / 100;
    ensure!(w.balance(&w.kira.id).await? - kira == net * 3 / 10);
    ensure!(w.balance(&w.nova.id).await? - nova == net - net * 3 / 10);
    println!(
        "{id} followed live-0007: NOVA drained the safe, the duo split the crew pool: KIRA {} NEAR, NOVA {} NEAR",
        n3(net * 3 / 10),
        n3(net - net * 3 / 10)
    );
    Ok(())
}
