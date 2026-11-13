//! `race-runner run <challenge dir> [--wasm <file>] [--variant <kind>]` reads a plan (JSON) from stdin, runs it in a
//! fresh local sandbox and prints one line `RACE_OUTCOME <json>` to stdout. `--variant` takes the target as another
//! of its kinds (`challenge.<kind>.json` in the challenge's folder; live-safe: `limit`, `pause`).
//!
//! `race-runner build` builds the training targets for wasm, the OutLayer stub and the bounty contract.
//!
//! `race-runner round [scenario.json] [--variant <kind>]` plays one sealed round with scripted masks in a fresh local
//! sandbox and prints one line `ROUND_BOARD <json>`. Without a file it plays the standard scenario; `--variant` plays
//! it on a safe of that kind.

use anyhow::{bail, Context, Result};
use race_runner::round::{run_round, Scenario};
use race_runner::{build_targets, run_attempt, wasm_dir, Challenge, Plan};
use std::io::Read;
use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("build") => build_targets(),
        Some("run") => {
            let dir =
                args.get(1).context("usage: race-runner run <challenge dir> [--wasm <file>] [--variant <kind>]")?;
            let variant = match args.iter().position(|a| a == "--variant") {
                Some(i) => Some(args.get(i + 1).context("--variant needs a kind")?.as_str()),
                None => None,
            };
            let challenge = Challenge::load_variant(dir, variant)?;
            let wasm_path = match args.iter().position(|a| a == "--wasm") {
                Some(i) => PathBuf::from(args.get(i + 1).context("--wasm needs a path")?),
                None => wasm_dir().join(&challenge.manifest.wasm),
            };
            let wasm = std::fs::read(&wasm_path)
                .with_context(|| format!("read {} (run `race-runner build` first)", wasm_path.display()))?;
            let mut input = String::new();
            std::io::stdin().read_to_string(&mut input)?;
            let outcome = match serde_json::from_str::<Plan>(&input) {
                Ok(plan) => run_attempt(&challenge, &wasm, &plan).await,
                Err(e) => {
                    let empty = Plan { steps: vec![] };
                    let mut o = run_attempt(&challenge, &wasm, &empty).await;
                    o.reason = format!("plan is not valid JSON for the plan format: {e}");
                    o
                }
            };
            println!("RACE_OUTCOME {}", serde_json::to_string(&outcome)?);
            Ok(())
        }
        Some("round") => {
            let variant = match args.iter().position(|a| a == "--variant") {
                Some(i) => Some(args.get(i + 1).context("--variant needs a kind")?.clone()),
                None => None,
            };
            let file = args.iter().skip(1).enumerate().find(|(i, a)| *a != "--variant" && args[*i] != "--variant");
            let mut scenario: Scenario = match file {
                Some((_, file)) => {
                    serde_json::from_str(&std::fs::read_to_string(file)?).context("read the scenario")?
                }
                None => Scenario::standard(),
            };
            if let Some(v) = variant {
                scenario.variant = Some(v);
            }
            let board = run_round(&scenario).await?;
            println!("ROUND_BOARD {}", serde_json::to_string(&board)?);
            Ok(())
        }
        _ => bail!(
            "usage: race-runner build | race-runner run <challenge dir> [--wasm <file>] [--variant <kind>] | \
             race-runner round [scenario.json] [--variant <kind>]"
        ),
    }
}
