// Which NEAR network a check reads, and where each one is read from: the same endpoints, in the same order, as
// packages/check/src/network.ts. They are fixed in the wasm, so the module's sha256 names them too.

use crate::account::{is_testnet_name, trimmed};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Network {
    Testnet,
    Mainnet,
}

pub const TESTNET_RPCS: [&str; 2] = ["https://rpc.testnet.fastnear.com", "https://rpc.testnet.near.org"];

/// Two independent providers, FastNEAR and dRPC.
pub const MAINNET_RPCS: [&str; 2] = ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"];

/// FastNEAR's regular mainnet node keeps about 17 h of blocks; its archival node answers for older ones.
pub const MAINNET_ARCHIVAL: [(&str, &str); 1] = [("https://rpc.mainnet.fastnear.com", "https://archival-rpc.mainnet.fastnear.com")];

impl Network {
    pub fn parse(name: &str) -> Option<Network> {
        match name {
            "testnet" => Some(Network::Testnet),
            "mainnet" => Some(Network::Mainnet),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Network::Testnet => "testnet",
            Network::Mainnet => "mainnet",
        }
    }

    /// The network an account id names when the caller does not say: `.testnet` reads testnet; `.near`, implicit ids
    /// and every other name read mainnet, where the money is.
    pub fn of(account: &str) -> Network {
        if is_testnet_name(&trimmed(account).to_lowercase()) {
            Network::Testnet
        } else {
            Network::Mainnet
        }
    }

    pub fn rpc(self) -> &'static [&'static str] {
        match self {
            Network::Testnet => &TESTNET_RPCS,
            Network::Mainnet => &MAINNET_RPCS,
        }
    }

    /// Per endpoint, an archival node of the same provider, asked only for a block that endpoint no longer keeps.
    pub fn archival(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Network::Testnet => &[],
            Network::Mainnet => &MAINNET_ARCHIVAL,
        }
    }

    /// Every read goes to every endpoint and counts only when the answers match.
    pub fn cross_check(self) -> bool {
        self == Network::Mainnet
    }

    pub fn explorer(self) -> &'static str {
        match self {
            Network::Testnet => "https://testnet.nearblocks.io",
            Network::Mainnet => "https://nearblocks.io",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_account_names_the_network() {
        assert_eq!(Network::of("safe-0001.tinygif8324.testnet"), Network::Testnet);
        assert_eq!(Network::of("  Alice.TESTNET "), Network::Testnet);
        assert_eq!(Network::of("\u{feff}alice.testnet"), Network::Testnet);
        assert_eq!(Network::of("alice.testnet\u{85}"), Network::Mainnet);
        assert_eq!(Network::of("intents.near"), Network::Mainnet);
        assert_eq!(Network::of(&"be".repeat(32)), Network::Mainnet);
        assert_eq!(Network::of("aurora"), Network::Mainnet);
    }
}
