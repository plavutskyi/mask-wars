import { verifyWebauthn, type SignedIntent } from '@maskwars/pay';
import { body, guard, oneClick, problem, reply, upstream } from '@/lib/pay';

// A signed cash-out intent on its way to 1Click. A passkey signature is checked here too, so a broken one never leaves.
// Open whatever PAY_LIVE says: a person's money in a vault can always leave it.
export const dynamic = 'force-dynamic';

function shaped(s: unknown): s is SignedIntent {
  if (!s || typeof s !== 'object') return false;
  const x = s as Record<string, unknown>;
  const str = (k: string) => typeof x[k] === 'string' && (x[k] as string).length > 0;
  if (x.standard === 'webauthn') return str('payload') && str('public_key') && str('signature') && str('client_data_json') && str('authenticator_data');
  if (x.standard === 'nep413') {
    const p = x.payload as Record<string, unknown> | null;
    return !!p && typeof p.message === 'string' && typeof p.nonce === 'string' && typeof p.recipient === 'string' && str('public_key') && str('signature');
  }
  return false;
}

export async function POST(req: Request) {
  const no = guard(req, 'submit', 10);
  if (no) return no;
  const b = await body(req, 16_000);
  const signed = b?.signed;
  if (!shaped(signed)) return problem('bad', 400);
  if (signed.standard === 'webauthn' && !verifyWebauthn(signed)) return problem('signature', 422);
  try {
    return reply(await oneClick.submitIntent(signed));
  } catch (error) {
    return upstream(error);
  }
}
