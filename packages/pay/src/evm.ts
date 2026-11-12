/**
 * Paying a Get NEAR deposit address straight from an EVM wallet in the browser (EIP-1193): the network, the transfer and
 * the reads that check it first. Only networks whose chain id is known for certain are here; any other network pays
 * by copying the address, as from an exchange.
 */

export interface EvmChain {
  /** 1Click's network id. */
  readonly id: string;
  readonly chainId: number;
  readonly name: string;
  /** The network's own coin: what a coin without a contract is. */
  readonly native: { readonly symbol: string; readonly decimals: number };
  /** For `wallet_addEthereumChain`, when the wallet does not know the network yet. */
  readonly rpc: string;
  readonly explorer: string;
}

export const EVM_CHAINS: readonly EvmChain[] = [
  { id: "eth", chainId: 1, name: "Ethereum", native: { symbol: "ETH", decimals: 18 }, rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
  { id: "arb", chainId: 42161, name: "Arbitrum One", native: { symbol: "ETH", decimals: 18 }, rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io" },
  { id: "base", chainId: 8453, name: "Base", native: { symbol: "ETH", decimals: 18 }, rpc: "https://mainnet.base.org", explorer: "https://basescan.org" },
  { id: "bsc", chainId: 56, name: "BNB Smart Chain", native: { symbol: "BNB", decimals: 18 }, rpc: "https://bsc-dataseed.bnbchain.org", explorer: "https://bscscan.com" },
  { id: "pol", chainId: 137, name: "Polygon", native: { symbol: "POL", decimals: 18 }, rpc: "https://polygon-rpc.com", explorer: "https://polygonscan.com" },
  { id: "op", chainId: 10, name: "OP Mainnet", native: { symbol: "ETH", decimals: 18 }, rpc: "https://mainnet.optimism.io", explorer: "https://optimistic.etherscan.io" },
  { id: "avax", chainId: 43114, name: "Avalanche C-Chain", native: { symbol: "AVAX", decimals: 18 }, rpc: "https://api.avax.network/ext/bc/C/rpc", explorer: "https://snowtrace.io" },
  { id: "gnosis", chainId: 100, name: "Gnosis", native: { symbol: "xDAI", decimals: 18 }, rpc: "https://rpc.gnosischain.com", explorer: "https://gnosisscan.io" },
  { id: "scroll", chainId: 534352, name: "Scroll", native: { symbol: "ETH", decimals: 18 }, rpc: "https://rpc.scroll.io", explorer: "https://scrollscan.com" },
];

export function evmChainOf(id: string): EvmChain | null {
  return EVM_CHAINS.find((c) => c.id === id) ?? null;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `0x…` with no leading zeros, as EIP-1193 takes a quantity. */
export const quantity = (n: bigint | number): string => `0x${BigInt(n).toString(16)}`;

const word = (n: bigint) => n.toString(16).padStart(64, "0");
const addressWord = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");

/** ERC-20 `transfer(to, amount)`. */
export function erc20Transfer(to: string, amount: bigint): string {
  if (!ADDRESS.test(to)) throw new Error(`not an address: ${to}`);
  if (amount <= 0n || amount >= 2n ** 256n) throw new Error("amount out of range");
  return `0xa9059cbb${addressWord(to)}${word(amount)}`;
}

/** ERC-20 `decimals()`. */
export const ERC20_DECIMALS = "0x313ce567";

/** ERC-20 `balanceOf(owner)`. */
export function erc20BalanceOf(owner: string): string {
  if (!ADDRESS.test(owner)) throw new Error(`not an address: ${owner}`);
  return `0x70a08231${addressWord(owner)}`;
}

/** A uint256 an `eth_call` returned, or `null` for anything else (an empty `0x` from a contract that is not there). */
export function uintOf(result: unknown): bigint | null {
  return typeof result === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(result) ? BigInt(result) : null;
}

/** What a coin from 1Click's list is on an EVM network: a token at its contract, or the network's own coin. */
export type EvmAsset = { readonly kind: "token"; readonly contract: string } | { readonly kind: "native" };

/**
 * The coin as this network carries it, or `null` when a wallet payment cannot be built for it with certainty: a token
 * needs a contract address that 1Click's own asset id names too (`nep141:arb-0xaf88….omft.near`), so the list's
 * contract field alone never decides where the money goes; the network's own coin must be the one this network names.
 * A token whose asset id does not spell its contract (HOT's omni ids) is paid by copying the address.
 */
export function evmAsset(chain: EvmChain, coin: { assetId: string; symbol: string; contract: string | null; decimals: number }): EvmAsset | null {
  if (coin.contract) {
    if (!ADDRESS.test(coin.contract)) return null;
    const named = coin.assetId.toLowerCase().match(/0x[0-9a-f]{40}/g) ?? [];
    return named.length === 1 && named[0] === coin.contract.toLowerCase() ? { kind: "token", contract: coin.contract } : null;
  }
  return coin.symbol === chain.native.symbol && coin.decimals === chain.native.decimals ? { kind: "native" } : null;
}

export interface EvmTx {
  readonly from: string;
  readonly to: string;
  readonly data?: string;
  readonly value: string;
  /** The network it is for: a wallet refuses to send it on any other. */
  readonly chainId: string;
}

/** The one transaction that pays `amount` of the coin to the deposit address, bound to `chain`. */
export function evmPayment(o: { chain: EvmChain; asset: EvmAsset; from: string; depositAddress: string; amount: bigint }): EvmTx {
  if (!ADDRESS.test(o.from)) throw new Error(`not an address: ${o.from}`);
  if (!ADDRESS.test(o.depositAddress)) throw new Error(`not a deposit address: ${o.depositAddress}`);
  if (o.amount <= 0n) throw new Error("amount must be positive");
  const chainId = quantity(o.chain.chainId);
  if (o.asset.kind === "native") return { from: o.from, to: o.depositAddress, value: quantity(o.amount), chainId };
  return { from: o.from, to: o.asset.contract, data: erc20Transfer(o.depositAddress, o.amount), value: "0x0", chainId };
}

/** `wallet_addEthereumChain`'s one parameter. */
export function addChainParams(c: EvmChain) {
  return {
    chainId: quantity(c.chainId),
    chainName: c.name,
    nativeCurrency: { name: c.native.symbol, symbol: c.native.symbol, decimals: c.native.decimals },
    rpcUrls: [c.rpc],
    blockExplorerUrls: [c.explorer],
  };
}

/** A transaction hash a wallet returned. */
export const evmTxOk = (h: unknown): h is string => typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h);
