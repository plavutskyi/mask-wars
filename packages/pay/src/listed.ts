import type { Token } from "./oneclick.ts";

/**
 * What Swap and Get NEAR show: the networks and coins people actually hold, each pinned by 1Click's asset id. Nothing
 * outside this list is shown, searched or quoted, whatever 1Click lists that day: an asset id 1Click adds, renames or
 * reprices stays out until it is written here. Symbols and names are ours, never 1Click's (it calls Tether's token on
 * Arbitrum `USDT0` and Toncoin `GRAM`), and the contract each entry names must match the one 1Click lists for that
 * asset id, or the coin is left out.
 *
 * Where each stablecoin contract was checked, and why it is the one on its network: listed.sources.md.
 */

/** A network the pages show, by the name people know it by, with the explorer that opens a token on it. */
export interface Network {
  /** 1Click's network id. */
  readonly id: string;
  readonly name: string;
  /** The explorer people use on this network, and its token page for a contract; `null` where no token is listed. */
  readonly explorer: { readonly name: string; readonly token: (contract: string) => string } | null;
}

/**
 * The networks, in the order people look for them: NEAR, then where stablecoins and money usually sit. Only these are
 * ever shown, and the network rail follows this order.
 */
export const NETWORKS: readonly Network[] = [
  { id: "near", name: "NEAR", explorer: { name: "NearBlocks", token: (c) => `https://nearblocks.io/token/${c}` } },
  { id: "eth", name: "Ethereum", explorer: { name: "Etherscan", token: (c) => `https://etherscan.io/token/${c}` } },
  { id: "tron", name: "Tron", explorer: { name: "Tronscan", token: (c) => `https://tronscan.org/#/token20/${c}` } },
  { id: "arb", name: "Arbitrum", explorer: { name: "Arbiscan", token: (c) => `https://arbiscan.io/token/${c}` } },
  { id: "sol", name: "Solana", explorer: { name: "Solscan", token: (c) => `https://solscan.io/token/${c}` } },
  { id: "bsc", name: "BNB Chain", explorer: { name: "BscScan", token: (c) => `https://bscscan.com/token/${c}` } },
  { id: "base", name: "Base", explorer: { name: "Basescan", token: (c) => `https://basescan.org/token/${c}` } },
  { id: "btc", name: "Bitcoin", explorer: null },
  { id: "pol", name: "Polygon", explorer: { name: "PolygonScan", token: (c) => `https://polygonscan.com/token/${c}` } },
  { id: "op", name: "Optimism", explorer: { name: "Optimistic Etherscan", token: (c) => `https://optimistic.etherscan.io/token/${c}` } },
  { id: "avax", name: "Avalanche", explorer: { name: "Snowtrace", token: (c) => `https://snowtrace.io/token/${c}` } },
  { id: "ton", name: "TON", explorer: { name: "Tonviewer", token: (c) => `https://tonviewer.com/${c}` } },
  { id: "sui", name: "Sui", explorer: { name: "Suiscan", token: (c) => `https://suiscan.xyz/mainnet/coin/${c}` } },
  { id: "aptos", name: "Aptos", explorer: { name: "Aptos Explorer", token: (c) => `https://explorer.aptoslabs.com/fungible_asset/${c}?network=mainnet` } },
  { id: "xrp", name: "XRP Ledger", explorer: null },
  { id: "doge", name: "Dogecoin", explorer: null },
  { id: "ltc", name: "Litecoin", explorer: null },
  { id: "bch", name: "Bitcoin Cash", explorer: null },
  { id: "zec", name: "Zcash", explorer: null },
  { id: "cardano", name: "Cardano", explorer: null },
  { id: "stellar", name: "Stellar", explorer: null },
];

const NETWORK = new Map(NETWORKS.map((n, i) => [n.id, { ...n, rank: i }]));

/** A listed network, or `null` for one the pages never show. */
export const networkOf = (id: string): Network | null => NETWORK.get(id) ?? null;
/** A network by the name people know it by. */
export const networkName = (id: string): string => NETWORK.get(id)?.name ?? id.toUpperCase();
/** Where a network stands in a list; unlisted ones last. */
export const networkRank = (id: string): number => NETWORK.get(id)?.rank ?? 999;

