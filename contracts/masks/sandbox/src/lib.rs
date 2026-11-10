//! The mask factory in a real local NEAR sandbox. Everything on chain is the real code: the factory, the mask code as
//! a global contract, the masks' accounts and their race keys. Only the arena and the race's safe are stand-ins
//! (`../stub`) that record who called what, so a test sees exactly what a race key can and cannot reach.

use anyhow::{bail, Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

pub const ONE_NEAR: u128 = 10u128.pow(24);
pub const MILLI: u128 = ONE_NEAR / 1000;
/// The mind's seed in this sandbox. On OutLayer it is generated inside the TEE and nobody sees it.
pub const MIND_SEED: [u8; 32] = [42; 32];

pub struct Wasm {
    pub factory: Vec<u8>,
    /// The factory as first merged (`../legacy/factory-v1`), for the upgrade test.
    pub factory_v1: Vec<u8>,
    pub mask: Vec<u8>,
    /// The mask code as first merged (`../legacy/mask-v1`), for the mask's own upgrade test.
    pub mask_v1: Vec<u8>,
    pub stub: Vec<u8>,
}

/// The masks workspace root (this crate's parent).
pub fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Builds the factory (and its first version), the mask code and the stub for wasm, into a separate target dir so it never contends with the
/// outer `cargo` lock.
pub fn build() -> Result<Wasm> {
    let root = workspace_root();
    let target = root.join("target").join("sandbox-wasm");
    let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .current_dir(&root)
        .env("RUSTFLAGS", "--cfg near -C link-arg=-s")
        .env("CARGO_TARGET_DIR", &target)
        .args(["build", "--release", "--target", "wasm32-unknown-unknown"])
        .args(["-p", "maskwars-masks", "-p", "maskwars-masks-v1", "-p", "maskwars-mask", "-p", "maskwars-mask-v1"])
        .args(["-p", "masks-stub"])
        .status()
        .context("run cargo build")?;
    if !status.success() {
        bail!("wasm build failed");
    }
    let dir = target.join("wasm32-unknown-unknown").join("release");
    let read = |f: &str| std::fs::read(dir.join(f)).with_context(|| format!("read {f}"));
    Ok(Wasm {
        factory: read("maskwars_masks.wasm")?,
        factory_v1: read("maskwars_masks_v1.wasm")?,
        mask: read("maskwars_mask.wasm")?,
        mask_v1: read("maskwars_mask_v1.wasm")?,
        stub: read("masks_stub.wasm")?,
    })
}

/// The catalog the factory starts with on testnet: `catalog.json`, as the deploy script passes it to `new`.
pub fn catalog() -> Result<Value> {
    let path = workspace_root().join("catalog.json");
    Ok(serde_json::from_str(&std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?)?)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn near(yocto: u128) -> NearToken {
    NearToken::from_yoctonear(yocto)
}

pub struct World {
    pub worker: Worker<Sandbox>,
    pub admin: Account,
    pub keeper: Account,
    pub treasury: Account,
    pub ann: Account,
    pub bob: Account,
    /// Stand-ins for the bounty contract and for the race's safe.
    pub arena: Account,
    pub safe: Account,
    pub factory: AccountId,
    pub mask_code: String,
}

impl World {
    /// A fresh sandbox: the people, the stand-ins, and the factory deployed the way testnet gets it, in one
    /// transaction that adds no key. The mask code is published as a global contract and the mind has its key.
    pub async fn new(wasm: &Wasm, release_minutes: u32) -> Result<Self> {
        Self::deploy(wasm, &wasm.factory, release_minutes, true).await
    }

    /// The same with any factory code (`factory_v1` for the upgrade test), and with the mask code published or not.
    pub async fn deploy(wasm: &Wasm, factory_code: &[u8], release_minutes: u32, publish: bool) -> Result<Self> {
        Self::deploy_with(wasm, factory_code, &wasm.mask, release_minutes, publish).await
    }

    /// The same with any mask code too (`mask_v1` for the mask's own upgrade test).
    pub async fn deploy_with(
        wasm: &Wasm,
        factory_code: &[u8],
        mask_wasm: &[u8],
        release_minutes: u32,
        publish: bool,
    ) -> Result<Self> {
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
        let admin = sub("admin", 50).await?;
        let keeper = sub("keeper", 10).await?;
        let treasury = sub("treasury", 1).await?;
        let ann = sub("ann", 30).await?;
        let bob = sub("bob", 30).await?;
        let arena = sub("arena", 10).await?;
        let safe = sub("safe", 10).await?;
        for stub in [&arena, &safe] {
            stub.deploy(&wasm.stub).await?.into_result()?;
            stub.call(stub.id(), "new").transact().await?.into_result()?;
        }

        let factory: AccountId = format!("masks.{}", root.id()).parse()?;
        let mask_code = sha256_hex(mask_wasm);
        let mind = maskwars_brain::key_text(&x25519_public());
        let new = json!({
            "admin": admin.id(), "keeper": keeper.id(), "treasury": treasury.id(), "arena": arena.id(),
            "mask_code": mask_code, "strategy_key": mind, "release_minutes": release_minutes,
            "catalog": catalog()?, "teams": [admin.id()],
        });
        // Deployed from root, as testnet's factory is a sub-account of the admin; no key is ever added to it.
        root.batch(&factory)
            .create_account()
            .transfer(NearToken::from_near(30))
            .deploy(factory_code)
            .call(Function::new("new").args_json(new).gas(Gas::from_tgas(100)))
            .transact()
            .await?
            .into_result()
            .context("deploy the factory")?;
        if publish {
            bob.call(&factory, "publish_mask_code")
                .args(mask_wasm.to_vec())
                .gas(Gas::from_tgas(300))
                .transact()
                .await?
                .into_result()
                .context("publish the mask code")?;
        }
        Ok(Self { worker, admin, keeper, treasury, ann, bob, arena, safe, factory, mask_code })
    }

    pub fn mask_id(&self, name: &str) -> AccountId {
        format!("{name}.{}", self.factory).parse().unwrap()
    }

    pub async fn forge(
        &self,
        who: &Account,
        name: &str,
        deposit: u128,
        strategy: Option<&str>,
    ) -> Result<ExecutionFinalResult> {
        let sealed = match strategy {
            Some(line) => Some(seal(&self.mask_id(name), line)?),
            None => None,
        };
        Ok(who
            .call(&self.factory, "forge")
            .args_json(json!({ "name": name, "look": "porcelain", "model": "Qwen/Qwen3.8-27B", "style": "cunning",
                               "strategy": sealed }))
            .deposit(near(deposit))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    pub async fn view(&self, method: &str, args: Value) -> Result<Value> {
        Ok(self.worker.view(&self.factory, method).args_json(args).await?.json()?)
    }

    pub async fn mask(&self, name: &str) -> Result<Value> {
        self.view("get_mask", json!({ "name": name })).await
    }

    pub async fn balance(&self, id: &AccountId) -> Result<u128> {
        Ok(self.worker.view_account(id).await?.balance.as_yoctonear())
    }

    /// Every access key on an account: `(public key, None)` for a full-access key, `(public key, Some((receiver,
    /// methods, allowance)))` for a function-call key.
    pub async fn keys(&self, id: &AccountId) -> Result<Vec<(String, Option<(String, Vec<String>, Option<u128>)>)>> {
        let keys = self.worker.view_access_keys(id).await?;
        Ok(keys
            .into_iter()
            .map(|k| {
                let perm = match k.access_key.permission {
                    AccessKeyPermission::FullAccess => None,
                    AccessKeyPermission::FunctionCall(f) => {
                        Some((f.receiver_id, f.method_names, f.allowance.map(|a| a.as_yoctonear())))
                    }
                };
                (k.public_key.to_string(), perm)
            })
            .collect())
    }

    /// The team (the admin, as on testnet) opens round `race` on the arena, on the safe, with the mask `name` on its
    /// list, its commit window an hour long.
    pub async fn open_round(&self, race: &str, name: &str) -> Result<()> {
        self.open_round_as(&self.admin, race, self.safe.id(), name).await
    }

    /// `who` opens round `race` on the arena with `safe` as its safe: anyone may, with any contract.
    pub async fn open_round_as(&self, who: &Account, race: &str, safe: &AccountId, name: &str) -> Result<()> {
        who.call(self.arena.id(), "open_round")
            .args_json(json!({ "id": race, "safe": safe, "masks": [self.mask_id(name)], "commit_minutes": 60 }))
            .transact()
            .await?
            .into_result()
            .context("open a round on the arena")?;
        Ok(())
    }

    /// The keeper arms a mask for `race` with two fresh race keys and returns them: the arena key, the target key. The
    /// arena has the round open with the mask on its list, as the factory checks before any key goes on.
    pub async fn arm(&self, name: &str, race: &str) -> Result<(SecretKey, SecretKey, ExecutionFinalResult)> {
        self.open_round(race, name).await?;
        self.arm_on(name, race, self.safe.id()).await
    }

    /// The keeper arms a mask for `race` with a key on `target`, whatever round the arena has.
    pub async fn arm_on(
        &self,
        name: &str,
        race: &str,
        target: &AccountId,
    ) -> Result<(SecretKey, SecretKey, ExecutionFinalResult)> {
        let arena_key = SecretKey::from_random(KeyType::ED25519);
        let target_key = SecretKey::from_random(KeyType::ED25519);
        let res = self
            .keeper
            .call(&self.factory, "arm")
            .args_json(json!({
                "name": name, "race": race, "arena_key": arena_key.public_key(), "target": target,
                "target_key": target_key.public_key(), "target_methods": ["set_owner", "sweep"],
            }))
            .gas(Gas::from_tgas(150))
            .transact()
            .await?;
        Ok((arena_key, target_key, res))
    }

    /// The mask's account, signing with one of its race keys.
    pub fn as_mask(&self, name: &str, key: &SecretKey) -> Account {
        Account::from_secret_key(self.mask_id(name), key.clone(), &self.worker)
    }

    /// The keeper settles `race`: the mind spent `spent` yoctoNEAR.
    pub async fn settle(&self, name: &str, race: &str, spent: u128) -> Result<ExecutionFinalResult> {
        Ok(self
            .keeper
            .call(&self.factory, "settle")
            .args_json(json!({ "name": name, "race": race, "spent": spent.to_string() }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// The owner opens a mask to copying for `bps` of each copy's winnings.
    pub async fn allow_copy(&self, who: &Account, name: &str, bps: u16) -> Result<ExecutionFinalResult> {
        Ok(who
            .call(&self.factory, "allow_copy")
            .args_json(json!({ "name": name, "author_bps": bps }))
            .deposit(near(ONE_NEAR / 10))
            .gas(Gas::from_tgas(30))
            .transact()
            .await?)
    }

    /// `who` forges `name` as a copy of `author`, agreeing to the share `bps` (basis points).
    pub async fn forge_copy(
        &self,
        who: &Account,
        name: &str,
        author: &str,
        bps: u16,
        deposit: u128,
    ) -> Result<ExecutionFinalResult> {
        Ok(who
            .call(&self.factory, "forge")
            .args_json(json!({ "name": name, "look": "porcelain", "model": "Qwen/Qwen3.8-27B", "style": "cunning",
                               "copy_of": author, "copy_bps": bps }))
            .deposit(near(deposit))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    /// A copy's terms as its own account tells them (`copy_terms`); `None` for a mask that is not a copy.
    pub async fn copy_terms(&self, mask: &AccountId) -> Result<Option<Terms>> {
        let r = self.worker.view(mask, "copy_terms").args(vec![]).await?;
        let text = String::from_utf8(r.result)?;
        if text.is_empty() {
            return Ok(None);
        }
        let f: Vec<&str> = text.split('|').collect();
        anyhow::ensure!(f.len() == 6, "copy_terms: {text}");
        let n = |i: usize| -> Result<u128> { Ok(f[i].parse()?) };
        Ok(Some(Terms {
            author: f[0].to_string(),
            bps: n(1)? as u16,
            paid: n(2)?,
            owed: n(3)?,
            due: n(4)?,
            owner: n(5)?,
        }))
    }

    /// Sends `amount` yoctoNEAR to `to` from `who`: in a copy's life, the effect of a won round landing on its account.
    pub async fn fund(&self, who: &Account, to: &AccountId, amount: u128) -> Result<()> {
        who.batch(to).transfer(near(amount)).transact().await?.into_result().context("fund")?;
        Ok(())
    }

    /// Lets sandbox time pass until `at`, ns.
    pub async fn wait_until(&self, at: u64) -> Result<()> {
        while self.worker.view_block().await?.timestamp() < at {
            self.worker.fast_forward(200).await?;
        }
        Ok(())
    }

    /// Sandbox only: the pending change becomes ready now, as if its 72 hours had passed. It rewrites the change's
    /// `ready_ns` in the factory's state to its `proposed_ns`, so a test of what comes after a change does not
    /// produce three days of blocks. The wait itself is tested without it (`tests/review.rs`).
    pub async fn skip_wait(&self) -> Result<()> {
        let p = self.view("pending", json!({})).await?;
        let ns = |k: &str| -> Result<u64> { Ok(p[k].as_str().context("no pending change")?.parse()?) };
        let (proposed, ready) = (ns("proposed_ns")?, ns("ready_ns")?);
        let state = self.worker.view_state(&self.factory).prefix(b"STATE").await?;
        let mut raw = state.get(b"STATE".as_slice()).context("no factory state")?.clone();
        let at: Vec<usize> =
            raw.windows(8).enumerate().filter(|(_, w)| *w == ready.to_le_bytes()).map(|(i, _)| i).collect();
        anyhow::ensure!(at.len() == 1, "ready_ns is not one place in the state: {at:?}");
        raw[at[0]..at[0] + 8].copy_from_slice(&proposed.to_le_bytes());
        self.worker.patch_state(&self.factory, b"STATE", &raw).await?;
        Ok(())
    }

    /// The calls a stand-in recorded: `(method, predecessor, signer)`.
    pub async fn calls(&self, stub: &Account) -> Result<Vec<(String, String, String)>> {
        let v: Value = self.worker.view(stub.id(), "calls").await?.json()?;
        Ok(v.as_array()
            .context("calls")?
            .iter()
            .map(|c| {
                let s = |k: &str| c[k].as_str().unwrap_or_default().to_string();
                (s("method"), s("predecessor"), s("signer"))
            })
            .collect())
    }
}

/// The mind's public key in this sandbox.
pub fn x25519_public() -> maskwars_brain::MindPublic {
    maskwars_brain::MindPublic::from(&maskwars_brain::mind_secret(&MIND_SEED))
}

/// Seals a strategy line as the browser does, with fresh random bytes.
pub fn seal(mask: &AccountId, line: &str) -> Result<String> {
    let eph: [u8; 32] = rand_bytes();
    let nonce: [u8; 12] = rand_bytes();
    maskwars_brain::seal(&x25519_public(), mask.as_str(), line, eph, nonce).map_err(anyhow::Error::msg)
}

fn rand_bytes<const N: usize>() -> [u8; N] {
    // A fresh key is enough to make every box different; the sandbox needs no stronger randomness.
    let k = SecretKey::from_random(KeyType::ED25519).to_string();
    let digest = Sha256::digest(k.as_bytes());
    std::array::from_fn(|i| digest[i % 32])
}

/// A copy's terms as `copy_terms` tells them, all amounts yoctoNEAR: what the author was paid and is owed (together,
/// what the author earned on the copy), what `pay_author` would send now, and what the owner's `withdraw` would.
#[derive(Debug, Clone, PartialEq)]
pub struct Terms {
    pub author: String,
    pub bps: u16,
    pub paid: u128,
    pub owed: u128,
    pub due: u128,
    pub owner: u128,
}

/// Why a transaction failed, short.
pub fn why(res: &ExecutionFinalResult) -> String {
    format!("{:?}", res.failures())
}
