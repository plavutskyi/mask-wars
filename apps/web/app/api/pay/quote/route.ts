import {
  addressOk,
  cashOutRequest,
  coinOf,
  depositUnits,
  previewView,
  quoteView,
  topUpRequest,
  vaultAccountOk,
  type ChainId,
  type QuoteRequest,
} from '@maskwars/pay';
import { body, catalog, guard, keepPreview, limited, live, oneClick, PAY_USD_MAX, preview, problem, reply, upstream } from '@/lib/pay';

// A quote for money in or out of a vault. The page names coins by asset id and the amount in dollars (in) or in the
// vault coin's units (out); the request itself is built here, so nothing but these fields reaches 1Click. The answer
// carries 1Click's terms (receiver, coins, refunds, the promised minimum) for the page to read back. A preview (dry) is
// always open and shared for 10 s by everyone pricing the same coins and amount, so people behind one address do not
// use up each other's limit; a real deposit address or cash-out only once the owner turns PAY_LIVE on.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const no = guard(req, 'quote-any', 120);
  if (no) return no;
  const b = await body(req);
  if (!b) return problem('bad', 400);
  const { kind, account, from, dry } = b;
  if ((kind !== 'in' && kind !== 'out') || typeof account !== 'string' || !vaultAccountOk(account) || typeof from !== 'string' || typeof dry !== 'boolean') {
    return problem('bad', 400);
  }
  if (!dry && !live) return problem('closed', 403);
  try {
    const cat = await catalog();
    const coin = coinOf(cat, from);
    if (!coin) return problem('bad', 400);
    let request: QuoteRequest;
    let key: string;
    if (kind === 'in') {
      if (coin.chain === 'near' || typeof b.usd !== 'number' || !(b.usd >= 1 && b.usd <= PAY_USD_MAX)) return problem('bad', 400);
      const amount = depositUnits(b.usd, coin);
      if (amount <= 0n) return problem('small', 422);
      request = topUpRequest({ account, from: coin, amount, dry });
      key = `in|${coin.assetId}|${amount}`;
    } else {
      const to = typeof b.to === 'string' ? coinOf(cat, b.to) : null;
      const recipient = typeof b.recipient === 'string' ? b.recipient.trim() : '';
      const amount = typeof b.units === 'string' && /^\d{1,40}$/.test(b.units) ? BigInt(b.units) : null;
      if (!to || to.chain === 'near' || !addressOk(to.chain as ChainId, recipient) || !amount || amount <= 0n) return problem('bad', 400);
      request = cashOutRequest({ account, from: coin, to, recipient, amount, dry });
      key = `out|${coin.assetId}|${to.assetId}|${amount}`;
    }
    if (dry) {
      const hit = preview(key);
      if (hit) return reply({ quote: hit });
      const busy = limited(req, 'quote-dry', 40);
      if (busy) return busy;
      const view = previewView(quoteView(await oneClick.quote(request)));
      keepPreview(key, view);
      return reply({ quote: view });
    }
    const busy = limited(req, 'quote', 20);
    if (busy) return busy;
    return reply({ quote: quoteView(await oneClick.quote(request)) });
  } catch (error) {
    return upstream(error);
  }
}
