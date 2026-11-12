import { nearProgressOf } from '@maskwars/pay';
import { guard, reply } from '@/lib/pay';
import { nearClient, nearProblem, nearUpstream } from '@/lib/getnear';

// Where a Get NEAR swap is: 1Click's status for its deposit address, in the page's own words, with the NEAR transaction
// that paid the account out once it is done.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'near-status', 120);
  if (no) return no;
  const url = new URL(req.url);
  const address = url.searchParams.get('address') ?? '';
  const memo = url.searchParams.get('memo') ?? undefined;
  if (!/^[A-Za-z0-9._:-]{20,120}$/.test(address) || (memo !== undefined && !/^[A-Za-z0-9]{1,64}$/.test(memo))) return nearProblem('bad', 400);
  try {
    return reply(nearProgressOf(await nearClient.status(address, memo)));
  } catch (error) {
    return nearUpstream(error, null);
  }
}
