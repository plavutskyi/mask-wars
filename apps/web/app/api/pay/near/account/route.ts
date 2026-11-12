import { readNearAccount } from '@maskwars/pay';
import { guard, reply } from '@/lib/pay';
import { nearAccountExists, nearProblem } from '@/lib/getnear';

// Who receives on /near: a name that must already be on NEAR mainnet, or a 64-character implicit address the payout
// itself creates. Read at the final block, cached a minute for an account that is there.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'near-account', 90);
  if (no) return no;
  const to = readNearAccount(new URL(req.url).searchParams.get('id') ?? '');
  if (!to.ok) return reply({ ok: false, why: to.why });
  try {
    return reply({ ok: true, id: to.id, kind: to.kind, exists: await nearAccountExists(to.id) });
  } catch {
    // An implicit address is fine either way; a name waits for a node that answers.
    return to.kind === 'implicit' ? reply({ ok: true, id: to.id, kind: to.kind, exists: null }) : nearProblem('busy', 503);
  }
}
