import type { Race } from '@maskwars/arena';
import { asOf, pickNow, readArena } from '@/lib/arena';
import { callerOf, createLimiter } from '@/lib/limit';
import { body, guard, problem, reply } from '@/lib/pay';
import { callerName, choiceIn, type Entry, keyIn, keyOk, lastDecided, outcomeOf, pickOn, sealedShut, windowOf, withPick } from '@/lib/pick';
import { cookieLine, cookiesOf, entriesCookie, entriesOf, filePick, fromTag, newDevice, PICKS_COOKIE, pickStore, readBoard, seal, settleOnce, WHO_COOKIE, whoOf } from '@/lib/picks';
import { shareToken } from '@/lib/share';

// Pick the breaker. POST files a person's pick on the round that takes picks now; GET says how their calls stand:
// the streak, the table's numbers, and the signed claim their share card is drawn from. The window, the choices and
// how a round ended are read from the chain here, never taken from the page. So is the moment picks close: a round's
// first seal in this server's reading of the arena, and with no seal the end of its sealing window.
export const dynamic = 'force-dynamic';

/** New people from one address per hour, per instance: a page that mints a person per request gets nowhere. */
const newcomers = createLimiter({ perWindow: 12, windowMs: 3_600_000 });

const secure = (req: Request) => new URL(req.url).protocol === 'https:';

export async function POST(req: Request) {
  const no = guard(req, 'pick', 20);
  if (no) return no;
  const b = await body(req, 500);
  if (!b || !keyOk(b.key) || typeof b.choice !== 'string') return problem('bad', 400);
  let view;
  try {
    view = await readArena();
  } catch {
    return problem('busy', 503);
  }
  // A reading the chain could not renew cannot say the window is still open: no new picks on it.
  if (asOf(view) !== null) return reply({ error: 'old' }, 409);
  const now = pickNow();
  const w = windowOf(view, now, false);
  if (!w) {
    // The round's first seal is on chain: from here a pick would read the answer. The reason goes back with the no.
    const seal = sealedShut(view);
    return reply(seal !== null ? { error: 'closed', why: 'seal', at: seal } : { error: 'closed' }, 409);
  }
  // A page that showed the round before it opened sends its scheduled time: the same round, now under its own key.
  if (!keyIn(w, b.key, view)) return reply({ error: 'moved', key: w.key }, 409);
  if (!choiceIn(w, b.choice)) return problem('bad', 400);

  const jar = cookiesOf(req);
  let who = whoOf(jar[WHO_COOKIE]);
  const from = callerOf(req);
  if (!who) {
    if (newcomers.take(from) !== null) return reply({ error: 'busy' }, 429);
    who = newDevice();
  }
  const entry: Entry = { key: w.key, choice: b.choice, at: now };
  try {
    await filePick(pickStore(), w.key, { who, choice: b.choice, from: fromTag(from), at: now });
  } catch {
    return problem('busy', 503);
  }
  const entries = withPick(entriesOf(jar[PICKS_COOKIE]), entry);
  const headers = new Headers({ 'cache-control': 'no-store' });
  headers.append('set-cookie', cookieLine(WHO_COOKIE, seal(who), secure(req)));
  headers.append('set-cookie', cookieLine(PICKS_COOKIE, entriesCookie(entries), secure(req)));
  return Response.json({ pick: entry, closes: w.closes }, { headers });
}

export async function GET(req: Request) {
  const no = guard(req, 'pick-read', 30);
  if (no) return no;
  const jar = cookiesOf(req);
  const who = whoOf(jar[WHO_COOKIE]);
  const entries = entriesOf(jar[PICKS_COOKIE]);
  let view;
  try {
    view = await readArena();
  } catch {
    return reply({ name: who ? callerName(who) : null, linked: who?.startsWith('a') ?? false, me: null, share: null });
  }
  // The round asked about (the race page), else the last one that ended.
  const id = new URL(req.url).searchParams.get('race');
  const race: Race | null = id ? (view.races.find((r) => r.id === id) ?? null) : lastDecided(view.races);
  const board = await settleOnce(view).catch(() => readBoard().catch(() => null));
  const me = who && board ? (board.callers[who] ?? null) : null;
  // The claim a share card is drawn from: this person's pick on a round that ended, signed here. Their own device's
  // record says what they picked; the chain says how the round ended; the board says how long their run is.
  let share: string | null = null;
  const mine = race && outcomeOf(race) !== null ? pickOn(entries, race, view.races) : null;
  if (race && mine) {
    const run = me?.last?.race === race.id ? me.streak : null;
    share = shareToken({ race: race.id, choice: mine.choice, streak: run });
  }
  return reply({
    name: who ? callerName(who) : null,
    linked: who?.startsWith('a') ?? false,
    me: me ? { streak: me.streak, best: me.best, right: me.right, calls: me.calls, last: me.last } : null,
    share,
  });
}
