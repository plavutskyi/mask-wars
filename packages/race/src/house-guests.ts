/**
 * Who else plays the house's round today, beside the arena's own masks: masks people forged and agents from outside.
 * The house asks once a day, when it makes the vault: the vault lets in exactly the masks it was made with, and the
 * round lists the same. Every guest is checked here against the chain, whatever anyone else said about it.
 *
 * - **People's masks** (contracts/masks): every mask the factory lists that can race now: forged, not paused, not in a
 *   race, and with fuel for one whole race of its mind (`seatFuel`). Fewest races first, then the oldest, so every mask
 *   gets its turn. Its owner pays
 *   for its mind from its tank; the keeper arms it in the round (`Live race`, job `arm`, packages/race/src/keeper.ts),
 *   and the factory gives it race keys only because the house is one of its teams.
 * - **Agents** that signed up over MCP for this very slot (packages/arena/src/guests.ts): the site keeps the sign-ups,
 *   the house reads them and checks each again: the NEP-413 signature of the slot's message, a full-access key of the
 *   account that signed it, an account that holds enough for its gas and is none of the arena's own. Among those that
 *   pass, the seats are drawn: each account's sha256 with the hash of the latest final block when the house opens the
 *   round, lowest first. Nobody knows that hash while signing up, so filling the list early, or with many accounts
 *   that share the same NEAR, buys no seat; the block is named in the log, so anyone can draw again and get the same
 *   seats. An agent plays with its own key: it seals, plays its turn, reveals and claims by itself. A network with
 *   `guests.agents: 0` (mainnet for now: agents come back there with an entry stake) reads no sign-up at all.
 *
 * A slot nobody takes stays empty; a factory or a site that does not answer lets nobody of its kind in, and the round
 * opens with the arena's own masks all the same.
 */
import { createHash } from "node:crypto";
import { AGENT_MIN_YOCTO, arenaAccount, type Signup, signupProblems } from "@maskwars/arena/guests";
import type { Network } from "@maskwars/network";
import { view, type Chain } from "./near-tx.ts";

/** A mask as the factory's `list_masks` gives it, as far as the house reads it. */
interface ListedMask {
  readonly name: string;
  readonly account: string;
  readonly brain: string;
  readonly race_limit: string;
  readonly races: number;
  readonly born_ns: string;
  readonly state: string;
}

/** The guests of one round, and a line for each one let in or turned away. */
export interface Guests {
  readonly masks: readonly string[];
  readonly agents: readonly string[];
  readonly notes: readonly string[];
}

const PAGE = 50;
/** The factory lists at most this many masks to the house: past it, the round would not have room anyway. */
const MAX_LISTED = 2_000;
/** The factory's least race limit (contracts/masks MIN_RACE_LIMIT, 0.01 NEAR): no seat for a mind with less. */
export const SEAT_FUEL_FLOOR = 10n ** 22n;

/**
 * What a person's mask holds for its mind to get a seat: one whole race at its own limit (`arm` holds `race_limit`),
 * and never less than SEAT_FUEL_FLOOR. A seat costs the house a guest's deposit and keeps another mask out for the day:
 * a mind that runs dry halfway through its race would waste both.
 */
export const seatFuel = (m: Pick<ListedMask, "race_limit">): bigint => {
  const limit = BigInt(m.race_limit);
  return limit > SEAT_FUEL_FLOOR ? limit : SEAT_FUEL_FLOOR;
};

const missing = (e: unknown) => /UNKNOWN_ACCOUNT|does not exist|MethodNotFound|CodeDoesNotExist|NO_CONTRACT_CODE/.test((e as Error).message ?? "");

/** The people's masks that can race now, fewest races first, then the oldest; at most `limit`. */
export async function forgedGuests(chain: Chain, factory: string, limit: number): Promise<{ accounts: string[]; notes: string[] }> {
  if (limit <= 0) return { accounts: [], notes: [] };
  const ready: ListedMask[] = [];
  let dry = 0;
  try {
    for (let from = 0; from < MAX_LISTED; from += PAGE) {
      const page = await view<ListedMask[]>(chain, factory, "list_masks", { from_index: from, limit: PAGE });
      // A mask with nothing on and fuel for one whole race of its mind (seatFuel).
      for (const m of page.filter((x) => x.state === "ready")) {
        if (BigInt(m.brain) >= seatFuel(m)) ready.push(m);
        else dry += 1;
      }
      if (page.length < PAGE) break;
    }
  } catch (e) {
    if (missing(e)) return { accounts: [], notes: [`${factory} is not on chain: no person's mask races today`] };
    throw e;
  }
  ready.sort((a, b) => a.races - b.races || (BigInt(a.born_ns) < BigInt(b.born_ns) ? -1 : BigInt(a.born_ns) > BigInt(b.born_ns) ? 1 : 0));
  const taken = ready.slice(0, limit);
  const notes = taken.map((m) => `${m.account}: a person's mask, ${m.races} race(s) so far`);
  if (ready.length > limit) notes.push(`${ready.length - limit} more people's mask(s) can race: they get their turn on a later day`);
  if (dry > 0) notes.push(`${dry} people's mask(s) hold less than one race of fuel for their mind: a refuel brings them back`);
  return { accounts: taken.map((m) => m.account), notes };
}

