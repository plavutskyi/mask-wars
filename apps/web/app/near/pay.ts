import {
  addChainParams,
  ERC20_DECIMALS,
  erc20BalanceOf,
  evmAsset,
  evmChainOf,
  evmPayment,
  evmTxOk,
  quantity,
  solanaPayment,
  solanaSignature,
  uintOf,
  type EvmChain,
  type NearCoin,
  type SolanaAsset,
} from '@maskwars/pay';

/**
 * Paying the deposit address straight from a wallet in this browser, instead of copying it: EVM wallets found through
 * EIP-6963 (or the one at `window.ethereum`) and Solana wallets through the Wallet Standard. Each builds one plain
 * transfer of exactly the quoted amount to the deposit address and lets the wallet sign it; the address, the amount and
 * the coin are the ones the page already read back from the quote. Nothing here holds a key. Tron pays by copying the
 * address: TronLink's own node, decimals and energy are not checked here yet, so no Tron button is offered.
 */

export type Family = 'evm' | 'solana';

export interface Wallet {
  readonly id: string;
  readonly family: Family;
  readonly name: string;
  /** A data: or https: image the wallet announced, for its button. */
  readonly icon: string | null;
}

export type Step = 'connect' | 'network' | 'check' | 'confirm';

/**
 * Why a wallet payment did not go. `rent`: too little SOL to open the deposit's token account; `gas`: too little NEAR
 * for a NEAR wallet's transaction; `account`: the wallet is on another account than the one the refund was quoted to;
 * `unclear`: the wallet answered without saying whether it sent, so paying again could pay twice.
 */
export type PayProblem = 'cancelled' | 'funds' | 'rent' | 'gas' | 'network' | 'coin' | 'wallet' | 'account' | 'unclear';

export class PayFailed extends Error {
  readonly problem: PayProblem;
  /** What the wallet holds of the coin, in its units, when that is why. */
  readonly have: bigint | null;
  constructor(problem: PayProblem, have: bigint | null = null) {
    super(problem);
    this.problem = problem;
    this.have = have;
  }
}

/** Which family of wallet pays on a 1Click network; `null` where only the address does (exchanges, Tron, Bitcoin, …). */
export function familyOf(chainId: string): Family | null {
  if (evmChainOf(chainId)) return 'evm';
  if (chainId === 'sol') return 'solana';
  return null;
}

/** Whether a wallet here can pay this coin on this network for certain; otherwise only the address is offered. */
export function payable(chainId: string, coin: NearCoin): boolean {
  const chain = evmChainOf(chainId);
  if (chain) return evmAsset(chain, coin) !== null;
  if (chainId === 'sol') return coin.contract ? solanaKeyOk(coin.contract) : coin.symbol === 'SOL' && coin.decimals === 9;
  return false;
}

