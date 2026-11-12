import { body, guard, reply } from '@/lib/pay';
import { nearClient, nearProblem } from '@/lib/getnear';

// The page paid a deposit address from a wallet in the browser and tells 1Click the transaction, so the swap starts as
// soon as the network confirms it. Optional for the money: 1Click finds the deposit on its own either way, so a failure
// here is answered as a plain `told: false`, never as an error the page would show.
export const dynamic = 'force-dynamic';

/** A transaction id as EVM networks (0x…), Solana (base58 signature) and Tron (hex) write it. */
const TX = /^(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})$/;

export async function POST(req: Request) {
  const no = guard(req, 'near-deposit', 30);
  if (no) return no;
  const b = await body(req, 2_000);
  const address = typeof b?.address === 'string' ? b.address : '';
  const txHash = typeof b?.txHash === 'string' ? b.txHash : '';
  const memo = typeof b?.memo === 'string' ? b.memo : undefined;
  if (!/^[A-Za-z0-9._:-]{20,120}$/.test(address) || !TX.test(txHash) || (memo !== undefined && !/^[A-Za-z0-9]{1,64}$/.test(memo))) {
    return nearProblem('bad', 400);
  }
  try {
    await nearClient.submitDeposit({ txHash, depositAddress: address, ...(memo ? { memo } : {}) });
    return reply({ told: true });
  } catch {
    return reply({ told: false });
  }
}
