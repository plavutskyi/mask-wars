//! View keys: a mask's race history, open only to the accounts its owner chose.
//!
//! A mask's strategy is never read by anyone (`../README.md`, "Confidential copying"). Its **history** is another
//! thing: how the mind played each race, attempt by attempt, the plan it sealed, what the round paid, what the mind
//! spent. Its result is public on chain already: the × and every payout. The history is private, and the owner shares
//! it with whom they like, as Illia Polosukhin's "PnL public, access sold" has it.
//!
//! - **Who may read.** The owner grants a view to an account (`grant_view`) and takes it back (`revoke_view`); the
//!   owner reads their own mask's history the same way, as one of its viewers. At most `MAX_VIEWERS` a mask.
//! - **With what key.** Every account that reads histories registers one X25519 public key (`set_view_key`), once for
//!   every mask: the site makes it from a signature of the person's own wallet, so the secret half is never stored
//!   anywhere and the same wallet makes the same key on any device.
//! - **What the chain carries.** The keeper writes each race's note (`note`): the note sealed with a key for that race
//!   alone, and that race key sealed for each current viewer. A viewer granted later gets the keys of the races before
//!   (`share`). Nothing here is stored: notes and shares are events in the keeper's transactions, so a note costs gas
//!   only, and the factory checks that every sealed key goes to an account the owner granted, under the key that
//!   account registered.
//! - **Revoked is revoked.** A viewer the owner revoked gets no key to any race after it. What they read before, they
//!   read.
//!
//! What a note holds is written by the keeper from the race itself (attempts, verdicts, the calls of each plan, times,
//! the payout, the mind's cost): never the model's text and never the strategy, so a copy's owner who reads the copy's
//! history learns nothing of its author's line. Formats: `packages/forge/src/history.ts`.
//!
//! The state lives apart from the factory's stored root (`VIEWERS`, `VIEW_KEYS`, prefixes of their own), so adding
//! view keys changed no stored layout and needs no migration.

use crate::{event, strategy_key_ok, Factory, FactoryExt};
use near_sdk::serde::Serialize;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

/// Accounts one mask may share its history with, its owner included.
pub const MAX_VIEWERS: usize = 16;
/// Storage prefixes of the two maps. The root's own collections take one-byte prefixes (`Key`), and none of them is a
/// prefix of these.
const VIEWERS: &[u8] = b"views:";
const VIEW_KEYS: &[u8] = b"vkeys:";
/// The longest sealed note, sealed race key and share the factory passes on, in characters.
pub const MAX_NOTE: usize = 6000;
pub const MAX_WRAP: usize = 200;
pub const MAX_SHARE: usize = 12000;

fn viewers_map() -> LookupMap<String, Vec<AccountId>> {
    LookupMap::new(VIEWERS.to_vec())
}

fn keys_map() -> LookupMap<AccountId, String> {
    LookupMap::new(VIEW_KEYS.to_vec())
}

/// One viewer of a mask's history, as `viewers` shows it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Viewer {
    pub account: AccountId,
    /// The X25519 key the account registered, `x25519:<hex>`; `None` until it registers one, and until then the keeper
    /// seals nothing for it.
    pub key: Option<String>,
}

