import {
  checkSwapQuote,
  depositAddressOk,
  NEAR_ASSET,
  readRefund,
  readSwapAddress,
  swapCoinOf,
  swapPreviewView,
  swapQuoteView,
  swapRequest,
  usdOf,
  type NearCoin,
  type Refund,
} from '@maskwars/pay';
import { body, guard, limited, reply } from '@/lib/pay';
import { nearClient } from '@/lib/getnear';
import {
  keepSwapPreview,
  nearAccountExists,
  PREVIEW_REFUND,
  previewRecipient,
  SWAP_FEE,
  SWAP_USD_MAX,
  swapCatalog,
  swapLive,
  swapPreview,
  swapProblem,
  swapUpstream,
} from '@/lib/swap';

// A quote for a swap. The page names the two coins by asset id and the amount in units of the coin paid in; for a real
// deposit address also who receives and where a refund goes. The request itself is built here, so nothing else reaches
// 1Click: only `from`, `to`, `amount`, `dry`, `recipient`, `payer` and `refund` are read from the body.
//
// Where a refund goes, decided here and read back from the quote:
//   `payer`  the wallet that pays, on the network it pays from: the page connected it and pays from it
//   `refund` an address the person gave on the network they pay from (a NEAR account in NEAR Intents where this code
//            cannot read that network's addresses)
//   neither  only for a payout to NEAR: the receiving account inside NEAR Intents, which the page asks the person to own
// A coin on NEAR is paid only from a NEAR wallet (`payer`): an exchange would send native NEAR, which a deposit account
// does not take as wNEAR.
//
// A preview (dry) is open to all and shared for 10 s by everyone pricing the same coins and amount, priced for
// addresses nobody owns. A real deposit address only once the owner turns SWAP_LIVE on, and only after the quote reads
// back exactly as asked.
export const dynamic = 'force-dynamic';

const UNITS = /^[1-9]\d{0,39}$/;

/** The most 1Click itself takes inside the price, in basis points: 0.25% without a partner key (docs: Fees). */
const ONE_CLICK_MAX_BPS = 25;

