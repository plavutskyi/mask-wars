import { guard } from '@/lib/pay';
import { SWAP_FEE, SWAP_USD_MAX, swapCatalog, swapLive, swapUpstream } from '@/lib/swap';

// Swap: every network and coin a swap can start from or end in, with prices, MASK WARS's fee and the limit. The same for
// everyone, cached for a minute.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'swap-catalog', 60);
  if (no) return no;
  try {
    const c = await swapCatalog();
    return Response.json(
      { live: swapLive, maxUsd: SWAP_USD_MAX, fee: SWAP_FEE, near: c.near, chains: c.chains },
      { headers: { 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' } },
    );
  } catch (error) {
    return swapUpstream(error, null);
  }
}