/// A race key sealed for one viewer, in a note.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Wrap {
    pub to: AccountId,
    /// `v1.` and base64url: the race's key, sealed for `to`'s view key (`packages/forge/src/history.ts`).
    pub key: String,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Granted<'a> {
    name: &'a str,
    viewer: &'a AccountId,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct KeySet<'a> {
    account: &'a AccountId,
    key: &'a str,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Noted<'a> {
    name: &'a str,
    account: &'a AccountId,
    race: &'a str,
    note: &'a str,
    keys: &'a [Wrap],
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct Shared<'a> {
    name: &'a str,
    account: &'a AccountId,
    to: &'a AccountId,
    keys: &'a str,
}

/// `v1.` and base64url, at most `max` characters: a sealed note, key or share as the keeper writes it.
fn sealed_text_ok(s: &str, max: usize) -> bool {
    (4..=max).contains(&s.len())
        && s.starts_with("v1.")
        && s.bytes().skip(3).all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[near]
impl Factory {
    // -------------------------------------------------------------------------------------------------------------
    // View keys: anyone who reads
    // -------------------------------------------------------------------------------------------------------------

    /// The caller registers the X25519 key that sealed histories reach it under, for every mask that grants it a view.
    /// A new key replaces the old one: only races noted after it are sealed for it, and the keeper shares the earlier
    /// races' keys again under it. Pays its own storage; the rest of the deposit comes back.
    #[payable]
    pub fn set_view_key(&mut self, key: String) {
        require!(strategy_key_ok(&key), "key: x25519:<64 lowercase hex>");
        let me = env::predecessor_account_id();
        let before = env::storage_usage();
        let mut keys = keys_map();
        keys.insert(me.clone(), key.clone());
        keys.flush();
        self.charge_storage(before);
        event("view_key", &KeySet { account: &me, key: &key });
    }

    // -------------------------------------------------------------------------------------------------------------
    // View keys: the owner
    // -------------------------------------------------------------------------------------------------------------

    /// The owner lets `viewer` read the mask's race history: every race the keeper notes from now on, and, shared by
    /// the keeper, the races before. The owner reads their own history as a viewer too. At most `MAX_VIEWERS`. Pays its
    /// own storage; the rest of the deposit comes back.
    #[payable]
    pub fn grant_view(&mut self, name: String, viewer: AccountId) -> Vec<Viewer> {
        self.only_owner(&name);
        require!(viewer != self.account_of(&name), "a mask does not read its own history: its owner does");
        let before = env::storage_usage();
        let mut all = viewers_map();
        let mut list = all.get(&name).cloned().unwrap_or_default();
        require!(!list.contains(&viewer), "that account already has a view");
        require!(list.len() < MAX_VIEWERS, "a mask shares its history with at most 16 accounts");
        list.push(viewer.clone());
        all.insert(name.clone(), list);
        all.flush();
        self.charge_storage(before);
        event("grant_view", &Granted { name: &name, viewer: &viewer });
        self.viewers(name)
    }

    /// The owner takes a view back: the keeper seals no race after this for `viewer`. What the storage held comes back
    /// to the owner. Exactly 1 yoctoNEAR attached, as a grant carries its deposit: only a full access key or a wallet's
    /// confirmation sends one, never a function-call key the owner gave an app.
    #[payable]
    pub fn revoke_view(&mut self, name: String, viewer: AccountId) -> Vec<Viewer> {
        require!(env::attached_deposit() == NearToken::from_yoctonear(1), "attach exactly 1 yoctoNEAR");
        let owner = self.only_owner(&name);
        let before = env::storage_usage();
        let mut all = viewers_map();
        let mut list = all.get(&name).cloned().unwrap_or_default();
        let at = list.iter().position(|v| *v == viewer).unwrap_or_else(|| env::panic_str("that account has no view"));
        list.remove(at);
        if list.is_empty() {
            all.remove(&name);
        } else {
            all.insert(name.clone(), list);
        }
        all.flush();
        let freed = u128::from(before.saturating_sub(env::storage_usage()));
        let back = env::storage_byte_cost().as_yoctonear() * freed;
        if back > 0 {
            Promise::new(owner).transfer(NearToken::from_yoctonear(back)).detach();
        }
        event("revoke_view", &Granted { name: &name, viewer: &viewer });
        self.viewers(name)
    }

    // -------------------------------------------------------------------------------------------------------------
    // View keys: the keeper
    // -------------------------------------------------------------------------------------------------------------

    /// The keeper notes one race of a mask: `note`, sealed with that race's own key, and that key sealed for viewers
    /// in `keys`. Every one of them must hold a view now, with the key it registered, and each at most once; a mask with
    /// no viewer gets its note all the same, for whoever is granted later. Nothing is stored: the note is an event of
    /// this transaction. Only the keeper.
    pub fn note(&mut self, name: String, race: String, note: String, keys: Vec<Wrap>) {
        self.only_keeper();
        require!(self.masks.get(&name).is_some(), "no such mask");
        require!(crate::race_ok(&race), "race: 1 to 64 letters, digits, - or _");
        require!(sealed_text_ok(&note, MAX_NOTE), "note: v1. and base64url, sealed for the race");
        let list = viewers_map().get(&name).cloned().unwrap_or_default();
        for (i, w) in keys.iter().enumerate() {
            require!(!keys[..i].iter().any(|o| o.to == w.to), "one key for each viewer");
            require!(list.contains(&w.to), "a race key goes only to an account the owner granted a view");
            require!(keys_map().get(&w.to).is_some(), "that viewer has registered no view key");
            require!(sealed_text_ok(&w.key, MAX_WRAP), "keys: v1. and base64url, sealed for the viewer");
        }
        let account = self.account_of(&name);
        event("note", &Noted { name: &name, account: &account, race: &race, note: &note, keys: &keys });
    }

    /// The keeper hands one viewer the keys of a mask's races noted before it could read them: `keys`, sealed for that
    /// viewer's registered key. Only to an account the owner granted a view, and only the keeper. Nothing is stored.
    pub fn share(&mut self, name: String, to: AccountId, keys: String) {
        self.only_keeper();
        require!(self.masks.get(&name).is_some(), "no such mask");
        require!(
            viewers_map().get(&name).is_some_and(|l| l.contains(&to)),
            "race keys go only to an account the owner granted a view"
        );
        require!(keys_map().get(&to).is_some(), "that viewer has registered no view key");
        require!(sealed_text_ok(&keys, MAX_SHARE), "keys: v1. and base64url, sealed for the viewer");
        let account = self.account_of(&name);
        event("share", &Shared { name: &name, account: &account, to: &to, keys: &keys });
    }

    // -------------------------------------------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------------------------------------------

    /// Who may read a mask's history, in the order the owner granted it, each with the key it registered.
    pub fn viewers(&self, name: String) -> Vec<Viewer> {
        let keys = keys_map();
        viewers_map()
            .get(&name)
            .map(|list| list.iter().map(|a| Viewer { account: a.clone(), key: keys.get(a).cloned() }).collect())
            .unwrap_or_default()
    }

    /// The view key `account` registered, if any.
    pub fn view_key_of(&self, account: AccountId) -> Option<String> {
        keys_map().get(&account).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Catalog, MaskView};
    use near_sdk::serde_json::{json, Value};
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::{mock::MockAction, testing_env};

    const ONE: u128 = 10u128.pow(24);
    const KEY: &str = "x25519:0d58a54f7bb7a7f3d3c4f15e1c7b0f8ad2a43b5cd8c3c1d06f2c4f3a8f5b6e70";
    const ANN_KEY: &str = "x25519:1111111111111111111111111111111111111111111111111111111111111111";
    const EVE_KEY: &str = "x25519:2222222222222222222222222222222222222222222222222222222222222222";

    fn acc(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn ctx(who: &str, deposit: u128) {
        let mut c = VMContextBuilder::new();
        c.current_account_id(acc("masks.near"))
            .signer_account_id(acc(who))
            .predecessor_account_id(acc(who))
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .account_balance(NearToken::from_near(100));
        testing_env!(c.build());
    }

    /// The factory with KIRA forged by ann.near, its account made.
    fn factory() -> Factory {
        ctx("admin.near", 0);
        let catalog = Catalog {
            models: vec!["z-ai/glm-5.3-flash".into()],
            looks: vec!["porcelain".into()],
            styles: vec!["patient".into()],
        };
        let mut f = Factory::new(
            acc("admin.near"),
            acc("keeper.near"),
            acc("treasury.near"),
            acc("bounty.near"),
            "aa1fd9b4ad6a3cd5d0f6e4c4dd34e5c1bd5c9bce4f2af3b9a54d6b6cd8f5e301".into(),
            Some(KEY.into()),
            catalog,
            60,
            vec![acc("team.near")],
        );
        f.mask_code.published = true;
        ctx("ann.near", 2 * ONE);
        let _ = f.forge(
            "kira".into(),
            "porcelain".into(),
            "z-ai/glm-5.3-flash".into(),
            "patient".into(),
            None,
            None,
            None,
            None,
        );
        ctx("masks.near", 0);
        let _: Option<MaskView> = f.on_forged("kira".into(), Ok(()));
        f
    }

    fn panics<T>(f: impl FnOnce() -> T) -> String {
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        std::panic::set_hook(hook);
        match r {
            Ok(_) => panic!("expected a panic"),
            Err(e) => {
                let text = e
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_default();
                // `env::panic_str` in the mocked chain panics with the host error around the message.
                match text.split_once("panic_msg: \"") {
                    Some((_, rest)) => rest.split('"').next().unwrap_or_default().to_string(),
                    None => text,
                }
            }
        }
    }

    fn sealed(n: usize) -> String {
        format!("v1.{}", "A".repeat(n))
    }

    fn events() -> Vec<Value> {
        get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|l| near_sdk::serde_json::from_str(l).unwrap())
            .collect()
    }

    /// What the call sent back to `who` in plain transfers.
    fn refunds_to(who: &str) -> u128 {
        get_created_receipts()
            .iter()
            .filter(|r| r.receiver_id.as_str() == who)
            .flat_map(|r| r.actions.iter())
            .map(|a| match a {
                MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
                _ => 0,
            })
            .sum()
    }

    #[test]
    fn only_the_owner_grants_and_revokes_and_the_list_has_bounds() {
        let mut f = factory();
        ctx("eve.near", ONE);
        assert_eq!(panics(|| f.grant_view("kira".into(), acc("eve.near"))), "only the mask's owner");
        ctx("ann.near", ONE);
        assert_eq!(
            panics(|| f.grant_view("kira".into(), acc("kira.masks.near"))),
            "a mask does not read its own history: its owner does"
        );
        let list = f.grant_view("kira".into(), acc("ann.near"));
        assert_eq!(list, vec![Viewer { account: acc("ann.near"), key: None }]);
        ctx("ann.near", ONE);
        assert_eq!(panics(|| f.grant_view("kira".into(), acc("ann.near"))), "that account already has a view");
        for i in 1..MAX_VIEWERS {
            ctx("ann.near", ONE);
            f.grant_view("kira".into(), acc(&format!("v{i}.near")));
        }
        ctx("ann.near", ONE);
        assert_eq!(
            panics(|| f.grant_view("kira".into(), acc("late.near"))),
            "a mask shares its history with at most 16 accounts"
        );
        ctx("eve.near", 1);
        assert_eq!(panics(|| f.revoke_view("kira".into(), acc("v1.near"))), "only the mask's owner");
        ctx("ann.near", 1);
        assert_eq!(panics(|| f.revoke_view("kira".into(), acc("eve.near"))), "that account has no view");
        let left = f.revoke_view("kira".into(), acc("v1.near"));
        assert_eq!(left.len(), MAX_VIEWERS - 1);
        assert!(!left.iter().any(|v| v.account.as_str() == "v1.near"));
        assert_eq!(events().last().unwrap()["event"], "revoke_view");
    }

    #[test]
    fn a_grant_with_no_deposit_for_its_storage_is_refused() {
        let mut f = factory();
        ctx("ann.near", 0);
        assert_eq!(panics(|| f.grant_view("kira".into(), acc("bob.near"))), "attach at least the storage this adds");
    }

    /// A revoke takes exactly 1 yoctoNEAR, so a function-call key an app holds for the owner cannot take a view back.
    #[test]
    fn a_revoke_takes_exactly_one_yocto() {
        let mut f = factory();
        ctx("ann.near", ONE);
        f.grant_view("kira".into(), acc("bob.near"));
        for deposit in [0, 2] {
            ctx("ann.near", deposit);
            assert_eq!(panics(|| f.revoke_view("kira".into(), acc("bob.near"))), "attach exactly 1 yoctoNEAR");
        }
        assert_eq!(f.viewers("kira".into()).len(), 1, "a refused revoke changes nothing");
        ctx("ann.near", 1);
        assert!(f.revoke_view("kira".into(), acc("bob.near")).is_empty());
    }

    #[test]
    fn a_grant_pays_its_storage_and_a_revoke_gives_it_back() {
        let mut f = factory();
        ctx("ann.near", ONE);
        let before = env::storage_usage();
        f.grant_view("kira".into(), acc("bob.near"));
        let grew = u128::from(env::storage_usage() - before);
        let cost = env::storage_byte_cost().as_yoctonear() * grew;
        assert!(grew > 0);
        assert_eq!(refunds_to("ann.near"), ONE - cost, "the rest of the deposit comes back");
        ctx("ann.near", 1);
        f.revoke_view("kira".into(), acc("bob.near"));
        assert_eq!(refunds_to("ann.near"), cost, "the freed storage goes back to the owner");
        assert!(f.viewers("kira".into()).is_empty());
    }

    #[test]
    fn a_view_key_is_registered_once_for_every_mask_and_shown_with_the_viewer() {
        let mut f = factory();
        ctx("bob.near", ONE);
        assert_eq!(panics(|| f.set_view_key("ed25519:abc".into())), "key: x25519:<64 lowercase hex>");
        ctx("bob.near", ONE);
        f.set_view_key(ANN_KEY.into());
        assert_eq!(f.view_key_of(acc("bob.near")).as_deref(), Some(ANN_KEY));
        assert_eq!(events()[0]["event"], "view_key");
        ctx("ann.near", ONE);
        let list = f.grant_view("kira".into(), acc("bob.near"));
        assert_eq!(list[0].key.as_deref(), Some(ANN_KEY));
        // A new key replaces the old one.
        ctx("bob.near", ONE);
        f.set_view_key(EVE_KEY.into());
        assert_eq!(f.viewers("kira".into())[0].key.as_deref(), Some(EVE_KEY));
    }

    #[test]
    fn the_keeper_notes_a_race_only_for_viewers_the_owner_granted() {
        let mut f = factory();
        for (who, key) in [("ann.near", ANN_KEY), ("bob.near", ANN_KEY), ("eve.near", EVE_KEY)] {
            ctx(who, ONE);
            f.set_view_key(key.into());
        }
        ctx("ann.near", ONE);
        f.grant_view("kira".into(), acc("ann.near"));
        ctx("ann.near", ONE);
        f.grant_view("kira".into(), acc("bob.near"));
        ctx("ann.near", ONE);
        f.grant_view("kira".into(), acc("cat.near"));
        let wrap = |to: &str| Wrap { to: acc(to), key: sealed(100) };

        // Only the keeper.
        ctx("ann.near", 0);
        assert_eq!(
            panics(|| f.note("kira".into(), "h0001".into(), sealed(400), vec![])),
            "only the keeper arms and settles races"
        );
        ctx("keeper.near", 0);
        assert_eq!(panics(|| f.note("nope".into(), "h0001".into(), sealed(400), vec![])), "no such mask");
        assert_eq!(
            panics(|| f.note("kira".into(), "h 1".into(), sealed(400), vec![])),
            "race: 1 to 64 letters, digits, - or _"
        );
        assert_eq!(
            panics(|| f.note("kira".into(), "h0001".into(), "plain text".into(), vec![])),
            "note: v1. and base64url, sealed for the race"
        );
        // EVE holds a key but no view; CAT holds a view but no key; BOB's key twice.
        assert_eq!(
            panics(|| f.note("kira".into(), "h0001".into(), sealed(400), vec![wrap("eve.near")])),
            "a race key goes only to an account the owner granted a view"
        );
        assert_eq!(
            panics(|| f.note("kira".into(), "h0001".into(), sealed(400), vec![wrap("cat.near")])),
            "that viewer has registered no view key"
        );
        assert_eq!(
            panics(|| f.note("kira".into(), "h0001".into(), sealed(400), vec![wrap("bob.near"), wrap("bob.near")])),
            "one key for each viewer"
        );
        assert_eq!(
            panics(|| f.note(
                "kira".into(),
                "h0001".into(),
                sealed(400),
                vec![Wrap { to: acc("bob.near"), key: sealed(MAX_WRAP) }]
            )),
            "keys: v1. and base64url, sealed for the viewer"
        );

        let storage = env::storage_usage();
        f.note("kira".into(), "h0001".into(), sealed(400), vec![wrap("ann.near"), wrap("bob.near")]);
        assert_eq!(env::storage_usage(), storage, "a note stores nothing");
        let e = events().pop().unwrap();
        assert_eq!(e["event"], "note");
        assert_eq!(
            e["data"],
            json!({ "name": "kira", "account": "kira.masks.near", "race": "h0001", "note": sealed(400),
                    "keys": [{ "to": "ann.near", "key": sealed(100) }, { "to": "bob.near", "key": sealed(100) }] })
        );
        // A note with no viewer at all still goes on chain, for whoever is granted later.
        f.note("kira".into(), "h0002".into(), sealed(400), vec![]);

        // After a revoke, BOB gets no key to the next race.
        ctx("ann.near", 1);
        f.revoke_view("kira".into(), acc("bob.near"));
        ctx("keeper.near", 0);
        assert_eq!(
            panics(|| f.note("kira".into(), "h0003".into(), sealed(400), vec![wrap("bob.near")])),
            "a race key goes only to an account the owner granted a view"
        );
    }

    #[test]
    fn the_keeper_shares_the_earlier_races_only_with_a_granted_viewer() {
        let mut f = factory();
        ctx("bob.near", ONE);
        f.set_view_key(ANN_KEY.into());
        ctx("eve.near", ONE);
        f.set_view_key(EVE_KEY.into());
        ctx("ann.near", ONE);
        f.grant_view("kira".into(), acc("bob.near"));
        ctx("bob.near", 0);
        assert_eq!(
            panics(|| f.share("kira".into(), acc("bob.near"), sealed(300))),
            "only the keeper arms and settles races"
        );
        ctx("keeper.near", 0);
        assert_eq!(
            panics(|| f.share("kira".into(), acc("eve.near"), sealed(300))),
            "race keys go only to an account the owner granted a view"
        );
        assert_eq!(
            panics(|| f.share("kira".into(), acc("bob.near"), sealed(MAX_SHARE))),
            "keys: v1. and base64url, sealed for the viewer"
        );
        f.share("kira".into(), acc("bob.near"), sealed(300));
        let e = events().pop().unwrap();
        assert_eq!(e["event"], "share");
        assert_eq!(e["data"]["to"], "bob.near");
        assert_eq!(e["data"]["account"], "kira.masks.near");
    }

    /// The two maps sit apart from the root: their prefixes are not the one-byte prefixes `Key` gives the root's own
    /// collections, nor do they start with one.
    #[test]
    fn the_view_maps_share_no_prefix_with_the_root() {
        for k in 0u8..32 {
            assert_ne!(VIEWERS[0], k);
            assert_ne!(VIEW_KEYS[0], k);
        }
        assert_ne!(&VIEWERS[..5], b"STATE");
        assert!(!VIEWERS.starts_with(VIEW_KEYS) && !VIEW_KEYS.starts_with(VIEWERS));
    }
}
