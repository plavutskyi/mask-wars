import { progressOf } from '@maskwars/pay';
import { guard, oneClick, problem, reply, upstream } from '@/lib/pay';

// Where a top-up or cash-out is: 1Click's status for its deposit address, in the page's own words.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'status', 120);
  if (no) return no;
  const url = new URL(req.url);
  const address = url.searchParams.get('address') ?? '';
  const memo = url.searchParams.get('memo') ?? undefined;
  if (!/^[A-Za-z0-9._-]{20,100}$/.test(address) || (memo !== undefined && !/^[A-Za-z0-9]{1,64}$/.test(memo))) return problem('bad', 400);
  try {
    return reply(progressOf(await oneClick.status(address, memo)));
  } catch (error) {
    return upstream(error);
  }
}
