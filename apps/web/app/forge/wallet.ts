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
