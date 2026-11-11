import { accountOf, keyBytes, type SignedWebauthn, verifyWebauthn } from '@maskwars/pay';
import { pickNow, readArena } from '@/lib/arena';
import { body, guard, origins, problem } from '@/lib/pay';
import { type Entry, pickInWindow, windowOf } from '@/lib/pick';
import { cookieLine, cookiesOf, entriesOf, filePick, fromTag, linkDevice, PICKS_COOKIE, pickStore, seal, WHO_COOKIE, whoOf } from '@/lib/picks';
import { callerOf } from '@/lib/limit';

// A person with a vault on this site picks as their vault from now on: one touch of their passkey over a short,
// dated line proves the account is theirs. What their device picked before goes with them to the vault.
export const dynamic = 'force-dynamic';

const FRESH_MS = 10 * 60_000;

export async function POST(req: Request) {
  const no = guard(req, 'pick-link', 6);
  if (no) return no;
  const b = await body(req, 4_000);
  const s = b?.signed as SignedWebauthn | undefined;
  if (!s || s.standard !== 'webauthn' || typeof s.payload !== 'string' || typeof s.client_data_json !== 'string') return problem('bad', 400);
  let line: { maskwars?: unknown; site?: unknown; at?: unknown };
  let client: { origin?: unknown };
  try {
    line = JSON.parse(s.payload);
    client = JSON.parse(s.client_data_json);
  } catch {
    return problem('bad', 400);
  }
  const allowed = origins(req);
  const site = new URL(req.url).host;
  if (line.maskwars !== 'pick-as-vault' || line.site !== site || typeof line.at !== 'number' || Math.abs(Date.now() - line.at) > FRESH_MS) return problem('signature', 401);
  if (typeof client.origin !== 'string' || !allowed.includes(client.origin)) return problem('signature', 401);
  const key = keyBytes(s.public_key);
  if (!key || !verifyWebauthn(s)) return problem('signature', 401);
  const vault = `a${accountOf(key)}`;

  const jar = cookiesOf(req);
  const before = whoOf(jar[WHO_COOKIE]);
  const store = pickStore();
  try {
    if (before && before !== vault) await linkDevice(store, before, vault);
    // The pick this device made on the round that is open now is the vault's pick too.
    const view = await readArena().catch(() => null);
    const w = view ? windowOf(view, pickNow(), false) : null;
    const mine: Entry | null = view && w ? pickInWindow(entriesOf(jar[PICKS_COOKIE]), w, view) : null;
    if (w && mine) await filePick(store, w.key, { who: vault, choice: mine.choice, from: fromTag(callerOf(req)), at: pickNow() });
  } catch {
    return problem('busy', 503);
  }
  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', cookieLine(WHO_COOKIE, seal(vault), new URL(req.url).protocol === 'https:'));
  return Response.json({ linked: true }, { headers });
}