/**
 * The page that shows a token's contract on its network's explorer, opened by its contract. `null` for a network's own
 * coin (no contract) and for a network with no token listed.
 */
export function tokenLink(chainId: string, contract: string | null | undefined): { name: string; href: string } | null {
  const ex = NETWORK.get(chainId)?.explorer;
  if (!ex || !contract) return null;
  return { name: ex.name, href: ex.token(encodeURI(contract).replace(/#/g, "%23")) };
}

/** Networks whose own coin is Ether: ETH there is native but not the network's own brand. */
const ETHER_HOME = new Set(["arb", "base", "op"]);

/** Whether `coin` is the network's own coin on its own network (ETH on Ethereum, NEAR on NEAR): no network badge. */
export const ownCoinHere = (chainId: string, coin: { readonly native?: boolean | undefined }) => coin.native === true && !ETHER_HOME.has(chainId);

/** What a coin's list price is held to, so a mispriced one is hidden instead of sold at the wrong price. */
type Peg =
  /** A dollar stablecoin: within 3% of $1. */
  | "usd"
  /** Wrapped or bridged bitcoin: within 5% of Bitcoin on Bitcoin. */
  | "btc"
  /** Ether anywhere: within 5% of Ether on Ethereum. */
  | "eth"
  /** A staked or wrapped coin worth a known multiple of another: price ÷ that coin's price in [min, max]. */
  | { readonly of: string; readonly min: number; readonly max: number };

/** A coin the pages show. */
export interface Listed {
  /** 1Click's asset id: the only thing a coin is matched by. */
  readonly assetId: string;
  /** 1Click's network id. */
  readonly chain: string;
  /** As people and exchanges know it. */
  readonly symbol: string;
  /** In full, as the issuer names it. */
  readonly name: string;
  /** A quiet second line where one symbol has a story: `Tether · USD₮0`, `Binance-Peg`. */
  readonly note?: string;
  /** The contract on its network, exactly as 1Click lists it; `null` for the network's own coin. */
  readonly contract: string | null;
  /** Shown as the network's own coin, with no contract to open (NEAR is sent as NEAR, wrapped by the wallet). */
  readonly native?: true;
  /** File in /coins/: the coin's real logo. */
  readonly logo: string;
  /** More words a search finds it by. */
  readonly aka?: readonly string[];
  readonly peg?: Peg;
}

/** The reference prices pegs are held to: Bitcoin on Bitcoin, Ether on Ethereum, NEAR on NEAR. */
export const BTC_ASSET = "nep141:btc.omft.near";
export const ETH_ASSET = "nep141:eth.omft.near";
const NEAR = "nep141:wrap.near";

const omft = (chain: string, address: string) => `nep141:${chain}-${address}.omft.near`;
const omdep = (chain: string, address: string) => `nep141:${chain}-${address}.omdep.near`;
const hotOp = (id: string) => `nep245:v2_1.omni.hot.tg:10_${id}`;

const usdt = (chain: string, assetId: string, contract: string, more: Partial<Listed> = {}): Listed => ({
  assetId,
  chain,
  symbol: "USDT",
  name: "Tether USD",
  contract,
  logo: "usdt.svg",
  aka: ["tether"],
  peg: "usd",
  ...more,
});
const usdc = (chain: string, assetId: string, contract: string, more: Partial<Listed> = {}): Listed => ({
  assetId,
  chain,
  symbol: "USDC",
  name: "USD Coin",
  contract,
  logo: "usdc.svg",
  aka: ["circle"],
  peg: "usd",
  ...more,
});
/** Tether's token where USDT0 runs it: shown as USDT, as exchanges list it, and found by `usdt0` too. */
const USDT0 = { note: "Tether · USD₮0", aka: ["tether", "usdt0", "usd₮0"] } as const;
const ether = (chain: string, assetId: string, more: Partial<Listed> = {}): Listed => ({ assetId, chain, symbol: "ETH", name: "Ether", contract: null, logo: "eth.svg", peg: "eth", ...more });
const coin = (chain: string, assetId: string, symbol: string, name: string, logo: string, more: Partial<Listed> = {}): Listed => ({
  assetId,
  chain,
  symbol,
  name,
  contract: null,
  logo,
  ...more,
});

/**
 * Every coin shown, in the order shown: by network as NETWORKS orders them, and on each network stablecoins, its own
 * coin, bitcoin and ether, then the rest.
 */
export const LISTED: readonly Listed[] = [
  // NEAR
  coin("near", NEAR, "NEAR", "NEAR", "near.svg", { contract: "wrap.near", native: true, aka: ["wnear", "near protocol"] }),
  usdt("near", "nep141:usdt.tether-token.near", "usdt.tether-token.near"),
  usdc("near", "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
  coin("near", "nep141:nbtc.bridge.near", "BTC", "Bitcoin", "btc.svg", { contract: "nbtc.bridge.near", note: "Omni Bridge", aka: ["nbtc", "bitcoin"], peg: "btc" }),
  coin("near", "nep141:2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near", "wBTC", "Wrapped Bitcoin", "wbtc.svg", {
    contract: "2260fac5e5542a773aa44fbcfedf7c193bc2c599.factory.bridge.near",
    note: "Rainbow Bridge",
    aka: ["bitcoin"],
    peg: "btc",
  }),
  ether("near", "nep141:eth.bridge.near", { contract: "eth.bridge.near", note: "Rainbow Bridge" }),
  coin("near", "nep141:meta-pool.near", "stNEAR", "Staked NEAR", "stnear.svg", { contract: "meta-pool.near", note: "Meta Pool", peg: { of: NEAR, min: 1, max: 2.5 } }),
  coin("near", "nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near", "AURORA", "Aurora", "aurora.svg", {
    contract: "aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near",
  }),
  coin("near", "nep141:token.rhealab.near", "RHEA", "Rhea Finance", "rhea.png", { contract: "token.rhealab.near" }),

  // Ethereum
  usdt("eth", omft("eth", "0xdac17f958d2ee523a2206206994597c13d831ec7"), "0xdac17f958d2ee523a2206206994597c13d831ec7"),
  usdc("eth", omft("eth", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
  coin("eth", ETH_ASSET, "ETH", "Ether", "eth.svg"),
  coin("eth", omft("eth", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"), "WBTC", "Wrapped Bitcoin", "wbtc.svg", { contract: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", aka: ["bitcoin"], peg: "btc" }),
  coin("eth", omft("eth", "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"), "cbBTC", "Coinbase Wrapped BTC", "cbbtc.svg", { contract: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", aka: ["bitcoin"], peg: "btc" }),
  coin("eth", omft("eth", "0x6b175474e89094c44da98b954eedeac495271d0f"), "DAI", "Dai", "dai.svg", { contract: "0x6b175474e89094c44da98b954eedeac495271d0f", aka: ["maker", "sky"], peg: "usd" }),
  coin("eth", omft("eth", "0x514910771af9ca656af840dff83e8264ecf986ca"), "LINK", "Chainlink", "link.svg", { contract: "0x514910771af9ca656af840dff83e8264ecf986ca" }),
  coin("eth", omft("eth", "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984"), "UNI", "Uniswap", "uni.svg", { contract: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984" }),
  coin("eth", omft("eth", "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9"), "AAVE", "Aave", "aave.svg", { contract: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9" }),
  coin("eth", omft("eth", "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0"), "wstETH", "Wrapped stETH", "wsteth.png", {
    contract: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
    note: "Lido",
    aka: ["steth", "lido"],
    peg: { of: ETH_ASSET, min: 1, max: 1.6 },
  }),
  coin("eth", omft("eth", "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce"), "SHIB", "Shiba Inu", "shib.svg", { contract: "0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce" }),
  coin("eth", omft("eth", "0x6982508145454ce325ddbe47a25d4ec3d2311933"), "PEPE", "Pepe", "pepe.svg", { contract: "0x6982508145454ce325ddbe47a25d4ec3d2311933" }),
  coin("eth", omft("eth", "0x68749665ff8d2d112fa859aa293f07a622782f38"), "XAUT", "Tether Gold", "xaut.svg", { contract: "0x68749665ff8d2d112fa859aa293f07a622782f38", note: "XAU₮", aka: ["gold", "tether"] }),

  // Tron
  usdt("tron", "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", { note: "TRC-20" }),
  coin("tron", "nep141:tron.omft.near", "TRX", "TRON", "trx.svg"),

  // Arbitrum
  usdt("arb", omft("arb", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"), "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", USDT0),
  usdc("arb", omft("arb", "0xaf88d065e77c8cc2239327c5edb3a432268e5831"), "0xaf88d065e77c8cc2239327c5edb3a432268e5831"),
  ether("arb", "nep141:arb.omft.near"),
  coin("arb", omft("arb", "0x912ce59144191c1204e64559fe8253a0e49e6548"), "ARB", "Arbitrum", "arb.svg", { contract: "0x912ce59144191c1204e64559fe8253a0e49e6548" }),

  // Solana
  usdt("sol", "nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", { note: "SPL" }),
  usdc("sol", "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", { note: "SPL" }),
  coin("sol", "nep141:sol.omft.near", "SOL", "Solana", "sol.svg"),

  // BNB Chain: neither Tether nor Circle issues on it; the USDT and USDC there are Binance's own pegged tokens, the ones
  // Binance, OKX and Bybit pay out on BNB Smart Chain, and the page says so.
  usdt("bsc", omdep("bnb", "0x55d398326f99059ff775485246999027b3197955"), "0x55d398326f99059ff775485246999027b3197955", { note: "Binance-Peg", aka: ["tether", "bsc-usd", "bep20", "bep-20"] }),
  usdc("bsc", omdep("bnb", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"), "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", { note: "Binance-Peg", aka: ["circle", "bep20", "bep-20"] }),
  coin("bsc", "nep141:bnb.omdep.near", "BNB", "BNB", "bnb.svg", { aka: ["binance"] }),

  // Base
  usdc("base", omft("base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"),
  ether("base", "nep141:base.omft.near"),
  coin("base", omft("base", "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"), "cbBTC", "Coinbase Wrapped BTC", "cbbtc.svg", { contract: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", aka: ["bitcoin"], peg: "btc" }),

  // Bitcoin
  coin("btc", BTC_ASSET, "BTC", "Bitcoin", "btc.svg"),

  // Polygon: USDT0 runs Tether's token here, upgraded in place on the same contract.
  usdt("pol", omdep("pol", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f"), "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", USDT0),
  usdc("pol", omdep("pol", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"), "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"),
  coin("pol", "nep141:pol.omdep.near", "POL", "Polygon Ecosystem Token", "pol.svg", { aka: ["matic"] }),

  // Optimism: USDT0's contract, the one OKX and Bitfinex pay out on Optimism; the old bridged USDT is left out.
  usdt("op", hotOp("2R1RXDBxCyJTeMEsdXydh7xsHmz"), "0x01bff41798a0bcf287b996046ca68b395dbc1071", USDT0),
  usdc("op", hotOp("A2ewyUyDp6qsue1jqZsGypkCxRJ"), "0x0b2c639c533813f4aa9d7837caf62653d097ff85"),
  ether("op", hotOp("11111111111111111111")),
  coin("op", hotOp("vLAiSt9KfUGKpw5cD3vsSyNYBo7"), "OP", "Optimism", "op.svg", { contract: "0x4200000000000000000000000000000000000042" }),

  // Avalanche
  usdt("avax", omdep("avax", "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7"), "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7"),
  usdc("avax", omdep("avax", "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"), "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e"),
  coin("avax", "nep141:avax.omdep.near", "AVAX", "Avalanche", "avax.svg"),

  // TON
  usdt("ton", "nep245:v2_1.omni.hot.tg:1117_3tsdfyziyc7EJbP2aULWSKU4toBaAcN4FdTgfm5W1mC4ouR", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", { note: "Jetton" }),
  coin("ton", "nep245:v2_1.omni.hot.tg:1117_", "GRAM", "Gram", "gram.svg", { note: "prev. Toncoin", aka: ["toncoin", "ton"] }),

  // Sui
  usdc("sui", "nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near", "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"),
  coin("sui", "nep141:sui.omft.near", "SUI", "Sui", "sui.svg"),

  // Aptos
  usdt("aptos", "nep141:aptos-88cb7619440a914fe6400149a12b443c3ac21d59.omft.near", "0x357b0b74bc833e95a115ad22604854d6b0fca151cecd94111770e5d6ffc9dc2b"),
  usdc("aptos", "nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near", "0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b"),
  coin("aptos", "nep141:aptos.omft.near", "APT", "Aptos", "apt.svg"),

  // Coins that are their own network
  coin("xrp", "nep141:xrp.omft.near", "XRP", "XRP", "xrp.svg", { aka: ["ripple"] }),
  coin("doge", "nep141:doge.omft.near", "DOGE", "Dogecoin", "doge.svg"),
  coin("ltc", "nep141:ltc.omft.near", "LTC", "Litecoin", "ltc.svg"),
  coin("bch", "nep141:bch.omft.near", "BCH", "Bitcoin Cash", "bch.svg"),
  coin("zec", "nep141:zec.omft.near", "ZEC", "Zcash", "zec.svg"),
  coin("cardano", "nep141:cardano.omft.near", "ADA", "Cardano", "ada.svg"),
  coin("stellar", "nep245:v2_1.omni.hot.tg:1100_111bzQBB5v7AhLyPMDwS8uJgQV24KaAPXtwyVWu2KXbbfQU6NXRCz", "XLM", "Stellar Lumens", "xlm.svg"),
];

const LISTED_BY_ID = new Map(LISTED.map((l) => [l.assetId, l]));

/** The listed entry for an asset id, or `null`: an asset that is not here is never shown or quoted. */
export const listedOf = (assetId: string): Listed | null => LISTED_BY_ID.get(assetId) ?? null;

/** Whether a list price is one this entry can really have, against the reference prices in the same list. */
export function priceSane(l: Listed, price: number, priceOf: (assetId: string) => number | null): boolean {
  if (!(price > 0) || !Number.isFinite(price)) return false;
  const p = l.peg;
  if (!p) return true;
  const within = (ref: number | null, min: number, max: number) => ref !== null && ref > 0 && price / ref >= min && price / ref <= max;
  if (p === "usd") return within(1, 0.97, 1.03);
  if (p === "btc") return within(priceOf(BTC_ASSET), 0.95, 1.05);
  if (p === "eth") return within(priceOf(ETH_ASSET), 0.95, 1.05);
  return within(priceOf(p.of), p.min, p.max);
}

/** One contract: an EVM address is the same in any letter case (1Click sends some checksummed), every other one exactly. */
const sameContract = (a: string | null, b: string | null) => a === b || (a !== null && b !== null && /^0x[0-9a-f]+$/i.test(a) && a.toLowerCase() === b.toLowerCase());

/**
 * The listed coins 1Click quotes today, in list order, each with its token: on the network the entry names, with the
 * contract it names, a whole number of decimals, and a list price that is plausible for it. Anything else is left out.
 */
export function listedTokens(tokens: readonly Token[]): { listed: Listed; token: Token }[] {
  const byId = new Map<string, Token>();
  for (const t of tokens) if (LISTED_BY_ID.has(t.assetId) && !byId.has(t.assetId)) byId.set(t.assetId, t);
  const priceOf = (id: string) => {
    const t = byId.get(id);
    return t && t.price > 0 ? t.price : null;
  };
  const out: { listed: Listed; token: Token }[] = [];
  for (const l of LISTED) {
    const t = byId.get(l.assetId);
    if (!t || t.blockchain !== l.chain || !sameContract(t.contractAddress ?? null, l.contract) || !Number.isInteger(t.decimals) || t.decimals < 0) continue;
    if (!priceSane(l, t.price, priceOf)) continue;
    out.push({ listed: l, token: t });
  }
  return out;
}
