import { vaultAccountOk } from '@maskwars/pay';
import { guard, ledger, problem, reply } from '@/lib/pay';

// Whether a NEAR wallet's key may already sign for its account in NEAR Intents. A named account adds its key once,
// with one transaction from the wallet; a passkey's vault never needs this.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = guard(req, 'key', 30);
  if (no) return no;
  const url = new URL(req.url);
  const account = url.searchParams.get('account') ?? '';
  const key = url.searchParams.get('key') ?? '';
  if (!vaultAccountOk(account) || account.startsWith('0x') || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(key)) return problem('bad', 400);
  try {
    return reply({ registered: await ledger.hasKey(account, key) });
  } catch {
    return problem('busy', 503);
  }
}
