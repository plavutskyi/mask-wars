//! The bounty contract's only way to new code, on a real local node: it is born without a key in one transaction,
//! the admin proposes the code, the wait passes, anyone calls `upgrade` with the wasm itself as input, and `migrate`
//! runs in the same batch. Every bounty and setting survives; code without `migrate` never goes in.

use anyhow::Result;
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{AccountId, Worker};
use race_runner::build_targets;
use race_runner::round::{bounty_wasm_path, sandbox, SANDBOX_JUDGE};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Once;

fn built() {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| build_targets().expect("build wasm"));
}

fn sha_hex(code: &[u8]) -> String {
    Sha256::digest(code).iter().map(|b| format!("{b:02x}")).collect()
}

/// The same contract with one more custom section: valid wasm that behaves the same, under another hash.
fn new_code(code: &[u8]) -> Vec<u8> {
    let mut c = code.to_vec();
    c.extend_from_slice(&[0x00, 0x07, 0x04, b'n', b'e', b'x', b't', b'v', b'2']);
    c
}

async fn now(worker: &Worker<near_workspaces::network::Sandbox>) -> Result<u64> {
    Ok(worker.view_block().await?.timestamp())
}

/// Lets sandbox time pass until `at` (ns).
async fn wait_until(worker: &Worker<near_workspaces::network::Sandbox>, at: u64) -> Result<()> {
    while now(worker).await? < at {
        worker.fast_forward(2_000).await?;
    }
    Ok(())
}

async fn view(
    worker: &Worker<near_workspaces::network::Sandbox>,
    id: &AccountId,
    method: &str,
    args: Value,
) -> Result<Value> {
    Ok(worker.view(id, method).args_json(args).await?.json()?)
}

#[tokio::test]
async fn the_keyless_contract_takes_new_code_only_through_its_own_upgrade() -> Result<()> {
    built();
    let wasm = std::fs::read(bounty_wasm_path())?;
    let (_node, worker) = sandbox().await?;
    let root = worker.root_account()?;
    let admin =
        root.create_subaccount("admin").initial_balance(NearToken::from_near(30)).transact().await?.into_result()?;
    let id: AccountId = format!("bounty.{}", root.id()).parse()?;

    // One transaction: create, fund, deploy, new. No key is added.
    root.batch(&id)
        .create_account()
        .transfer(NearToken::from_near(10))
        .deploy(&wasm)
        .call(
            Function::new("new")
                .args_json(json!({ "outlayer": "outlayer.test.near", "judge_project": "admin/judge",
                                   "judge_version": SANDBOX_JUDGE, "admin": admin.id(), "safe_codes": [] }))
                .gas(Gas::from_tgas(50)),
        )
        .transact()
        .await?
        .into_result()?;
    assert!(worker.view_access_keys(&id).await?.is_empty(), "the contract's account holds no key");

    // A bounty that lives and ends before the change: refunded after its hour and the 12 hour grace.
    let opened = admin
        .call(&id, "open")
        .args_json(json!({ "id": "race-0001", "target": "open-admin", "hours": 1, "judge_version": SANDBOX_JUDGE,
                           "masks": ["nova.test.near"] }))
        .deposit(NearToken::from_near(1))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(opened.is_success(), "{opened:?}");
    let deadline: u64 =
        view(&worker, &id, "get", json!({ "id": "race-0001" })).await?["deadline_ns"].as_str().unwrap().parse()?;
    wait_until(&worker, deadline + 12 * 3_600_000_000_000).await?;
    let refund =
        admin.call(&id, "refund").args_json(json!({ "id": "race-0001" })).gas(Gas::from_tgas(30)).transact().await?;
    assert!(refund.is_success(), "{refund:?}");

    // The admin proposes new code. Before the wait, upgrade is refused.
    let code = new_code(&wasm);
    let proposed = admin
        .call(&id, "propose")
        .args_json(json!({ "change": { "kind": "code", "sha256": sha_hex(&code) } }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(proposed.is_success(), "{proposed:?}");
    let pending = view(&worker, &id, "pending", json!({})).await?;
    let early = admin.call(&id, "upgrade").args(code.clone()).gas(Gas::from_tgas(300)).transact().await?;
    assert!(early.is_failure(), "upgrade before the wait");

    // With no bounty live, the notice is enough. Anyone may upgrade: the wasm is the input.
    wait_until(&worker, pending["notice_ns"].as_str().unwrap().parse()?).await?;
    let anyone =
        root.create_subaccount("anyone").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    let upgraded = anyone.call(&id, "upgrade").args(code.clone()).gas(Gas::from_tgas(300)).transact().await?;
    assert!(upgraded.is_success(), "{upgraded:?}");
    let deployed = worker.view_code(&id).await?;
    assert_eq!(sha_hex(&deployed), sha_hex(&code), "the proposed code is on chain");

    // migrate kept everything.
    let gov = view(&worker, &id, "governance", json!({})).await?;
    assert_eq!(gov["admin"], admin.id().as_str());
    assert_eq!(gov["judge"]["version"], SANDBOX_JUDGE);
    assert_eq!(gov["pending"], Value::Null);
    assert_eq!(view(&worker, &id, "get", json!({ "id": "race-0001" })).await?["status"]["state"], "refunded");
    assert!(worker.view_access_keys(&id).await?.is_empty());

    // Code without migrate (a live safe) is proposed and waited out; upgrade fails as a whole and the code stays.
    let bad = std::fs::read(race_runner::wasm_dir().join("live_safe.wasm"))?;
    let proposed = admin
        .call(&id, "propose")
        .args_json(json!({ "change": { "kind": "code", "sha256": sha_hex(&bad) } }))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?;
    assert!(proposed.is_success(), "{proposed:?}");
    let pending = view(&worker, &id, "pending", json!({})).await?;
    wait_until(&worker, pending["notice_ns"].as_str().unwrap().parse()?).await?;
    let broken = anyone.call(&id, "upgrade").args(bad).gas(Gas::from_tgas(300)).transact().await?;
    assert!(broken.is_failure(), "code without migrate went in");
    assert_eq!(sha_hex(&worker.view_code(&id).await?), sha_hex(&code), "the old code stays");
    assert_eq!(view(&worker, &id, "governance", json!({})).await?["admin"], admin.id().as_str());
    Ok(())
}
