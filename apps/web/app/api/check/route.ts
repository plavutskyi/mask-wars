import { InvalidAccountError, type Network, accountOk, isMainnetName, isNetwork, isTestnetName, maskCheck, networkOf, readerFor, sharedLists } from '@maskwars/check';
import { type CheckAnswer, SITE_RULES, STALE_RULES, type Tee, createTees } from '@/lib/check-tee';
import { callerOf, createLimiter } from '@/lib/limit';

// MASK CHECK for agents: GET /api/check?account=<id>[&network=testnet|mainnet] → allow, warn or block with reasons, read
// live from NEAR. Without `network` the account says which: `.testnet` reads testnet, everything else mainnet. Mainnet
// is read from two independent RPC providers that must agree: what one of them says alone is a warning, never an
// allow. A machine endpoint: any origin may call it, and every answer is read fresh from the chain.
//
// The answer comes signed from MASK CHECK's own module inside a TEE on OutLayer whenever it can (lib/check-tee.ts):
// `tee.signed` true, with the key, the signed message and the signature. Otherwise the site reads the chain itself,
// the same rules in TypeScript, and `tee.why` says why nothing is signed: among others, when the published module was
// built from an older shared list than the site reads, or when OutLayer is slow, down or out of credit.
export const dynamic = 'force-dynamic';

const readers = { testnet: readerFor('testnet', { env: process.env }), mainnet: readerFor('mainnet', { env: process.env }) };
const tees = createTees({ paymentKey: process.env.OUTLAYER_PAYMENT_KEY });

const HEADERS = { 'cache-control': 'no-store', 'access-control-allow-origin': '*' };

// One check is about ten RPC calls, twice that on mainnet, which asks two providers. A caller gets 30 checks a minute,
// an instance 600, on both networks together, so nobody floods the RPC nodes.
const perCaller = createLimiter({ perWindow: 30, windowMs: 60_000 });
const perInstance = createLimiter({ perWindow: 600, windowMs: 60_000 });

function limited(req: Request): Response | null {
  const wait = perCaller.take(callerOf(req)) ?? perInstance.take('all');
  if (wait === null) return null;
  return Response.json({ error: 'too many checks, try again shortly' }, { status: 429, headers: { ...HEADERS, 'retry-after': String(wait) } });
}

async function answer(account: unknown, network: unknown, caller: string): Promise<Response> {
  if (typeof account !== 'string' || account.length === 0 || account.length > 64) {
    return Response.json({ error: 'account: a NEAR account id, e.g. intents.near or alice.testnet' }, { status: 400, headers: HEADERS });
  }
  if (network !== undefined && network !== null && !isNetwork(network)) {
    return Response.json({ error: 'network: testnet or mainnet' }, { status: 400, headers: HEADERS });
  }
  const net: Network = isNetwork(network) ? network : networkOf(account);
  // Only a well-formed id of the network goes to the TEE: a paid call is never spent on what the check refuses anyway.
  // Everything else falls through to the check below, which refuses it with the reason.
  const id = account.trim().toLowerCase();
  let tee: Tee | null = null;
  if (accountOk(id) && !(net === 'testnet' && isMainnetName(id)) && !(net === 'mainnet' && isTestnetName(id))) {
    try {
      const signed = await tees.ask(id, net, caller);
      // A signed answer goes out only when the module that made it checks by the site's own rules and shared list:
      // otherwise a safe drained since it was published would lose its block under a TEE signature.
      if ('check' in signed && signed.tee.module.rules === SITE_RULES) return Response.json({ ...signed.check, tee: signed.tee } satisfies CheckAnswer, { headers: HEADERS });
      tee = 'check' in signed ? { signed: false, why: STALE_RULES } : signed;
    } catch {
      // The TEE is a strength on top of the check, never a reason for the check to fail.
      tee = { signed: false, why: "the TEE's answer could not be read: the site read this one itself" };
    }
  }
  try {
    const check = await maskCheck(account, { network: net, reader: readers[net], list: sharedLists[net] });
    return Response.json({ ...check, tee: tee ?? { signed: false, why: 'the site read this answer itself' } } satisfies CheckAnswer, { headers: HEADERS });
  } catch (error) {
    if (error instanceof InvalidAccountError) return Response.json({ error: error.message }, { status: 400, headers: HEADERS });
    throw error;
  }
}

export async function GET(req: Request) {
  const no = limited(req);
  if (no) return no;
  const q = new URL(req.url).searchParams;
  return answer(q.get('account'), q.get('network'), callerOf(req));
}

export async function POST(req: Request) {
  const no = limited(req);
  if (no) return no;
  const raw = await req.text();
  if (raw.length > 1_000) return Response.json({ error: 'too large' }, { status: 413, headers: HEADERS });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: 'JSON body: {"account": "<id>", "network": "testnet" | "mainnet"}' }, { status: 400, headers: HEADERS });
  }
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  return answer(b.account, b.network, callerOf(req));
}

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: { ...HEADERS, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' },
  });
}
