//! The safe 1.7.0 against the code the vault runs on mainnet, on one real local node: the same calls, in the same
//! order, give the same answers, the same panics, the same events and the same transfers. 1.6.0 added two views, `about`
//! and a `contract_source_metadata` that names its source (NEP-330); 1.7.0 adds the safe's kind (`variant` at `new`)
//! with the desks of the two new kinds and three views. A safe that names no kind, as the house's vault does, is of
//! the `owner` kind: `set_owner`, `sweep`, `arm`, `queue`, `retire` and `reclaim` must not change by a byte of
//! behaviour.
//!
//! The mainnet code is the file the house deploys today: `apps/web/public/contracts/maskwars-live-safe-<sha256>.wasm`
//! for `safe_code` of packages/network/mainnet.json. The new code is this source's build. Each runs on its own fresh
//! node with the same accounts, so what each safe says can be compared as it is; only the block times in the events,
//! which no two runs share, are read as offsets from the moment the commit window closes.
//!
//! The bounty contract here is a plain account that arms the safe and tells it the seals, as the real one does; the
//! rounds with the real bounty contract, the judge and `retire` after a round run on the new code in tests/retire.rs
//! and tests/house.rs.

use anyhow::{Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, AccountId, Worker};
use race_runner::round::{code_hash, sandbox};
use race_runner::{build_targets, wasm_dir, workspace_root};
use serde_json::{json, Value};
use std::sync::Once;

/// A mask's turn on the safe, ns (`TURN_NS` in live-safe).
const TURN_NS: i128 = 3 * 60 * 1_000_000_000;

fn built() {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| build_targets().expect("build wasm"));
}

/// The code the vault runs on mainnet: the file the repository serves under the sha256 that `safe_code` names.
fn mainnet_safe() -> Result<Vec<u8>> {
    let net: Value =
        serde_json::from_str(&std::fs::read_to_string(workspace_root().join("../../packages/network/mainnet.json"))?)?;
    let code = net["safe_code"].as_str().context("safe_code of mainnet.json")?;
    let dir = workspace_root().join("../../apps/web/public/contracts");
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        if name.starts_with("maskwars-live-safe-") {
            let wasm = std::fs::read(&path)?;
            if code_hash(&wasm) == code {
                return Ok(wasm);
            }
        }
    }
    anyhow::bail!("no file in {} is the code {code}", dir.display())
}

/// Every exported function of a wasm module, by name.
fn exports(wasm: &[u8]) -> Vec<String> {
    let mut out = vec![];
    let mut at = 8;
    let leb = |at: &mut usize| {
        let (mut n, mut shift) = (0u64, 0);
        loop {
            let b = wasm[*at];
            *at += 1;
            n |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return n as usize;
            }
            shift += 7;
        }
    };
    while at < wasm.len() {
        let id = wasm[at];
        at += 1;
        let size = leb(&mut at);
        let end = at + size;
        if id == 7 {
            let mut p = at;
            for _ in 0..leb(&mut p) {
                let len = leb(&mut p);
                let name = String::from_utf8_lossy(&wasm[p..p + len]).to_string();
                p += len;
                let kind = wasm[p];
                p += 1;
                leb(&mut p);
                if kind == 0 {
                    out.push(name);
                }
            }
        }
        at = end;
    }
    out.sort();
    out
}

/// What one run of the script saw: one line per call or view.
struct Run {
    worker: Worker<Sandbox>,
    safe: AccountId,
    lines: Vec<String>,
    /// The end of the commit window: the events' times are read from it.
    opens_ns: u64,
}

impl Run {
    /// A line as both runs can say it: the safe's own name and the block times read relative to the window.
    fn note(&mut self, what: &str, text: String) {
        let line = format!("{}: {}", self.plain(what, false), self.plain(&text, true));
        self.lines.push(line);
    }

