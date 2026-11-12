import { checkNearQuote, nearCoinOf, nearDepositUnits, nearPreviewView, nearQuoteView, nearRequest, readNearAccount, type NearCoin } from '@maskwars/pay';
import { body, guard, limited, reply } from '@/lib/pay';
import {
  keepNearPreview,
  NEAR_FEE,
  NEAR_USD_MAX,
  nearAccountExists,
  nearCatalog,
  nearClient,
  nearLive,
  nearPreview,
  nearProblem,
  nearUpstream,
  PREVIEW_ACCOUNT,
} from '@/lib/getnear';

// A quote for Get NEAR. The page names the coin by asset id, the amount in dollars and, for a real deposit address, the
// NEAR account that receives; the request itself is built here, so nothing else reaches 1Click. A preview (dry) is open
// to all and shared for 10 s by everyone pricing the same coin and amount, priced for the team's own account so it
// names nobody. A real deposit address only once the owner turns GET_NEAR_LIVE on, and only for an account NEAR knows
// (a name) or can create by the transfer itself (an implicit address). Only `from`, `usd`, `recipient` and `dry` are read
// from the body: a refund address or fees a caller adds are never passed on. A real quote is read back here before its
// address leaves the server, and once more on the page.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const no = guard(req, 'near-quote-any', 120);
  if (no) return no;
  const b = await body(req);
  if (!b) return nearProblem('bad', 400);
  const { from, usd, dry } = b;
  if (typeof from !== 'string' || typeof dry !== 'boolean' || typeof usd !== 'number' || !(usd >= 1 && usd <= NEAR_USD_MAX)) {
    return nearProblem('bad', 400);
  }
  if (!dry && !nearLive) return nearProblem('closed', 403);
  let coin: NearCoin | null = null;
  try {
    const hit = nearCoinOf(await nearCatalog(), from);
    if (!hit) return nearProblem('bad', 400);
    coin = hit.coin;
    const amount = nearDepositUnits(usd, hit.coin);
    if (amount <= 0n) return nearProblem('small', 422);

    if (dry) {
      const key = `near|${hit.coin.assetId}|${amount}`;
      const shared = nearPreview(key);
      if (shared) return reply({ quote: shared });
      const busy = limited(req, 'near-quote-dry', 40);
      if (busy) return busy;
      const request = nearRequest({ recipient: PREVIEW_ACCOUNT, chain: hit.chain, from: hit.coin, amount, dry: true, fee: NEAR_FEE });
      const view = nearPreviewView(nearQuoteView(await nearClient.quote(request)));
      keepNearPreview(key, view);
      return reply({ quote: view });
    }

    const to = readNearAccount(typeof b.recipient === 'string' ? b.recipient : '');
    if (!to.ok) return nearProblem('account', 422, { why: to.why });
    const busy = limited(req, 'near-quote', 20);
    if (busy) return busy;
    // A name has to be on NEAR already: 1Click cannot pay out to one that is not. An implicit address is created by the
    // payout itself.
    if (to.kind === 'named') {
      let exists: boolean;
      try {
        exists = await nearAccountExists(to.id);
      } catch {
        return nearProblem('busy', 503);
      }
      if (!exists) return nearProblem('account', 422, { why: 'missing' });
    }
    const request = nearRequest({ recipient: to.id, chain: hit.chain, from: hit.coin, amount, dry: false, fee: NEAR_FEE });
    const view = nearQuoteView(await nearClient.quote(request));
    // The terms as 1Click echoes them: this coin in, NEAR out on NEAR to this account, the refund to it, a minimum within
    // 1% of the price, and no more of our own fee than packages/network sets.
    const ours = view.fees.filter((f) => f.recipient === NEAR_FEE?.recipient).reduce((n, f) => n + f.fee, 0);
    const read = checkNearQuote(view, { recipient: to.id, from: hit.coin.assetId });
    if (!view.depositAddress || !read.ok || view.amountIn !== amount.toString() || ours > (NEAR_FEE?.fee ?? 0)) return nearProblem('bad', 502);
    return reply({ quote: view });
  } catch (error) {
    return nearUpstream(error, coin);
  }
}
