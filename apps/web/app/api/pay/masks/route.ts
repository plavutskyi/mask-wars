import { vaultAccountOk } from '@maskwars/pay';
import { FACTORY, forgeLive, guard, ledger, MIN_REFUEL, problem, reply } from '@/lib/pay';

// The masks a vault's owner forged, so the vault can fuel their minds: the factory's `masks_of`, read from NEAR mainnet
// on every call. Only a vault opened by a NEAR wallet has masks (the forge signs with a NEAR wallet), and only while
// PAY_LIVE is on and the factory is on chain (`sections.forge` of packages/network/mainnet.json, `forgeLive`); otherwise
// the answer is `open: false` with no masks, and the vault shows no Fuel.
export const dynamic = 'force-dynamic';

const NAME = /^[a-z][a-z0-9]{2,15}$/;
const YOCTO = /^\d{1,40}$/;

interface Raw {
  readonly name?: unknown;
  readonly account?: unknown;
  readonly look?: unknown;
  readonly brain?: unknown;
  readonly fuel?: unknown;
  readonly state?: unknown;
}

/** One mask as the vault shows it: what it looks like and what its mind holds. */
function maskOf(m: Raw) {
  if (typeof m.name !== 'string' || !NAME.test(m.name) || m.account !== `${m.name}.${FACTORY}`) return null;
  if (typeof m.brain !== 'string' || !YOCTO.test(m.brain) || typeof m.fuel !== 'string' || !YOCTO.test(m.fuel)) return null;
  return {
    name: m.name,
    account: m.account,
    look: typeof m.look === 'string' ? m.look : '',
    brain: m.brain,
    fuel: m.fuel,
    state: typeof m.state === 'string' ? m.state : 'ready',
  };
}

export async function GET(req: Request) {
  // Up to ten reads a fuel (one before signing, the rest reading back): a minute holds several.
  const no = guard(req, 'masks', 60);
  if (no) return no;
  const account = new URL(req.url).searchParams.get('account') ?? '';
  if (!vaultAccountOk(account)) return problem('bad', 400);
  if (!forgeLive || account.startsWith('0x')) return reply({ open: forgeLive, factory: FACTORY, minRefuel: MIN_REFUEL, masks: [] });
  try {
    const list = await ledger.call<unknown>(FACTORY, 'masks_of', { owner: account });
    if (!Array.isArray(list)) return problem('busy', 503);
    // A mask still being forged takes no fuel yet (`refuel` refuses it), so it is not offered.
    const masks = list
      .map((m) => (m && typeof m === 'object' ? maskOf(m as Raw) : null))
      .filter((m) => m !== null && m.state !== 'forging')
      .slice(0, 24);
    return reply({ open: true, factory: FACTORY, minRefuel: MIN_REFUEL, masks });
  } catch {
    return problem('busy', 503);
  }
}