    /// `text` with the safe's name as `<safe>` and every number of 19 digits, a time in ns, as the window plus whole
    /// turns where it is one (a slot's bounds), or else as `<time>`, which no two runs share; with `balances`, every number of 22 digits or more, a balance in yoctoNEAR, as `<yocto>`: each safe
    /// paid its own deploy, so what it holds differs by that gas. The amounts a call asks for are kept as they are.
    fn plain(&self, text: &str, balances: bool) -> String {
        let text = text.replace(self.safe.as_str(), "<safe>");
        let mut out = String::new();
        let mut digits = String::new();
        for c in text.chars().chain(std::iter::once(' ')) {
            if c.is_ascii_digit() {
                digits.push(c);
                continue;
            }
            if digits.len() == 19 {
                // A slot's bounds are the window plus whole turns; any other time is the block's own.
                let from = digits.parse::<i128>().unwrap_or_default() - self.opens_ns as i128;
                if from % TURN_NS == 0 {
                    out.push_str(&format!("<window{:+} turns>", from / TURN_NS));
                } else {
                    out.push_str("<time>");
                }
            } else if balances && digits.len() >= 22 {
                out.push_str("<yocto>");
            } else {
                out.push_str(&digits);
            }
            digits.clear();
            out.push(c);
        }
        out.trim_end().to_string()
    }

    fn outcome(&mut self, what: &str, r: &ExecutionFinalResult) {
        let logs: Vec<String> = r.logs().iter().map(|l| l.to_string()).collect();
        let failures: Vec<String> = r
            .failures()
            .iter()
            .map(|f| {
                let t = format!("{:?}", (*f).clone().into_result());
                // The panic's own words, without the receipt ids and the gas that differ between runs.
                t.split("Smart contract panicked: ")
                    .nth(1)
                    .map_or(t.clone(), |p| p.split('"').next().unwrap_or(p).to_string())
            })
            .collect();
        self.note(what, format!("ok={} logs={logs:?} failed={failures:?}", r.is_success()));
    }

    async fn call(&mut self, who: &Account, method: &str, args: Value) -> Result<()> {
        let r = who.call(&self.safe, method).args_json(args.clone()).max_gas().transact().await?;
        self.outcome(&format!("{} {method} {args}", who.id()), &r);
        Ok(())
    }

    async fn view(&mut self, method: &str, args: Value) -> Result<()> {
        let v: Value = match self.worker.view(&self.safe, method).args_json(args.clone()).await {
            Ok(r) => r.json()?,
            Err(e) => json!(format!("{e}").split("Smart contract panicked: ").nth(1).unwrap_or("error").to_string()),
        };
        self.note(&format!("view {method} {args}"), v.to_string());
        Ok(())
    }
}

