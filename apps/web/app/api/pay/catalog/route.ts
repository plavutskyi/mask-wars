import { chainOf } from '@maskwars/pay';
import { catalog, guard, live, PAY_USD_MAX, upstream } from '@/lib/pay';

// The coins a vault takes and pays out, with their prices: the same for everyone, cached for a minute.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'catalog', 60);
  if (no) return no;
  try {
    const c = await catalog();
    return Response.json(
      {
        live,
        maxUsd: PAY_USD_MAX,
        near: c.near,
        chains: c.chains.map((ch) => ({ ...ch, window: chainOf(ch.id)?.window ?? 30 })),
      },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' } },
    );
  } catch (error) {
    return upstream(error);
  }
}
