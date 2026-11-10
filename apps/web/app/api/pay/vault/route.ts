import { vaultAccountOk, vaultCoins, vaultOf } from '@maskwars/pay';
import { catalog, guard, ledger, problem, reply } from '@/lib/pay';

// A vault's money, read from NEAR Intents on every call: what it holds, in coins and in dollars.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'vault', 60);
  if (no) return no;
  const account = new URL(req.url).searchParams.get('account') ?? '';
  if (!vaultAccountOk(account)) return problem('bad', 400);
  try {
    const cat = await catalog();
    const coins = vaultCoins(cat);
    const v = vaultOf(account, cat, await ledger.balances(account, coins.map((c) => c.assetId)));
    return reply({
      account,
      usd: v.usd,
      near: v.near,
      nearPrice: cat.near.price,
      holdings: v.holdings.map((h) => ({ ...h.coin, units: h.units, usd: h.usd })),
    });
  } catch {
    return problem('busy', 503);
  }
}
