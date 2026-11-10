//! A local sandbox with the factory ready to forge, for walking the site's /forge end to end:
//! `cargo run -p masks-sandbox --bin serve -- <out.json>`. Writes the RPC address, the factory, a person's account with
//! its key and a rival's to `out.json`, then keeps the sandbox running until it is stopped.

use anyhow::{Context, Result};
use masks_sandbox::{build, World};
use serde_json::json;

#[tokio::main]
async fn main() -> Result<()> {
    let out = std::env::args().nth(1).context("usage: serve <out.json>")?;
    let wasm = build()?;
    let w = World::new(&wasm, 60).await?;
    // One name already taken, to see the forge refuse it.
    let res = w.forge(&w.bob, "kira", 2 * masks_sandbox::ONE_NEAR, None).await?;
    anyhow::ensure!(res.is_success(), "forge kira: {}", masks_sandbox::why(&res));
    let info = json!({
        "rpc": w.worker.rpc_addr(),
        "factory": w.factory,
        "account": w.ann.id(),
        "secret_key": w.ann.secret_key().to_string(),
        // Someone else, to take a name between the page's check and the person's signature.
        "rival": w.bob.id(),
        "rival_key": w.bob.secret_key().to_string(),
    });
    std::fs::write(&out, serde_json::to_string_pretty(&info)?)?;
    println!("{info}");
    tokio::signal::ctrl_c().await?;
    Ok(())
}