/// The script, on a fresh node, with the safe running `wasm`. The accounts are named the same on both nodes.
async fn script(wasm: &[u8]) -> Result<Vec<String>> {
    let (_node, worker) = sandbox().await?;
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
    let (team, arbiter, nova, onyx, stranger) = (
        sub("team", 20).await?,
        sub("arbiter", 10).await?,
        sub("nova", 10).await?,
        sub("onyx", 10).await?,
        sub("stranger", 10).await?,
    );
    let masks = json!([nova.id(), onyx.id()]);

    // A safe of a round, deployed by itself with `new` in one go: it drops the key that deployed it.
    let safe = sub("safe", 5).await?;
    let made = safe
        .batch(safe.id())
        .deploy(wasm)
        .call(
            near_workspaces::operations::Function::new("new")
                .args_json(json!({ "owner": safe.id(), "masks": masks, "arbiter": arbiter.id(), "team": team.id() })),
        )
        .transact()
        .await?;
    let mut run = Run { worker: worker.clone(), safe: safe.id().clone(), lines: vec![], opens_ns: 0 };
    run.outcome("deploy and new", &made);
    run.note("keys", format!("{}", worker.view_access_keys(safe.id()).await?.len()));
    for (method, args) in [
        ("get_owner", json!({})),
        ("masks", json!({})),
        ("team", json!({})),
        ("arbiter", json!({})),
        ("get_round", json!({})),
    ] {
        run.view(method, args).await?;
    }

    // Before the round: nobody gets in.
    run.call(&stranger, "set_owner", json!({ "new_owner": stranger.id() })).await?;
    run.call(&nova, "set_owner", json!({ "new_owner": nova.id() })).await?;
    run.call(&nova, "sweep", json!({ "to": nova.id(), "amount": NearToken::from_near(1).as_yoctonear().to_string() }))
        .await?;
    run.call(&team, "reclaim", json!({})).await?;

    // The round: armed by its bounty contract only, for its own team and masks, with the window 40 s from now.
    run.opens_ns = worker.view_block().await?.timestamp() + 40_000_000_000;
    let arm = |team: &AccountId, masks: Value| json!({ "bounty": "race-0001", "opens_ns": run.opens_ns.to_string(), "masks": masks, "team": team });
    let (arm_stranger, arm_wrong_team, arm_ok) =
        (arm(team.id(), masks.clone()), arm(stranger.id(), masks.clone()), arm(team.id(), masks.clone()));
    run.call(&stranger, "arm", arm_stranger).await?;
    run.call(&arbiter, "arm", arm_wrong_team).await?;
    run.call(&arbiter, "arm", arm_ok.clone()).await?;
    run.call(&arbiter, "arm", arm_ok).await?;
    run.call(&stranger, "queue", json!({ "bounty": "race-0001", "mask": nova.id(), "seq": 0 })).await?;
    run.call(&arbiter, "queue", json!({ "bounty": "race-0002", "mask": nova.id(), "seq": 0 })).await?;
    run.call(&arbiter, "queue", json!({ "bounty": "race-0001", "mask": nova.id(), "seq": 0 })).await?;
    run.call(&arbiter, "queue", json!({ "bounty": "race-0001", "mask": nova.id(), "seq": 1 })).await?;
    run.call(&arbiter, "queue", json!({ "bounty": "race-0001", "mask": onyx.id(), "seq": 1 })).await?;
    run.view("get_round", json!({})).await?;
    run.view("get_queue", json!({})).await?;
    run.call(&nova, "set_owner", json!({ "new_owner": nova.id() })).await?;

    // The window closes: seal #0 plays first, its whole turn, and the planted hole is there for it.
    while worker.view_block().await?.timestamp() < run.opens_ns {
        worker.fast_forward(10).await?;
    }
    run.view("waits_for", json!({ "account_id": onyx.id() })).await?;
    run.call(&onyx, "set_owner", json!({ "new_owner": onyx.id() })).await?;
    run.call(&nova, "sweep", json!({ "to": nova.id(), "amount": "1" })).await?;
    run.call(&stranger, "set_owner", json!({ "new_owner": stranger.id() })).await?;
    let before = worker.view_account(nova.id()).await?.balance.as_yoctonear();
    run.call(&nova, "set_owner", json!({ "new_owner": nova.id() })).await?;
    run.view("get_owner", json!({})).await?;
    run.call(
        &nova,
        "sweep",
        json!({ "to": nova.id(), "amount": NearToken::from_near(100).as_yoctonear().to_string() }),
    )
    .await?;
    run.call(&nova, "sweep", json!({ "to": nova.id(), "amount": NearToken::from_near(2).as_yoctonear().to_string() }))
        .await?;
    worker.fast_forward(5).await?;
    let gained = worker.view_account(nova.id()).await?.balance.as_yoctonear() - before;
    // The two calls' gas comes off the 2 NEAR: what reached the mask, to the hundredth of a NEAR.
    run.note(
        "nova gained (NEAR/100)",
        format!("{}", (gained + NearToken::from_millinear(9).as_yoctonear()) / 10u128.pow(22)),
    );
    run.call(&onyx, "set_owner", json!({ "new_owner": onyx.id() })).await?;
    run.view("waits_for", json!({ "account_id": onyx.id() })).await?;
    for (method, args) in [
        ("get_turn", json!({})),
        ("touches", json!({ "account_id": nova.id() })),
        ("touches", json!({ "account_id": onyx.id() })),
        ("get_queue", json!({})),
    ] {
        run.view(method, args).await?;
    }

    // After it: only the team retires or reclaims, and only on the bounty contract's word, which a plain account
    // does not give: the safe stays as it is.
    run.call(&stranger, "retire", json!({})).await?;
    run.call(&team, "retire", json!({})).await?;
    run.call(&team, "reclaim", json!({})).await?;
    run.note("safe still there", format!("{}", worker.view_account(safe.id()).await.is_ok()));
    run.view("get_owner", json!({})).await?;

    // A safe that took no round goes at once when its team retires it, and all it holds goes to the team.
    let spare = sub("spare", 5).await?;
    spare
        .batch(spare.id())
        .deploy(wasm)
        .call(near_workspaces::operations::Function::new("new").args_json(
            json!({ "owner": spare.id(), "masks": [nova.id()], "arbiter": arbiter.id(), "team": team.id() }),
        ))
        .transact()
        .await?
        .into_result()?;
    let mut spare_run = Run { worker: worker.clone(), safe: spare.id().clone(), lines: vec![], opens_ns: run.opens_ns };
    spare_run.call(&nova, "retire", json!({})).await?;
    spare_run.call(&team, "retire", json!({})).await?;
    worker.fast_forward(5).await?;
    spare_run.note("spare gone", format!("{}", worker.view_account(spare.id()).await.is_err()));

    // A practice safe: no round, open at once to its masks, and no team to retire it.
    let practice = sub("practice", 5).await?;
    practice
        .batch(practice.id())
        .deploy(wasm)
        .call(
            near_workspaces::operations::Function::new("new")
                .args_json(json!({ "owner": team.id(), "masks": [nova.id()] })),
        )
        .transact()
        .await?
        .into_result()?;
    let mut practice_run =
        Run { worker: worker.clone(), safe: practice.id().clone(), lines: vec![], opens_ns: run.opens_ns };
    practice_run.call(&nova, "sweep", json!({ "to": nova.id(), "amount": "1" })).await?;
    practice_run.call(&nova, "set_owner", json!({ "new_owner": nova.id() })).await?;
    practice_run
        .call(&nova, "sweep", json!({ "to": nova.id(), "amount": NearToken::from_near(1).as_yoctonear().to_string() }))
        .await?;
    practice_run.call(&team, "retire", json!({})).await?;
    practice_run.call(&team, "reclaim", json!({})).await?;

    let mut lines = run.lines;
    lines.extend(spare_run.lines.into_iter().map(|l| format!("spare {l}")));
    lines.extend(practice_run.lines.into_iter().map(|l| format!("practice {l}")));
    Ok(lines)
}

