import { coinOf, depositUnits, previewView, quoteView } from '@maskwars/pay';
import { hireRequest, teamOk } from '@maskwars/hire';
import { HIRE_USD_MAX, hireFee, overBudget, pageOf } from '@/lib/hire';
import { body, catalog, guard, keepPreview, limited, oneClick, preview, problem, reply, upstream } from '@/lib/pay';

// A live price for a hire, while the payer picks the amount: what the dollars buy in NEAR, after the site's cut if
// there is one. Shared for 10 s by everyone pricing the same coin and amount, so it names no one. A fresh look at 1Click
// is paid from the budget of the page that framed the checkout, so no page can spend the partner key's limit for all.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const no = guard(req, 'hire-preview-any', 120);
  if (no) return no;
  const b = await body(req, 1_000);
  if (!b || typeof b.team !== 'string' || !teamOk(b.team) || typeof b.from !== 'string' || typeof b.usd !== 'number' || !(b.usd >= 1 && b.usd <= HIRE_USD_MAX)) {
    return problem('bad', 400);
  }
  try {
    const cat = await catalog();
    const from = coinOf(cat, b.from);
    if (!from || from.chain === 'near') return problem('bad', 400);
    const units = depositUnits(b.usd, from);
    if (units <= 0n) return problem('small', 422);
    const key = `hire|${hireFee?.bps ?? 0}|${from.assetId}|${units}`;
    const hit = preview(key);
    if (hit) return reply({ quote: hit });
    const spent = overBudget('preview', pageOf(req)) ?? limited(req, 'hire-preview', 40);
    if (spent) return spent;
    const { request } = hireRequest({ job: { team: b.team }, from, usd: b.usd, dry: true, fee: hireFee });
    const view = previewView(quoteView(await oneClick.quote(request)));
    keepPreview(key, view);
    return reply({ quote: view });
  } catch (error) {
    return upstream(error);
  }
}
