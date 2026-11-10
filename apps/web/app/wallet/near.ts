import type { NearConnector, NearWalletBase } from '@hot-labs/near-connect';
import { MAINNET_RPCS, type WalletSignature } from '@maskwars/pay';

/** A person's NEAR wallet on mainnet, through NEAR Connect: it signs intents for its account and, once, adds its key. */
export interface NearSigner {
  readonly accountId: string;
  /** Signs a NEP-413 message: what NEAR Intents takes from a NEAR wallet. */
  signMessage(p: { message: string; recipient: string; nonce: Uint8Array }): Promise<WalletSignature>;
  /** Lets this wallet's key sign for its account in NEAR Intents: one transaction, 1 yoctoNEAR. */
  addKey(publicKey: string): Promise<string | null>;
  signOut(): Promise<void>;
}

let connector: NearConnector | null = null;

async function nearConnect(): Promise<NearConnector> {
  if (connector) return connector;
  const { NearConnector } = await import('@hot-labs/near-connect');
  // /wallet runs under a nonce CSP; NEAR Connect's sandboxed wallet frames inherit it and need the page's nonce.
  const nonce = (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce || undefined;
  connector = new NearConnector({
    ...(nonce ? { cspNonce: nonce } : {}),
    network: 'mainnet',
    providers: { mainnet: [...MAINNET_RPCS] },
    features: { signMessage: true, signAndSendTransaction: true },
    footerBranding: null,
  });
  return connector;
}

function signer(wallet: NearWalletBase, accountId: string): NearSigner {
  return {
    accountId,
    async signMessage(p) {
      const s = await wallet.signMessage({ ...p, network: 'mainnet', signerId: accountId });
      return { accountId: s.accountId, publicKey: s.publicKey, signature: s.signature };
    },
    async addKey(publicKey) {
      const outcome = await wallet.signAndSendTransaction({
        network: 'mainnet',
        signerId: accountId,
        receiverId: 'intents.near',
        actions: [{ type: 'FunctionCall', params: { methodName: 'add_public_key', args: { public_key: publicKey }, gas: '30000000000000', deposit: '1' } }],
      });
      return outcome?.transaction?.hash ?? null;
    },
    async signOut() {
      await wallet.signOut({ network: 'mainnet' }).catch(() => {});
    },
  };
}

const mainnet = (id: string | undefined): id is string => !!id && !id.endsWith('.testnet');

/** The wallet already connected for mainnet, if any; never asks the person anything. */
export async function nearConnected(): Promise<NearSigner | null> {
  try {
    const { wallet } = await (await nearConnect()).getConnectedWallet();
    const id = (await wallet.getAccounts({ network: 'mainnet' }))[0]?.accountId;
    return mainnet(id) ? signer(wallet, id) : null;
  } catch {
    return null;
  }
}

/** Opens NEAR Connect's wallet list and signs the person in on mainnet. */
export async function nearSignIn(): Promise<NearSigner> {
  const known = await nearConnected();
  if (known) return known;
  const wallet = await (await nearConnect()).connect();
  const id = (await wallet.getAccounts({ network: 'mainnet' }))[0]?.accountId;
  if (!mainnet(id)) throw new Error('no mainnet account');
  return signer(wallet, id);
}
