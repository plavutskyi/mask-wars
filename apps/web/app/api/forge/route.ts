import { FORGE_NET, forgeOpen } from '@/lib/forge';

// GET /api/forge: whether the mask factory is open on chain. The header shows Forge only when it is.
export const dynamic = 'force-dynamic';

export async function GET() {
  const open = await forgeOpen();
  // An open forge stays open; a closed one is asked again within a minute.
  const cache = open ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=3600' : 'public, max-age=30, s-maxage=60, stale-while-revalidate=300';
  return Response.json({ open, factory: FORGE_NET.factory, network: FORGE_NET.id }, { headers: { 'cache-control': cache } });
}
