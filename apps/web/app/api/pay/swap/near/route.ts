import { readSwapAddress, swapCoinOf } from '@maskwars/pay';
import { guard, reply } from '@/lib/pay';
import { nearPayReads, swapCatalog, swapProblem } from '@/lib/swap';

// What paying a swap's deposit account from a NEAR wallet needs from NEAR: whether the coin's contract knows the deposit
// account (and, for native NEAR, the payer) and what registering costs, and what the wallet holds. Only for a coin on
// NEAR that a swap takes and a deposit account 1Click gives: this is not an open door to a NEAR node.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'swap-near', 40);
  if (no) return no;
  const q = new URL(req.url).searchParams;
  const deposit = q.get('deposit') ?? '';
  const payer = readSwapAddress('near', q.get('payer') ?? '');
  if (!/^[0-9a-f]{64}$/.test(deposit) || !payer.ok) return swapProblem('bad', 400);
  try {
    const hit = swapCoinOf(await swapCatalog(), q.get('asset') ?? '');
    if (!hit || hit.chain.id !== 'near' || !hit.coin.contract) return swapProblem('bad', 400);
    const r = await nearPayReads({ coin: hit.coin, deposit, payer: payer.id });
    return reply({ depositStorage: r.depositStorage.toString(), payerStorage: r.payerStorage.toString(), balance: r.balance.toString(), near: r.near.toString() });
  } catch {
    return swapProblem('busy', 503);
  }
}