interface AccessKeyView {
  readonly permission: "FullAccess" | { readonly FunctionCall: unknown };
}

/** What stops the account of a sign-up from playing, read from the chain; null when nothing does. */
async function agentProblem(chain: Chain, net: Network, s: Signup): Promise<string | null> {
  if (arenaAccount(net, s.account)) return "one of the arena's own accounts";
  let acct: { amount: string } | null;
  try {
    acct = (await chain.rpc("query", { request_type: "view_account", finality: "final", account_id: s.account })) as { amount: string };
  } catch (e) {
    if (missing(e)) return "no such account";
    throw e;
  }
  if (BigInt(acct.amount) < AGENT_MIN_YOCTO) return "holds less than 0.05 NEAR, too little for its calls";
  try {
    const key = (await chain.rpc("query", { request_type: "view_access_key", finality: "final", account_id: s.account, public_key: s.public_key })) as AccessKeyView;
    if (key.permission !== "FullAccess") return "the key that signed is not a full-access key of the account";
  } catch (e) {
    if (/UNKNOWN_ACCESS_KEY|does not exist|access key/i.test((e as Error).message ?? "")) return "the key that signed is not on the account";
    throw e;
  }
  return null;
}

/** An account's place in the draw of `seed`: sha256 of `<seed>:<account>`, lowest first. */
export const drawKey = (seed: string, account: string): string => createHash("sha256").update(`${seed}:${account}`, "utf8").digest("hex");

/**
 * The agents of the sign-ups that pass every check, at most `limit`, drawn by `seed` (the hash of a final block nobody
 * knew while signing up): lowest `drawKey` first. Each sign-up is checked here as if the site said nothing.
 */
export async function agentGuests(chain: Chain, net: Network, slot: number, signups: readonly (Signup & { at?: number })[], limit: number, seed = ""): Promise<{ accounts: string[]; notes: string[] }> {
  const accounts: string[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  const ordered = [...signups].filter((s) => typeof s.account === "string").sort((a, b) => (drawKey(seed, a.account) < drawKey(seed, b.account) ? -1 : 1));
  for (const s of ordered) {
    if (accounts.length >= limit) {
      notes.push(`${s.account}: signed up, and the draw gave the seats to others`);
      continue;
    }
    if (seen.has(s.account)) continue;
    seen.add(s.account);
    const wrong = signupProblems(s, net.id, slot);
    if (wrong.length > 0) {
      notes.push(`${s.account}: turned away, ${wrong[0]}`);
      continue;
    }
    const why = await agentProblem(chain, net, s);
    if (why) {
      notes.push(`${s.account}: turned away, ${why}`);
      continue;
    }
    accounts.push(s.account);
    notes.push(`${s.account}: an agent, signed up over MCP`);
  }
  return { accounts, notes };
}

/** The sign-ups the site keeps for `slot`, or none when it does not answer: the round then has no agent. */
export async function fetchSignups(site: string, slot: number, get: typeof fetch = fetch): Promise<{ signups: (Signup & { at?: number })[]; note: string | null }> {
  const url = `${site.replace(/\/$/, "")}/api/round/guests?slot=${slot}`;
  try {
    const res = await get(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { signups: [], note: `${url} answered ${res.status}: no agent today` };
    const body = (await res.json()) as { slot?: number; signups?: unknown };
    if (body.slot !== slot || !Array.isArray(body.signups)) return { signups: [], note: `${url} gave no sign-ups for this slot: no agent today` };
    return { signups: body.signups as (Signup & { at?: number })[], note: null };
  } catch (e) {
    return { signups: [], note: `${url} did not answer (${(e as Error).message}): no agent today` };
  }
}

/** Everyone the house lets into today's round beside its own masks, within the network's `guests`. */
export async function pickGuests(o: { chain: Chain; net: Network; slot: number; site: string | null; get?: typeof fetch }): Promise<Guests> {
  const { chain, net, slot } = o;
  const people = await forgedGuests(chain, net.factory, net.guests.masks);
  const fetched = o.site && net.guests.agents > 0 ? await fetchSignups(o.site, slot, o.get) : { signups: [], note: null };
  // The draw's seed: the latest final block, which nobody knew while signing up. Named in the log for anyone to check.
  const block = fetched.signups.length > 0 ? ((await chain.rpc("block", { finality: "final" })) as { header: { hash: string; height: number } }) : null;
  const seed = block?.header.hash ?? "";
  const agents = await agentGuests(chain, net, slot, fetched.signups, net.guests.agents, seed);
  return {
    masks: people.accounts,
    agents: agents.accounts,
    notes: [
      ...people.notes,
      ...(fetched.note ? [fetched.note] : []),
      ...(block ? [`agents drawn by block ${block.header.height} (${seed}): sha256("<block hash>:<account>"), lowest first`] : []),
      ...agents.notes,
    ],
  };
}
