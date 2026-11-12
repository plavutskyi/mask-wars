import { guard } from '@/lib/pay';
import { NEAR_FEE, NEAR_USD_MAX, nearCatalog, nearLive, nearUpstream } from '@/lib/getnear';

// Get NEAR: every network and coin that can become NEAR, with prices, MASK WARS's fee and the season's limit. The same
// for everyone, cached for a minute.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'near-catalog', 60);
  if (no) return no;
  try {
    const c = await nearCatalog();
    return Response.json(
      { live: nearLive, maxUsd: NEAR_USD_MAX, fee: NEAR_FEE, near: c.near, chains: c.chains },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' } },
    );
  } catch (error) {
    return nearUpstream(error, null);
  }
}
