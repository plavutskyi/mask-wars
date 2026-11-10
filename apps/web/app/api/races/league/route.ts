import { down, ok, options } from '@/lib/api';
import { readArena } from '@/lib/arena';

// GET /api/races/league: every mask by what it took, then breaks, then its fastest break.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const { network, league, readAt } = await readArena();
    return ok({ network, league, readAt });
  } catch (error) {
    return down(error);
  }
}

export const OPTIONS = options;