#[tokio::test]
async fn the_safe_1_6_behaves_as_the_code_on_mainnet_call_for_call() -> Result<()> {
    built();
    let old = mainnet_safe()?;
    let new = std::fs::read(wasm_dir().join("live_safe.wasm"))?;
    assert_ne!(code_hash(&old), code_hash(&new));

    // The new code exports what the old one does, `about`, and what the safe's kinds brought: the desks of the two
    // new kinds, which a safe of the owner kind refuses, and three views.
    let (old_exports, new_exports) = (exports(&old), exports(&new));
    let mut added: Vec<&str> = new_exports.iter().filter(|e| !old_exports.contains(e)).map(String::as_str).collect();
    added.sort_unstable();
    let dropped: Vec<&String> = old_exports.iter().filter(|e| !new_exports.contains(e)).collect();
    let kinds = [
        "about",
        "book",
        "cash_out",
        "check_exit",
        "claim",
        "get_desk",
        "is_paused",
        "pause",
        "request_exit",
        "unpause",
        "variant",
        "withdraw",
    ];
    assert_eq!(added, kinds, "{new_exports:?}");
    assert!(dropped.is_empty(), "{dropped:?}");
    assert!(new_exports.contains(&"contract_source_metadata".to_string()));

    let (was, is) = (script(&old).await?, script(&new).await?);
    for (a, b) in was.iter().zip(is.iter()) {
        assert_eq!(a, b, "the mainnet code and 1.7.0 part here");
    }
    assert_eq!(was.len(), is.len());
    // The script did reach every path it means to: a drain through the hole, the refusals, the retire.
    let all = is.join("\n");
    for seen in [
        "the safe drops the key that deployed it",
        "the safe waits for its round",
        "only a round the safe's own team opens arms the safe",
        "an earlier seal goes first",
        "owner only",
        "not that much in the safe",
        "another mask has its turn on the safe",
        "nova gained (NEAR/100): 200",
        "the bounty contract did not answer",
        "spare spare gone: true",
        "a practice safe has no team",
    ] {
        assert!(all.contains(seen), "{seen} is not in the run:\n{all}");
    }
    println!("{all}");
    Ok(())
}
