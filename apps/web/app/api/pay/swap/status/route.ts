import { swapCoinOf, swapProgressOf, type StatusResponse } from '@maskwars/pay';
import { guard, reply } from '@/lib/pay';
import { nearClient } from '@/lib/getnear';
import { swapCatalog, swapProblem, swapUpstream } from '@/lib/swap';

// Where a swap is: 1Click's status for its deposit address, in the page's own words, with the transaction that paid the
// receiver once it is done, linked on the explorer of the network it landed on.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'swap-status', 120);
  if (no) return no;
  const url = new URL(req.url);
  const address = url.searchParams.get('address') ?? '';
  const memo = url.searchParams.get('memo') ?? undefined;
  if (!/^[A-Za-z0-9._:-]{20,120}$/.test(address) || (memo !== undefined && !/^[A-Za-z0-9]{1,64}$/.test(memo))) return swapProblem('bad', 400);
  try {
    const r: StatusResponse = await nearClient.status(address, memo);
    const out = r.quoteResponse?.quoteRequest?.destinationAsset;
    const chain = out ? (swapCoinOf(await swapCatalog(), out)?.chain.id ?? '') : '';
    return reply(swapProgressOf(r, chain));
  } catch (error) {
    return swapUpstream(error, null);
  }
}
