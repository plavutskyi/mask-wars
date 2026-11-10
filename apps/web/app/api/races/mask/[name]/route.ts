import { down, missing, ok, options } from '@/lib/api';
import { readArena } from '@/lib/arena';

// GET /api/races/mask/<name>: one mask, by its name (nova) or its account, with every race it ran.
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ name: string }> }) {
  const key = (await params).name.toLowerCase();
  try {
    const mask = (await readArena()).league.find((m) => m.who.slug === key || m.who.account === key);
    return mask ? ok(mask) : missing(`mask ${key}`);
  } catch (error) {
    return down(error);
  }
}

export const OPTIONS = options;
