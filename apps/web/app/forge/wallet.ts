import type { NearConnector, NearWalletBase } from '@hot-labs/near-connect';
import { NETWORK_ID } from '@maskwars/network';

/** One function call a person's wallet signs: the forge on the factory, or the owner's withdraw on their mask. */
export interface WalletCall {
  readonly type: 'FunctionCall';
  readonly params: { readonly methodName: string; readonly args: object; readonly gas: string; readonly deposit: string };
}
export type ForgeCall = WalletCall;

/** Whoever signs: a person's NEAR wallet. */
export interface Signer {
  readonly accountId: string;
  /** Signs and sends one call; the transaction's hash once the network has it. */
  call(receiverId: string, action: WalletCall): Promise<string | null>;
  /** Signs `message` for `recipient` with `nonce` (NEP-413) and gives the signature's bytes: the seed of the person's
   * view key (packages/forge/src/history.ts). `null` when the wallet cannot sign a message. */
  signMessage?(message: string, recipient: string, nonce: Uint8Array): Promise<Uint8Array | null>;
}

/** A wallet's signature as bytes: base64 in NEP-413, base58 or `ed25519:` and base58 from some wallets. */
export function signatureBytes(text: string): Uint8Array | null {
  const bare = text.startsWith('ed25519:') ? text.slice(8) : text;
  if (!text.startsWith('ed25519:')) {
    try {
      const b = Uint8Array.from(atob(bare.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      if (b.length === 64) return b;
    } catch {
      // not base64
    }
  }
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const c of bare) {
    const i = A.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  while (out.length < 64) out.unshift(0);
  return out.length === 64 ? Uint8Array.from(out) : null;
}

declare global {
  interface Window {
    /** A test build's own signer, for the forge walked end to end against a local sandbox. Never in production. */
    __forgeSigner?: Signer;
  }
}

let connector: NearConnector | null = null;

async function nearConnect(rpcs: readonly string[]): Promise<NearConnector> {
  if (connector) return connector;
  const { NearConnector } = await import('@hot-labs/near-connect');
  connector = new NearConnector({
    network: NETWORK_ID,
    providers: { [NETWORK_ID]: [...rpcs] },
    features: { signAndSendTransaction: true },
    footerBranding: null,
  });
  return connector;
}

function signer(wallet: NearWalletBase, accountId: string): Signer {
  return {
    accountId,
    async call(receiverId, action) {
      const outcome = await wallet.signAndSendTransaction({ network: NETWORK_ID, signerId: accountId, receiverId, actions: [action] });
      return outcome?.transaction?.hash ?? null;
    },
    async signMessage(message, recipient, nonce) {
      const signed = await wallet.signMessage({ message, recipient, nonce, network: NETWORK_ID, signerId: accountId });
      return signed?.signature ? signatureBytes(signed.signature) : null;
    },
  };
}

/** The wallet already connected on this site, if any; never asks the person anything. */
export async function connected(rpcs: readonly string[]): Promise<Signer | null> {
  if (process.env.NEXT_PUBLIC_FORGE_TEST === '1' && window.__forgeSigner) return window.__forgeSigner;
  try {
    const { wallet, accounts } = await (await nearConnect(rpcs)).getConnectedWallet();
    const id = accounts[0]?.accountId;
    return id ? signer(wallet, id) : null;
  } catch {
    return null;
  }
}

/** Opens NEAR Connect's wallet list and signs the person in. */
export async function connect(rpcs: readonly string[]): Promise<Signer> {
  const known = await connected(rpcs);
  if (known) return known;
  const wallet = await (await nearConnect(rpcs)).connect();
  const accounts = await wallet.getAccounts({ network: NETWORK_ID });
  const id = accounts[0]?.accountId;
  if (!id) throw new Error('no account');
  return signer(wallet, id);
}

/** Signs the person out of the wallet connected on this site, so the next `connect` asks which wallet and account. */
export async function disconnect(rpcs: readonly string[]): Promise<void> {
  try {
    await (await nearConnect(rpcs)).disconnect();
  } catch {
    // None was connected.
  }
}
