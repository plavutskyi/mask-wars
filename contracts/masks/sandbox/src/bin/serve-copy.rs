//! A local sandbox set up for confidential copying, for walking the site's mask pages and `/forge?copy=`:
//! `cargo run -p masks-sandbox --bin serve-copy -- <out.json>`. ANN forges KIRA with a sealed strategy and opens it to
//! copying for 30%, and forges VERA with a strategy she has not opened. BOB forges NINA as a copy of KIRA and NINA
//! wins a prize that waits on its account (so KIRA's share is due); the admin forges MIRA as a copy too, MIRA wins and
//! its owner withdraws (so KIRA's account was paid its share). Writes the RPC, the factory, the masks and the owners'
//! keys to `out.json` and keeps the sandbox running until `<out.json>.stop` exists.

use anyhow::{ensure, Context, Result};
use masks_sandbox::{why, World, ONE_NEAR};
use near_workspaces::types::{Gas, NearToken};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<()> {
    let out = std::env::args().nth(1).context("usage: serve-copy <out.json>")?;
    let wasm = masks_sandbox::build()?;
    let w = World::new(&wasm, 60).await?;

    // ANN forges KIRA with a strategy and opens it to copying for 30%; VERA has a strategy, not open to copying.
    let line = "Wait for the window to close, then take the safe.";
    let forged = w.forge(&w.ann, "kira", 2 * ONE_NEAR, Some(line)).await?;
    ensure!(forged.is_success(), "forge kira: {}", why(&forged));
    let opened = w.allow_copy(&w.ann, "kira", 3000).await?;
    ensure!(opened.is_success(), "allow_copy: {}", why(&opened));
    let vera = w.forge(&w.ann, "vera", 2 * ONE_NEAR, Some("Patience first, then the whole safe.")).await?;
    ensure!(vera.is_success(), "forge vera: {}", why(&vera));

    // BOB forges NINA as a copy of KIRA, and a prize lands on NINA's account: KIRA's share of it is due.
    let copied = w.forge_copy(&w.bob, "nina", "kira", 3000, 2 * ONE_NEAR).await?;
    ensure!(copied.is_success(), "forge the copy: {}", why(&copied));
    let nina = w.mask_id("nina");
    let pay = |to: near_workspaces::AccountId, near: u128| {
        w.safe.call(w.safe.id(), "pay").args_json(json!({ "to": to })).deposit(NearToken::from_near(near)).transact()
    };
    ensure!(pay(nina.clone(), 1).await?.is_success(), "pay nina");

    // The admin forges MIRA as a copy of KIRA; MIRA wins and its owner withdraws: KIRA's account is paid its share.
    let mira = w.forge_copy(&w.admin, "mira", "kira", 3000, 2 * ONE_NEAR).await?;
    ensure!(mira.is_success(), "forge mira: {}", why(&mira));
    let mira_id = w.mask_id("mira");
    ensure!(pay(mira_id.clone(), 2).await?.is_success(), "pay mira");
    let took = w.admin.call(&mira_id, "withdraw").gas(Gas::from_tgas(30)).transact().await?;
    ensure!(took.is_success(), "withdraw mira: {}", why(&took));

    let info = json!({
        "rpc": w.worker.rpc_addr(),
        "factory": w.factory,
        "author": "kira",
        "copy": "nina",
        "closed": "vera",
        "author_account": w.mask_id("kira"),
        "copy_account": nina,
        "author_owner": w.ann.id(),
        "author_owner_key": w.ann.secret_key().to_string(),
        "copy_owner": w.bob.id(),
        "copy_owner_key": w.bob.secret_key().to_string(),
    });
    std::fs::write(&out, serde_json::to_string_pretty(&info)?)?;
    println!("serving {info}");
    let stop = format!("{out}.stop");
    while !std::path::Path::new(&stop).exists() {
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    Ok(())
}
