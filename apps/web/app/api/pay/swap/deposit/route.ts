import { readNearAccount } from '@maskwars/pay';
import { body, guard, reply } from '@/lib/pay';
import { nearClient } from '@/lib/getnear';
import { swapProblem } from '@/lib/swap';

// The page paid a deposit address from a wallet in the browser and tells 1Click the transaction, so the swap starts as
// soon as the network confirms it; a payment from a NEAR wallet names its sender, as 1Click asks. Optional for the
// money: 1Click finds the deposit on its own either way, so a failure here is a plain `told: false`.
export const dynamic = 'force-dynamic';

/** A transaction id as EVM networks (0x…), Solana (base58 signature), Tron (hex) and NEAR (base58 of 32 bytes) write it. */
const TX = /^(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{43,44}|[1-9A-HJ-NP-Za-km-z]{64,90})$/;

export async function POST(req: Request) {
  const no = guard(req, 'swap-deposit', 30);
  if (no) return no;
  const b = await body(req, 2_000);
  const address = typeof b?.address === 'string' ? b.address : '';
  const txHash = typeof b?.txHash === 'string' ? b.txHash : '';
  const memo = typeof b?.memo === 'string' ? b.memo : undefined;
  const sender = typeof b?.nearSender === 'string' ? readNearAccount(b.nearSender) : null;
  if (!/^[A-Za-z0-9._:-]{20,120}$/.test(address) || !TX.test(txHash) || (memo !== undefined && !/^[A-Za-z0-9]{1,64}$/.test(memo)) || (sender && !sender.ok)) {
    return swapProblem('bad', 400);
  }
  try {
    await nearClient.submitDeposit({ txHash, depositAddress: address, ...(memo ? { memo } : {}), ...(sender?.ok ? { nearSenderAccount: sender.id } : {}) });
    return reply({ told: true });
  } catch {
    return reply({ told: false });
  }
}
