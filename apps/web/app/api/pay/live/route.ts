import { forgeLive, limited, live, PAY_USD_MAX, reply } from '@/lib/pay';

// What the owner's switches open right now, in one line: safe to open straight from the address bar
// (maskwars.xyz/api/pay/live), so a release can be checked without a vault. It reads only this deployment's own
// settings: no 1Click, no chain, no key, so unlike the other /api/pay routes it does not ask for the site's page.
// A cash-out is not listed: it is always open.
export const dynamic = 'force-dynamic';

export function GET(req: Request) {
  const busy = limited(req, 'live', 30);
  if (busy) return busy;
  return reply({ deposits: live, fuel: forgeLive, maxUsd: PAY_USD_MAX });
}
