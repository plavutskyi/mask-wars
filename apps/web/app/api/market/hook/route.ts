import { after } from 'next/server';
import { MarketClient, createWebhookHandler, liveCheck } from '@maskwars/market';
import { callerOf, createLimiter } from '@/lib/limit';
import { budgeted, marketNeeds, marketSecrets } from '@/lib/market';
import { SITE } from '@/lib/site';

// MASK CHECK for hire on Agent Market: the webhook the marketplace calls when someone hires the agent.
//
// A caller never reaches this route. It calls https://<handle>.market.near.ai/a2a/v1, gets 402 with the price, pays
// with x402 (USDC on NEAR), and the marketplace checks and holds that payment. What arrives here is the marketplace's
// signed event. The hire is then read back from the marketplace with the agent's own token, checked on chain exactly
// as GET /api/check does, and delivered; the payment settles on delivery. A hire that cannot be answered is declined,
// and the caller is not charged.
//
// The agent answers for the network this site is built for, and no other: on maskwars.xyz that is mainnet, and a
// testnet name in a call is refused with a reason.
//
// Until the owner sets the agent's token and the webhook secret, the route says it is not open.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const HEADERS = { 'cache-control': 'no-store' };
const SERVICE = 'MASK CHECK on Agent Market';

// As /api/check: a caller gets 30 tries a minute and an instance 600 checks. Here a try is a request that does not
// carry the marketplace's signature, so nobody can keep the route busy from one address; a check is one account read
// from the chain for a paid hire.
const unsigned = createLimiter({ perWindow: 30, windowMs: 60_000 });
const checks = createLimiter({ perWindow: 600, windowMs: 60_000 });
const check = budgeted(liveCheck({ env: process.env }), checks);

let hook: ((request: Request) => Promise<Response>) | null | undefined;

/** The handler, built on the first request so a build without the secrets still builds; `null` while they are missing. */
function opened(): ((request: Request) => Promise<Response>) | null {
  if (hook !== undefined) return hook;
  const secrets = marketSecrets();
  hook = secrets
    ? createWebhookHandler({
        secret: secrets.secret,
        client: new MarketClient({ token: secrets.token, origin: secrets.origin }),
        check,
        networks: [SITE.network],
        waitUntil: (task) => after(task),
        log: (line) => console.log(`market: ${line}`),
      })
    : null;
  return hook;
}

function notOpen(): Response {
  return Response.json(
    {
      service: SERVICE,
      open: false,
      message: 'Not open yet: the paid listing is being set up. The same check is free now at GET /api/check?account=<id>.',
      needs: marketNeeds().map((need) => need.split(':')[0]),
    },
    { status: 503, headers: HEADERS },
  );
}

export function GET() {
  if (!opened()) return notOpen();
  return Response.json({ service: SERVICE, open: true, message: 'This hook takes signed events from Agent Market. To hire the agent, call it on its own host there.' }, { headers: HEADERS });
}

export async function POST(req: Request) {
  const handle = opened();
  if (!handle) return notOpen();
  const caller = callerOf(req);
  const wait = unsigned.wait(caller);
  if (wait !== null) return Response.json({ error: 'too many unsigned requests, try again shortly' }, { status: 429, headers: { ...HEADERS, 'retry-after': String(wait) } });
  const res = await handle(req);
  if (res.status === 401 || res.status === 413) unsigned.take(caller);
  return res;
}
