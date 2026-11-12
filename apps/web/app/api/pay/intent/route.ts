import { vaultAccountOk } from '@maskwars/pay';
import { body, guard, oneClick, problem, reply, upstream } from '@/lib/pay';

// The intent a cash-out needs signed, as 1Click builds it. The page reads it itself before the passkey or wallet sees
// it (checkIntent): this route only passes it along. Open whatever PAY_LIVE says: a person's money in a vault can
// always leave it.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const no = guard(req, 'intent', 20);
  if (no) return no;
  const b = await body(req);
  const { depositAddress, signer, standard } = b ?? {};
  if (
    typeof depositAddress !== 'string' ||
    !/^[a-z0-9._-]{2,64}$/.test(depositAddress) ||
    typeof signer !== 'string' ||
    !vaultAccountOk(signer) ||
    (standard !== 'webauthn' && standard !== 'nep413')
  ) {
    return problem('bad', 400);
  }
  try {
    return reply({ intent: await oneClick.generateIntent({ depositAddress, signerId: signer, standard }) });
  } catch (error) {
    return upstream(error);
  }
}
