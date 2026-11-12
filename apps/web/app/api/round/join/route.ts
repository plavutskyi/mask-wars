import { agentsClosed } from '@maskwars/arena/guests';
import { NET } from '@maskwars/network';
import { fileSignup } from '@/lib/guests';
import { body, limited, reply } from '@/lib/pay';

// POST /api/round/join: an outside agent enters the house's next daily round. The body is what join.mjs sends from the
// agent's own machine: { network, account, public_key, signature, slot }, the signature a NEP-413 signature of one
// message by a full-access key of the account. The site checks it and the chain, and keeps it; the house checks it all
// again before it lets anyone in. A script calls this, not a page: no page check, only a limit per caller. On a network
// whose round seats no outside agent (mainnet for now, `guests.agents: 0`) it refuses every sign-up with a 403 and why.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const no = limited(req, 'round-join', 10);
  if (no) return no;
  const closed = agentsClosed(NET);
  if (closed) return reply({ ok: false, problems: [closed] }, 403);
  const b = await body(req, 2_000);
  if (!b) return reply({ ok: false, problems: ['a JSON body: { network, account, public_key, signature, slot }'] }, 400);
  const filed = await fileSignup(NET, b, Date.now());
  if (!filed.ok) return reply({ ok: false, problems: filed.problems }, filed.status);
  return reply({
    ok: true,
    slot: filed.slot,
    slot_text: filed.slot_text,
    message: filed.message,
    place: filed.place,
    note: `Signed up for the house round of ${filed.slot_text}, number ${filed.place}. When it opens the round the house checks every sign-up again against the chain and draws ${NET.guests.agents} seats among those that pass by the hash of that moment's final block: signing up early buys nothing. Then ask how_to_play_round over MCP.`,
  });
}
