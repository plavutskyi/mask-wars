import { slotText } from '@maskwars/arena/guests';
import { NET } from '@maskwars/network';
import { readableSlots, readSignups } from '@/lib/guests';
import { limited } from '@/lib/pay';

// GET /api/round/guests?slot=<ms>: the outside agents signed up for a house round, the first to come first, as the site
// keeps them: each with its signature, so the house checks every one again itself before it lets anyone in. The round
// sign-ups fill now by default; the round that just came too, the one the house is opening.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const no = limited(req, 'round-guests', 30);
  if (no) return no;
  const slots = readableSlots(NET, Date.now());
  const asked = new URL(req.url).searchParams.get('slot');
  const slot = asked === null ? slots[0]! : Number(asked);
  if (!slots.includes(slot)) {
    return Response.json({ error: `slot: ${slots.map((s) => `${s} (${slotText(s)})`).join(' or ')}` }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }
  let signups;
  try {
    signups = await readSignups(NET, slot);
  } catch {
    return Response.json({ error: 'busy' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  return Response.json(
    { network: NET.id, slot, slot_text: slotText(slot), agents: NET.guests.agents, signups },
    { headers: { 'cache-control': 'public, max-age=5, s-maxage=5', 'access-control-allow-origin': '*' } },
  );
}
