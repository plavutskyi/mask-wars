import { after } from 'next/server';
import { coinOf, quoteView } from '@maskwars/pay';
import { checkHire, feeHeld, hireRequest, jobHash, jobOf, networkOf, newJobId, type VaultProof } from '@maskwars/hire';
import { HIRE_USD_MAX, hireFee, hireLive, keepTicket, overBudget, pageOf, proven, refuse, sweep, type Ticket } from '@/lib/hire';
import { body, catalog, guard, limited, oneClick, problem, reply, upstream } from '@/lib/pay';

// The deposit address for a job. The checkout names the job, the coin, the dollars, and brings the payer's proof that
// they hold the job's vault; without that proof no address goes out, so a page can never route a payer's money to a
// vault the payer does not hold. The request to 1Click is built here from those fields alone (`hireRequest`: the
// team's vault receives and takes refunds), with the partner key that never leaves this server. The quote is read back
// as the checkout reads it again, and the job's ticket is kept before the address goes out. Only once the owner turns
// HIRE_LIVE on.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const no = guard(req, 'hire-quote-any', 60);
  if (no) return no;
  const b = await body(req, 8_000);
  if (!b || !b.job || typeof b.job !== 'object') return problem('bad', 400);
  const job = jobOf(b.job as Record<string, unknown>);
  const usd = b.usd;
  if (!job || typeof b.from !== 'string' || typeof usd !== 'number' || !(usd >= 1 && usd <= HIRE_USD_MAX)) return problem('bad', 400);
  if (!hireLive) return problem('closed', 403);
  const page = pageOf(req);
  try {
    const cat = await catalog();
    const from = coinOf(cat, b.from);
    if (!from || from.chain === 'near') return problem('bad', 400);
    const spent = overBudget('address', page) ?? limited(req, 'hire-quote', 20);
    if (spent) return spent;
    const who = await proven(b.proof, { text: job.text, target: job.target, team: job.team, page, req });
    if ('error' in who) return refuse(who.error, who.error === 'busy' ? 503 : 403);
    const { request } = hireRequest({ job, from, usd, dry: false, fee: hireFee });
    const raw = await oneClick.quote(request);
    const quote = quoteView(raw);
    // The same read-back the checkout makes, and the site's cut exactly as set: a quote that would not pass gets no ticket.
    if (!feeHeld(raw, hireFee) || !checkHire(quote, { job, from, near: cat.near, usd }).ok) return problem('route', 422);
    const ticket: Ticket = {
      job: { id: newJobId(), hash: jobHash(job), ...job },
      network: networkOf(job.target),
      usd,
      page,
      proof: (b.proof as VaultProof).kind,
      from: { chain: from.chain, symbol: from.symbol, assetId: from.assetId },
      quote: {
        correlationId: quote.correlationId,
        depositAddress: quote.depositAddress,
        depositMemo: quote.depositMemo,
        amountIn: quote.amountIn,
        amountOut: quote.amountOut,
        minAmountOut: quote.minAmountOut,
        deadline: quote.deadline,
        closes: quote.closes,
      },
      at: new Date().toISOString(),
    };
    const kept = await keepTicket(ticket);
    if (kept !== 'kept') return problem('busy', kept === 'full' ? 429 : 503);
    later(() => sweep());
    return reply({ quote, job: ticket.job });
  } catch (error) {
    return upstream(error);
  }
}

/** After the response: tidying the store never holds up a payer. Outside a request (tests) it is left to the caller. */
function later(fn: () => Promise<unknown>): void {
  try {
    after(fn);
  } catch {
    /* no request to run after */
  }
}
