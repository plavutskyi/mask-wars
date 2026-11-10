// The shared list, read by the rules of packages/check/src/list.ts. The module carries the two lists of the repo
// (packages/check/list.json for testnet, list.mainnet.json for mainnet), so its sha256 names them: a version of the
// module is a version of the lists.
// - `arena`: a live safe on the arena. The file only says where to look; what happened to the safe is read from the
//   chain on every check, so an entry can never claim a drain the chain does not show.
// - `reports`: an account someone reported, with the evidence attached.

use crate::account::{account_ok, is_mainnet_name, is_testnet_name};
use crate::encode::hash_ok;
use crate::network::Network;
use crate::time::date_ok;
use serde::{Deserialize, Serialize};

pub const TESTNET: &str = include_str!("../../../packages/check/list.json");
pub const MAINNET: &str = include_str!("../../../packages/check/list.mainnet.json");

#[derive(Deserialize, Debug, Clone)]
pub struct ArenaEntry {
    /// The bounty contract that holds the race.
    pub contract: String,
    pub race: String,
    /// The live safe the race is on.
    pub safe: String,
    /// Who owned the safe when the race opened; anyone else owning it means a mask took it over.
    pub owner_at_open: String,
    pub note: String,
}

/// One piece of evidence. Fields the list's rules do not name are dropped, as the TypeScript check drops them.
#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Evidence {
    Tx {
        hash: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
    Url {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
}

#[derive(Deserialize, Debug, Clone)]
pub struct Report {
    pub account: String,
    /// `block` or `warn`.
    pub level: String,
    pub reason: String,
    pub evidence: Vec<Evidence>,
    pub reported_by: String,
    pub added: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct SharedList {
    pub network: String,
    pub about: String,
    pub arena: Vec<ArenaEntry>,
    pub reports: Vec<Report>,
}

impl SharedList {
    pub fn network(&self) -> Network {
        Network::parse(&self.network).expect("checked when the list was read")
    }
}

/// A URL with a scheme and something after it, without spaces.
fn url_ok(url: &str) -> bool {
    let Some((scheme, rest)) = url.split_once(':') else {
        return false;
    };
    let named = scheme.starts_with(|c: char| c.is_ascii_alphabetic()) && scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c));
    named && !rest.trim_start_matches('/').is_empty() && !url.chars().any(char::is_whitespace)
}

pub fn parse_list(raw: &str) -> Result<SharedList, String> {
    let list: SharedList = serde_json::from_str(raw).map_err(|e| format!("the shared list does not parse: {e}"))?;
    let network = Network::parse(&list.network).ok_or("the shared list names no network")?;
    // A list names accounts of its own network only: a testnet safe in the mainnet list would read as no account.
    let foreign: fn(&str) -> bool = if network == Network::Mainnet { is_testnet_name } else { is_mainnet_name };
    let named = |account: &str, at: String| {
        if !account_ok(account) {
            Err(format!("{at}: {account} is not a NEAR account id"))
        } else if foreign(account) {
            Err(format!("{at}: {account} is not a {} account", network.name()))
        } else {
            Ok(())
        }
    };
    for (i, e) in list.arena.iter().enumerate() {
        for account in [&e.contract, &e.safe, &e.owner_at_open] {
            named(account, format!("arena {i}"))?;
        }
        if e.race.is_empty() {
            return Err(format!("arena {i}: no race"));
        }
    }
    for (i, r) in list.reports.iter().enumerate() {
        named(&r.account, format!("reports {i}"))?;
        let evidence_ok = r.evidence.iter().all(|e| match e {
            Evidence::Tx { hash, .. } => hash_ok(hash),
            Evidence::Url { url, .. } => url_ok(url),
        });
        if !matches!(r.level.as_str(), "block" | "warn") || r.reason.is_empty() || r.reported_by.is_empty() || !date_ok(&r.added) {
            return Err(format!("reports {i}: a report needs a level, a reason, who reported it and the day"));
        }
        if r.evidence.is_empty() || !evidence_ok {
            return Err(format!("reports {i}: a report needs evidence, a transaction hash or a URL"));
        }
    }
    Ok(list)
}

/// The shared list of a network, as it is in this version of the module.
pub fn shared(network: Network) -> Result<SharedList, String> {
    parse_list(match network {
        Network::Testnet => TESTNET,
        Network::Mainnet => MAINNET,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TX: &str = "9fWpu8aYc4ZbbGAfRRaRjP8dsRj3wvJZXzW7dG8u4nyH";

    fn list(network: &str, reports: serde_json::Value) -> String {
        json!({ "network": network, "about": "test", "arena": [], "reports": reports }).to_string()
    }

    fn report(account: &str, evidence: serde_json::Value) -> serde_json::Value {
        json!([{ "account": account, "level": "block", "reason": "Swept a faucet.", "evidence": evidence, "reported_by": "maskwars", "added": "2026-11-06" }])
    }

    #[test]
    fn the_lists_of_the_repo_parse_and_name_their_network() {
        assert_eq!(shared(Network::Testnet).unwrap().network(), Network::Testnet);
        assert_eq!(shared(Network::Mainnet).unwrap().network(), Network::Mainnet);
        assert!(shared(Network::Testnet).unwrap().arena.iter().any(|a| a.safe == "safe-0001.tinygif8324.testnet"));
    }

    #[test]
    fn a_report_needs_evidence() {
        assert!(parse_list(&list("testnet", report("x.testnet", json!([{ "kind": "tx", "hash": TX }])))).is_ok());
        assert!(parse_list(&list("testnet", report("x.testnet", json!([{ "kind": "url", "url": "https://example.com/post" }])))).is_ok());
        for bad in
            [json!([]), json!([{ "kind": "tx", "hash": "0OIl" }]), json!([{ "kind": "url", "url": "not a url" }]), json!([{ "kind": "rumour" }])]
        {
            assert!(parse_list(&list("testnet", report("x.testnet", bad.clone()))).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_list_names_accounts_of_its_own_network_only() {
        let tx = json!([{ "kind": "tx", "hash": TX }]);
        assert!(parse_list(&list("mainnet", report("x.testnet", tx.clone()))).unwrap_err().contains("is not a mainnet account"));
        assert!(parse_list(&list("testnet", report("x.near", tx.clone()))).unwrap_err().contains("is not a testnet account"));
        assert!(parse_list(&list("mainnet", report("x.near", tx.clone()))).is_ok());
        assert!(parse_list(&list("devnet", report("x.near", tx))).is_err());
    }

    #[test]
    fn evidence_keeps_only_the_fields_the_rules_name() {
        let e: Evidence = serde_json::from_value(json!({ "kind": "tx", "hash": TX, "extra": 1 })).unwrap();
        assert_eq!(serde_json::to_value(e).unwrap(), json!({ "kind": "tx", "hash": TX }));
    }
}