export async function POST(req: Request) {
  const no = guard(req, 'swap-quote-any', 120);
  if (no) return no;
  const b = await body(req);
  if (!b) return swapProblem('bad', 400);
  const { from, to, amount, dry } = b;
  if (typeof from !== 'string' || typeof to !== 'string' || typeof dry !== 'boolean' || typeof amount !== 'string' || !UNITS.test(amount)) {
    return swapProblem('bad', 400);
  }
  if (!dry && !swapLive) return swapProblem('closed', 403);
  let coin: NearCoin | null = null;
  try {
    const catalog = await swapCatalog();
    const a = swapCoinOf(catalog, from);
    const z = swapCoinOf(catalog, to);
    if (!a || !z || !z.chain.to || a.coin.assetId === z.coin.assetId) return swapProblem('bad', 400);
    coin = a.coin;
    const units = BigInt(amount);
    const usd = usdOf(units, a.coin.decimals, a.coin.price);
    if (usd < 1) return swapProblem('small', 422, { min: 1 });
    // The page prices from the same list: a hair over the limit is the price moving between the two, not a bigger swap.
    if (usd > SWAP_USD_MAX * 1.01) return swapProblem('limit', 422, { max: SWAP_USD_MAX });

    if (dry) {
      const key = `swap|${a.coin.assetId}|${z.coin.assetId}|${amount}`;
      const shared = swapPreview(key);
      if (shared) return reply({ quote: shared });
      const busy = limited(req, 'swap-quote-dry', 40);
      if (busy) return busy;
      const recipient = previewRecipient(z.chain.id)!;
      const request = swapRequest({ from: a, to: z, amount: units, recipient, refund: PREVIEW_REFUND, dry: true, fee: SWAP_FEE });
      const view = swapPreviewView(swapQuoteView(await nearClient.quote(request)));
      keepSwapPreview(key, view);
      return reply({ quote: view });
    }

    // Who receives, read with certainty on the network that receives.
    const who = readSwapAddress(z.chain.id, typeof b.recipient === 'string' ? b.recipient : '');
    if (!who.ok) return swapProblem('account', 422, { why: who.why, ...(who.other ? { other: who.other } : {}) });

    // Where a refund goes.
    let refund: Refund;
    if (typeof b.payer === 'string') {
      const payer = readSwapAddress(a.chain.id, b.payer);
      if (!payer.ok) return swapProblem('refund', 422, { why: payer.why });
      refund = { to: payer.id, type: 'ORIGIN_CHAIN' };
    } else if (a.chain.id === 'near') {
      return swapProblem('bad', 400);
    } else if (typeof b.refund === 'string' && b.refund.trim()) {
      const r = readRefund(a.chain.id, b.refund);
      if (!r.ok) return swapProblem('refund', 422, { why: r.why, ...(r.other ? { other: r.other } : {}) });
      refund = r.refund;
    } else if (z.chain.id === 'near') {
      refund = { to: who.id, type: 'INTENTS' };
    } else {
      return swapProblem('refund', 422, { why: 'empty' });
    }

    const busy = limited(req, 'swap-quote', 20);
    if (busy) return busy;
    // A NEAR name must be on NEAR to receive anything, a refund included. A token needs an account that is there, even
    // an implicit one; native NEAR opens a new implicit account by the payout itself.
    // A refund address typed for NEAR Intents must be there even when it is 64 hex digits: that is also a Sui or Aptos
    // address without its 0x, which would pass as an implicit account nobody holds.
    const nearIds = new Set<string>();
    if (z.chain.id === 'near' && (!who.implicit || z.coin.assetId !== NEAR_ASSET)) nearIds.add(who.id);
    const typed = typeof b.payer !== 'string' && typeof b.refund === 'string';
    if ((typed && refund.type === 'INTENTS') || ((refund.type === 'INTENTS' || a.chain.id === 'near') && !/^[0-9a-f]{64}$/.test(refund.to))) nearIds.add(refund.to);
    for (const id of nearIds) {
      let exists: boolean;
      try {
        exists = await nearAccountExists(id);
      } catch {
        return swapProblem('busy', 503);
      }
      if (!exists) return swapProblem(id === who.id && z.chain.id === 'near' ? 'account' : 'refund', 422, { why: 'missing' });
    }

    const request = swapRequest({ from: a, to: z, amount: units, recipient: who.id, refund, dry: false, fee: SWAP_FEE });
    const view = swapQuoteView(await nearClient.quote(request));
    // The terms as 1Click echoes them: these coins, this receiver, the refund where it was asked, exactly this amount, a
    // minimum within 1% of the price, no more of our own fee than packages/network sets, and a deposit address a wallet
    // on the paying network can pay (with its memo where the network needs one).
    // 1Click echoes our fee split with its own share (25 asked: 13 to us, 13 or 20 to it), so the echo is never exactly
    // what was asked; it is held to ours at most, and everything inside the price to ours plus 1Click's most (25 bps).
    const ours = view.fees.filter((f) => f.recipient === SWAP_FEE?.recipient).reduce((n, f) => n + f.fee, 0);
    const total = view.fees.reduce((n, f) => n + f.fee, 0);
    const read = checkSwapQuote(view, { from: a.coin.assetId, to: z.coin.assetId, recipient: who.id, refund, amountIn: amount });
    const address = view.depositAddress;
    if (!address || !depositAddressOk(a.chain.id, address) || (a.chain.memo && !view.depositMemo) || !read.ok || ours > (SWAP_FEE?.fee ?? 0) || total > (SWAP_FEE?.fee ?? 0) + ONE_CLICK_MAX_BPS) {
      return swapProblem('bad', 502);
    }
    return reply({ quote: view });
  } catch (error) {
    return swapUpstream(error, coin);
  }
}
