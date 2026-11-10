import { chainOf } from '@maskwars/pay';
import { HIRE_USD_MAX, hireFee, hireLive } from '@/lib/hire';
import { catalog, guard, upstream } from '@/lib/pay';

// The coins a job can be paid with, their prices, whether hiring is open (HIRE_LIVE) and the site's cut: the same for
// every checkout, cached for a minute here and at the edge. The checkout asks for it only once its payer touches it.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'hire-catalog', 60);
  if (no) return no;
  try {
    const c = await catalog();
    return Response.json(
      {
        live: hireLive,
        fee: hireFee?.bps ?? 0,
        max: HIRE_USD_MAX,
        near: c.near,
        chains: c.chains.map((ch) => ({ ...ch, window: chainOf(ch.id)?.window ?? 30 })),
      },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' } },
    );
  } catch (error) {
    return upstream(error);
  }
}
