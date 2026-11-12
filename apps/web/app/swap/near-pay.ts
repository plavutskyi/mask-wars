import { NEAR_ASSET, nearDepositTransaction, nearPayExtra, type NearCoin, type Outcome } from '@maskwars/pay';
import { PayFailed, type Step } from '../near/pay';
import type { NearSigner } from '../wallet/near';
import { swapApi } from './flow';

/**
 * Pays a swap's deposit account from the person's NEAR wallet (NEAR Connect): one transaction to the coin's own
 * contract that registers the deposit account where the contract does not know it yet, wraps native NEAR, and sends
 * exactly the quoted amount with `ft_transfer`. All or nothing: actions to one contract run as one receipt. The wallet
 * shows it before it signs; the site holds no key. Returns the transaction's hash.
 */
export async function payFromNear(signer: NearSigner, p: { coin: NearCoin; depositAddress: string; amount: bigint }, step: (s: Step) => void): Promise<string> {
  step('check');
  let reads: Awaited<ReturnType<typeof swapApi.near>>;
  try {
    reads = await swapApi.near({ asset: p.coin.assetId, deposit: p.depositAddress, payer: signer.accountId });
  } catch {
    throw new PayFailed('network');
  }
  const depositStorage = BigInt(reads.depositStorage);
  const payerStorage = BigInt(reads.payerStorage);
  const near = BigInt(reads.near);
  const native = p.coin.assetId === NEAR_ASSET;
  const extra = nearPayExtra({ depositStorage, payerStorage, native });
  // Native NEAR: the amount and what the transaction costs come out of the same balance. A token: the token covers the
  // amount, NEAR covers the rest.
  if (native && near < p.amount + extra) throw new PayFailed('funds', near > extra ? near - extra : 0n);
  if (!native && BigInt(reads.balance) < p.amount) throw new PayFailed('funds', BigInt(reads.balance));
  if (!native && near < extra) throw new PayFailed('gas');
  const tx = nearDepositTransaction({ coin: p.coin, payer: signer.accountId, depositAddress: p.depositAddress, amount: p.amount, depositStorage, payerStorage });
  step('confirm');
  let outcomes: Outcome[];
  try {
    outcomes = await signer.send([tx]);
  } catch (e) {
    // Declined in the wallet: nothing went out. Anything else may have come after the transaction left (a node that
    // timed out): the person checks the wallet before paying again, and a payment that went out shows up by itself.
    const text = String((e as Error)?.message ?? e);
    throw new PayFailed(/reject|denied|cancel|closed/i.test(text) ? 'cancelled' : 'unclear');
  }
  const o = outcomes[0];
  const st = o?.status;
  // NEAR said it failed: the one receipt rolled back, nothing moved.
  if (st === 'Failure' || (st && typeof st === 'object' && 'Failure' in st)) throw new PayFailed('wallet');
  // A wallet that reports no transaction cannot be taken for one that sent nothing: paying again could pay twice.
  const hash = o?.transaction?.hash ?? o?.transaction_outcome?.id ?? null;
  if (!hash || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash)) throw new PayFailed('unclear');
  return hash;
}
