import { accountOk, cleanAccount, jobText, relayOk, teamOk } from '@maskwars/hire';
import { keepRelay, overBudget, pageOf, proven, refuse, takeRelay } from '@/lib/hire';
import { body, guard, problem, reply } from '@/lib/pay';

// The vault window's proof that the payer holds the vault, read here before the window hands it to the checkout:
// signed for this job and page, by the vault's own key. The checkout sends the same proof again with the quote, and the
// quote route reads it again. The proof is also left here under the checkout's random relay id, for a page whose policy
// cuts the window off from its checkout; the checkout takes it once (GET), and the sweep clears any left after an hour.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const no = guard(req, 'hire-proof-any', 30);
  if (no) return no;
  const b = await body(req, 6_000);
  const job = b?.job && typeof b.job === 'object' ? (b.job as Record<string, unknown>) : null;
  const text = typeof job?.text === 'string' ? jobText(job.text) : null;
  const target = typeof job?.target === 'string' ? cleanAccount(job.target) : '';
  const team = typeof job?.team === 'string' && job.team ? cleanAccount(job.team) : null;
  if (!b || !text || !accountOk(target) || (team !== null && !teamOk(team)) || (b.relay !== undefined && !relayOk(b.relay))) return problem('bad', 400);
  const page = pageOf(req);
  const spent = overBudget('proof', page);
  if (spent) return spent;
  const r = await proven(b.proof, { text, target, team, page, req });
  if ('error' in r) return refuse(r.error, r.error === 'busy' ? 503 : 422);
  if (typeof b.relay === 'string') await keepRelay(b.relay, { proof: b.proof as never, vault: r.vault });
  return reply({ vault: r.vault });
}

export async function GET(req: Request) {
  const no = guard(req, 'hire-relay', 60);
  if (no) return no;
  const relay = new URL(req.url).searchParams.get('relay');
  if (!relayOk(relay)) return problem('bad', 400);
  return reply((await takeRelay(relay)) ?? { proof: null });
}
