import { down, missing, ok, options } from '@/lib/api';
import { readArena } from '@/lib/arena';

// GET /api/races/<id>: one race with its whole course.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const race = (await readArena()).races.find((r) => r.id === id);
    return race ? ok(race) : missing(`race ${id}`);
  } catch (error) {
    return down(error);
  }
}

export const OPTIONS = options;