const solanaKeyOk = (a: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

// ---- Finding wallets ----

interface Eip1193 {
  request(a: { method: string; params?: unknown }): Promise<unknown>;
}

interface StandardWallet {
  readonly name: string;
  readonly icon?: string;
  readonly chains: readonly string[];
  readonly features: Record<string, unknown>;
  readonly accounts: readonly { address: string }[];
}

declare global {
  interface Window {
    ethereum?: Eip1193 & { isMetaMask?: boolean; isRabby?: boolean; isTrust?: boolean; isCoinbaseWallet?: boolean };
  }
}

const evm = new Map<string, { wallet: Wallet; provider: Eip1193 }>();
const solana = new Map<string, { wallet: Wallet; standard: StandardWallet }>();
const listeners = new Set<() => void>();
let started = false;

const tell = () => listeners.forEach((f) => f());
const safeIcon = (icon: unknown) => (typeof icon === 'string' && /^(data:image\/|https:\/\/)/.test(icon) ? icon : null);

function addSolana(w: StandardWallet) {
  if (!w?.chains?.includes('solana:mainnet') || !w.features?.['solana:signAndSendTransaction'] || !w.features?.['standard:connect']) return;
  const id = `solana:${w.name}`;
  if (!solana.has(id)) {
    solana.set(id, { wallet: { id, family: 'solana', name: w.name, icon: safeIcon(w.icon) }, standard: w });
    tell();
  }
}

/** Starts listening for wallets once: EIP-6963 announcements, Wallet Standard registrations, and the injected ones. */
function start() {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('eip6963:announceProvider', (e: Event) => {
    const d = (e as CustomEvent<{ info?: { uuid?: string; name?: string; icon?: string; rdns?: string }; provider?: Eip1193 }>).detail;
    if (!d?.provider || typeof d.provider.request !== 'function' || !d.info?.name) return;
    const id = `evm:${d.info.rdns ?? d.info.uuid ?? d.info.name}`;
    if (!evm.has(id)) {
      evm.set(id, { wallet: { id, family: 'evm', name: d.info.name, icon: safeIcon(d.info.icon) }, provider: d.provider });
      tell();
    }
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const api = { register: (...wallets: StandardWallet[]) => (wallets.forEach(addSolana), () => {}) };
  window.addEventListener('wallet-standard:register-wallet', (e: Event) => {
    const cb = (e as CustomEvent<(a: typeof api) => void>).detail;
    if (typeof cb === 'function') cb(api);
  });
  window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  // A wallet that predates EIP-6963 is only at window.ethereum: it counts when nothing announced itself.
  setTimeout(() => {
    const eth = window.ethereum;
    if (eth && typeof eth.request === 'function' && evm.size === 0) {
      const name = eth.isRabby ? 'Rabby' : eth.isTrust ? 'Trust Wallet' : eth.isCoinbaseWallet ? 'Coinbase Wallet' : eth.isMetaMask ? 'MetaMask' : 'Browser wallet';
      evm.set('evm:injected', { wallet: { id: 'evm:injected', family: 'evm', name, icon: null }, provider: eth });
      tell();
    }
    tell();
  }, 400);
}

/** The wallets in this browser that can pay on `chainId`, kept current as they announce themselves. */
export function walletsFor(chainId: string): Wallet[] {
  const f = familyOf(chainId);
  if (f === 'evm') return [...evm.values()].map((x) => x.wallet);
  if (f === 'solana') return [...solana.values()].map((x) => x.wallet);
  return [];
}

/** Calls `f` whenever a wallet shows up; starts looking on first use. */
export function watchWallets(f: () => void): () => void {
  listeners.add(f);
  start();
  return () => void listeners.delete(f);
}

// ---- Paying ----

export interface Payment {
  readonly chainId: string;
  readonly coin: NearCoin;
  readonly depositAddress: string;
  readonly amount: bigint;
  /** The address a refund was quoted to (Swap): the wallet must pay from it, or a refund would go to another account. */
  readonly payer?: string;
}

const code = (e: unknown) => (e && typeof e === 'object' && 'code' in e ? (e as { code: unknown }).code : null);
const declined = (e: unknown) => code(e) === 4001 || code(e) === 'ACTION_REJECTED' || /reject|denied|cancel/i.test(String((e as Error)?.message ?? e));

async function payEvm(provider: Eip1193, chain: EvmChain, p: Payment, step: (s: Step) => void): Promise<string> {
  const asset = evmAsset(chain, p.coin);
  if (!asset) throw new PayFailed('coin');
  step('connect');
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  const from = accounts?.[0];
  if (!from) throw new PayFailed('wallet');
  if (p.payer && from.toLowerCase() !== p.payer.toLowerCase()) throw new PayFailed('account');
  step('network');
  const want = quantity(chain.chainId);
  const now = String(await provider.request({ method: 'eth_chainId' })).toLowerCase();
  if (now !== want) {
    try {
      await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    } catch (e) {
      if (code(e) !== 4902) throw e;
      await provider.request({ method: 'wallet_addEthereumChain', params: [addChainParams(chain)] });
    }
    // Read it back: a wallet that did not switch must not sign on another network.
    if (String(await provider.request({ method: 'eth_chainId' })).toLowerCase() !== want) throw new PayFailed('network');
  }
  step('check');
  if (asset.kind === 'token') {
    // The token on this network must have the decimals the quote counts in, or the amount would be off by a scale.
    const decimals = uintOf(await provider.request({ method: 'eth_call', params: [{ to: asset.contract, data: ERC20_DECIMALS }, 'latest'] }));
    if (decimals === null || Number(decimals) !== p.coin.decimals) throw new PayFailed('coin');
    const have = uintOf(await provider.request({ method: 'eth_call', params: [{ to: asset.contract, data: erc20BalanceOf(from) }, 'latest'] }));
    if (have !== null && have < p.amount) throw new PayFailed('funds', have);
  } else {
    const have = uintOf(await provider.request({ method: 'eth_getBalance', params: [from, 'latest'] }));
    if (have !== null && have < p.amount) throw new PayFailed('funds', have);
  }
  // Once more right before signing: a wallet the person switched by hand meanwhile must not sign on another network.
  if (String(await provider.request({ method: 'eth_chainId' })).toLowerCase() !== want) throw new PayFailed('network');
  step('confirm');
  const hash = await provider.request({ method: 'eth_sendTransaction', params: [evmPayment({ chain, asset, from, depositAddress: p.depositAddress, amount: p.amount })] });
  // The wallet took the transaction: without a hash nobody can say it was not sent.
  if (!evmTxOk(hash)) throw new PayFailed('unclear');
  return hash;
}

/** A token account's rent on Solana (165 bytes), in lamports: what opening the deposit's account costs the payer. */
export const TOKEN_ACCOUNT_RENT = 2_039_280n;
/** A margin for the transaction's own fee, in lamports. */
const SOL_FEE = 20_000n;

async function paySolana(w: StandardWallet, p: Payment, step: (s: Step) => void): Promise<string> {
  step('connect');
  const connect = w.features['standard:connect'] as { connect(): Promise<{ accounts: readonly { address: string }[] }> };
  const { accounts } = await connect.connect();
  const account = accounts?.[0] ?? w.accounts[0];
  if (!account) throw new PayFailed('wallet');
  if (p.payer && account.address !== p.payer) throw new PayFailed('account');
  step('check');
  const q = new URLSearchParams({ asset: p.coin.assetId, owner: account.address });
  const res = await fetch(`/api/pay/near/solana?${q}`, { cache: 'no-store' });
  const chain = (await res.json().catch(() => null)) as {
    blockhash?: string;
    mint?: { address: string; program: string; decimals: number } | null;
    /** What the payer holds: lamports of SOL, and units of the token in its token account. */
    lamports?: string | null;
    balance?: string | null;
  } | null;
  if (!res.ok || !chain?.blockhash) throw new PayFailed('network');
  const lamports = chain.lamports && /^\d+$/.test(chain.lamports) ? BigInt(chain.lamports) : null;
  const balance = chain.balance && /^\d+$/.test(chain.balance) ? BigInt(chain.balance) : null;
  let asset: SolanaAsset;
  if (!p.coin.contract) {
    if (p.coin.symbol !== 'SOL' || p.coin.decimals !== 9) throw new PayFailed('coin');
    asset = { kind: 'sol' };
    if (lamports !== null && lamports < p.amount + SOL_FEE) throw new PayFailed('funds', lamports);
  } else {
    // The mint as the chain has it: the same address, and the decimals the quote counts in.
    if (!chain.mint || chain.mint.address !== p.coin.contract || chain.mint.decimals !== p.coin.decimals) throw new PayFailed('coin');
    asset = { kind: 'token', mint: chain.mint.address, decimals: chain.mint.decimals, tokenProgram: chain.mint.program };
    if (balance !== null && balance < p.amount) throw new PayFailed('funds', balance);
    // Opening the deposit address's token account costs its rent in SOL, paid by the payer.
    if (lamports !== null && lamports < TOKEN_ACCOUNT_RENT + SOL_FEE) throw new PayFailed('rent', lamports);
  }
  const transaction = solanaPayment({ asset, payer: account.address, depositAddress: p.depositAddress, amount: p.amount, blockhash: chain.blockhash });
  step('confirm');
  const send = w.features['solana:signAndSendTransaction'] as {
    signAndSendTransaction(...a: { account: unknown; chain: string; transaction: Uint8Array }[]): Promise<readonly { signature: Uint8Array }[]>;
  };
  const [out] = await send.signAndSendTransaction({ account, chain: 'solana:mainnet', transaction });
  const sig = out ? solanaSignature(out.signature) : null;
  if (!sig) throw new PayFailed('unclear');
  return sig;
}

/**
 * Pays the deposit address from `wallet`, reporting each step; the transaction's id once the wallet sent it. A refusal
 * in the wallet is `cancelled`; the rest name what to fix, and copying the address always remains.
 */
export async function payFrom(wallet: Wallet, p: Payment, step: (s: Step) => void): Promise<string> {
  try {
    if (wallet.family === 'evm') {
      const chain = evmChainOf(p.chainId);
      const w = evm.get(wallet.id);
      if (!chain || !w) throw new PayFailed('wallet');
      return await payEvm(w.provider, chain, p, step);
    }
    const w = solana.get(wallet.id);
    if (!w || p.chainId !== 'sol') throw new PayFailed('wallet');
    return await paySolana(w.standard, p, step);
  } catch (e) {
    if (e instanceof PayFailed) throw e;
    throw new PayFailed(declined(e) ? 'cancelled' : 'wallet');
  }
}

/**
 * Connects `wallet` and gives its address on its own network, without sending anything: who pays (a refund goes back
 * to it) or who receives. A refusal in the wallet is `cancelled`.
 */
export async function walletAddress(wallet: Wallet): Promise<string> {
  try {
    if (wallet.family === 'evm') {
      const w = evm.get(wallet.id);
      if (!w) throw new PayFailed('wallet');
      const accounts = (await w.provider.request({ method: 'eth_requestAccounts' })) as string[];
      if (typeof accounts?.[0] !== 'string') throw new PayFailed('wallet');
      return accounts[0];
    }
    const w = solana.get(wallet.id);
    if (!w) throw new PayFailed('wallet');
    const connect = w.standard.features['standard:connect'] as { connect(): Promise<{ accounts: readonly { address: string }[] }> };
    const { accounts } = await connect.connect();
    const a = accounts?.[0]?.address ?? w.standard.accounts[0]?.address;
    if (typeof a !== 'string') throw new PayFailed('wallet');
    return a;
  } catch (e) {
    if (e instanceof PayFailed) throw e;
    throw new PayFailed(declined(e) ? 'cancelled' : 'wallet');
  }
}

/** Where the person watches the transaction they just sent. */
export function txLink(chainId: string, id: string): string | null {
  const c = evmChainOf(chainId);
  if (c) return `${c.explorer}/tx/${id}`;
  if (chainId === 'sol') return `https://solscan.io/tx/${id}`;
  return null;
}

/** Tells 1Click the transaction, so it starts as soon as the network confirms it. Best effort. */
export function tellDeposit(address: string, txHash: string, memo?: string | null): void {
  void fetch('/api/pay/near/deposit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, txHash, ...(memo ? { memo } : {}) }),
  }).catch(() => {});
}
