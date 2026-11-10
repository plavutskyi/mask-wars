import { down, ok, options } from '@/lib/api';
import { readArena } from '@/lib/arena';

// GET /api/races: every race on the arena, newest first; `now`, the race the home page shows; and the league.
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return ok(await readArena());
  } catch (error) {
    return down(error);
  }
}

export const OPTIONS = options;
