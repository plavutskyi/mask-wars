// The site's side of an outside agent entering the house's daily round: it keeps the sign-ups, and nothing more. An
// agent signs one message with a full-access key of its own NEAR account (NEP-413, @maskwars/arena/guests); the site
// checks it, checks the chain (the account is there, the key is a full-access key of it, it holds enough for the
// round's gas, it is not one of the arena's own) and files it for the round. The house reads the list before it makes
// the round's vault and checks every sign-up again itself: the site is a mailbox, never the word that lets an account in.
//
// Where: Vercel Blob, the store the site already has for picks, /break and the vault's passkeys
// (BLOB_READ_WRITE_TOKEN): one small JSON blob per account and round, `guests/v1/<network>/<slot>/<account>`, so one
// listing reads a round. With no token (a local run, a recording) the same is kept in this process's memory.
import { AGENT_MIN_YOCTO, agentsClosed, arenaAccount, fillingSlot, openingSlot, type Signup, signupMessage, signupProblems, slotText } from '@maskwars/arena/guests';
import type { Network } from '@maskwars/network';
import { blobPicks, memoryPicks, type PickStore } from './picks';

/** Sign-ups kept for one round. The house draws `guests.agents` seats among those that still pass its checks. */
export const GUEST_CAP = 64;

/** A sign-up as the site keeps it: what the agent sent and when it first came. */
export interface Filed extends Signup {
  readonly at: number;
}

const fixture = Boolean(process.env.ARENA_FIXTURE);
const blobOn = !fixture && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const globals = globalThis as unknown as { __maskwarsGuests?: PickStore };

export function guestStore(): PickStore {
  globals.__maskwarsGuests ??= blobOn ? blobPicks() : memoryPicks();
  return globals.__maskwarsGuests;
}

/** A fresh store in memory, for tests. */
export function forgetGuests(): void {
  globals.__maskwarsGuests = memoryPicks();
}

const roundDir = (net: Pick<Network, 'id'>, slot: number) => `guests/v1/${net.id}/${slot}/`;

/** The slots the list is read for: the one sign-ups fill now, and the one that just came, which the house is opening. */
export function readableSlots(net: Pick<Network, 'round'>, nowMs: number): number[] {
  const opening = openingSlot(net, nowMs);
  return [fillingSlot(net, nowMs), ...(opening === null ? [] : [opening])];
}

// ---- The chain ---------------------------------------------------------------------------------------------------------

type Fetch = typeof fetch;

/** One RPC query on the network, the first endpoint that answers deciding. `null` when the chain says it is not there. */
async function query(net: Pick<Network, 'rpc'>, params: Record<string, unknown>, f: Fetch): Promise<Record<string, unknown> | null> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 'maskwars-guests', method: 'query', params: { finality: 'final', ...params } });
  let last: unknown = null;
  for (const url of net.rpc) {
    try {
      const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(8000) });
      const out = (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
      if (out.result) return out.result;
      const text = JSON.stringify(out.error ?? '');
      if (/UNKNOWN_ACCOUNT|does not exist|UNKNOWN_ACCESS_KEY|access key .* does not exist/i.test(text)) return null;
      last = text;
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`no RPC answered: ${String(last)}`);
}

/**
 * What the chain says against a sign-up, at the final block: an empty list when nothing. Throws only when no RPC
 * answers at all.
 */
export async function chainProblems(net: Network, account: string, publicKey: string, f: Fetch = fetch): Promise<string[]> {
  if (arenaAccount(net, account)) return [`account: ${account} is one of the arena's own, not a guest`];
  const acc = await query(net, { request_type: 'view_account', account_id: account }, f);
  if (!acc) return [`account: ${account} is not on NEAR ${net.id}`];
  const out: string[] = [];
  if (BigInt(String(acc.amount ?? '0')) < AGENT_MIN_YOCTO) out.push(`account: ${account} holds less than 0.05 NEAR, the gas a round's calls take`);
  const key = await query(net, { request_type: 'view_access_key', account_id: account, public_key: publicKey }, f);
  if (!key) out.push(`public_key: ${publicKey} is not a key of ${account}`);
  else if (key.permission !== 'FullAccess') out.push(`public_key: a function-call key of ${account}; sign with a full-access key of the account`);
  return out;
}

// ---- The record ----------------------------------------------------------------------------------------------------------

/** Every sign-up for round `slot`, the first to come first. A blob that does not read as one is left out. */
export async function readSignups(net: Pick<Network, 'id'>, slot: number, store: PickStore = guestStore()): Promise<Filed[]> {
  const dir = roundDir(net, slot);
  const names = await store.names(dir);
  const read = await Promise.all(names.map((n) => store.read(`${dir}${n}`).catch(() => null)));
  const out: Filed[] = [];
  for (const text of read) {
    try {
      const f = JSON.parse(text ?? '') as Filed;
      if (typeof f.account === 'string' && typeof f.at === 'number' && f.slot === slot) out.push(f);
    } catch {
      // not a sign-up
    }
  }
  return out.sort((a, b) => a.at - b.at || a.account.localeCompare(b.account));
}

export type Filing =
  | { readonly ok: true; readonly slot: number; readonly slot_text: string; readonly message: string; readonly place: number; readonly at: number }
  | { readonly ok: false; readonly status: 400 | 403 | 409 | 503; readonly problems: readonly string[] };

/**
 * Files a sign-up for the round sign-ups fill now, after every check: its shape and signature, then the chain. The
 * same account signing up again keeps its first place. The list holds at most `GUEST_CAP` accounts a round. A network
 * whose round seats no outside agent (`guests.agents: 0`, mainnet for now) files nothing and says why.
 */
export async function fileSignup(net: Network, raw: Record<string, unknown>, nowMs: number, opts: { store?: PickStore; fetch?: Fetch } = {}): Promise<Filing> {
  const closed = agentsClosed(net);
  if (closed) return { ok: false, status: 403, problems: [closed] };
  const store = opts.store ?? guestStore();
  const slot = fillingSlot(net, nowMs);
  if (raw.network !== net.id) return { ok: false, status: 400, problems: [`network: this site takes sign-ups for NEAR ${net.id}`] };
  const s: Partial<Signup> = {
    ...(typeof raw.account === 'string' ? { account: raw.account } : {}),
    ...(typeof raw.public_key === 'string' ? { public_key: raw.public_key } : {}),
    ...(typeof raw.signature === 'string' ? { signature: raw.signature } : {}),
    ...(typeof raw.slot === 'number' ? { slot: raw.slot } : {}),
  };
  const shape = signupProblems(s, net.id, slot);
  if (shape.length > 0) return { ok: false, status: 400, problems: shape };
  let onChain: string[];
  try {
    onChain = await chainProblems(net, s.account!, s.public_key!, opts.fetch ?? fetch);
  } catch {
    return { ok: false, status: 503, problems: ['the chain did not answer: try again in a minute'] };
  }
  if (onChain.length > 0) return { ok: false, status: 400, problems: onChain };

  const path = `${roundDir(net, slot)}${s.account}`;
  const before = await store.read(path).catch(() => null);
  let at = nowMs;
  if (before) {
    try {
      at = (JSON.parse(before) as Filed).at ?? nowMs;
    } catch {
      // a blob that is not one: written anew
    }
  } else if ((await store.names(roundDir(net, slot))).length >= GUEST_CAP) {
    // Full: every sign-up the chain no longer backs (its NEAR moved on, its key went) makes room. Many accounts sharing
    // the same 0.05 NEAR keep only one place, and the list never holds out a real agent for long.
    const kept = await readSignups(net, slot, store);
    const f = opts.fetch ?? fetch;
    for (const k of kept) {
      const gone = await chainProblems(net, k.account, k.public_key, f).then((p) => p.length > 0).catch(() => false);
      if (gone) await store.remove(`${roundDir(net, slot)}${k.account}`).catch(() => {});
    }
    if ((await store.names(roundDir(net, slot))).length >= GUEST_CAP) {
      return { ok: false, status: 409, problems: [`the round of ${slotText(slot)} has ${GUEST_CAP} sign-ups the chain still backs: sign up for the next one after it opens`] };
    }
  }
  const filed: Filed = { account: s.account!, public_key: s.public_key!, signature: s.signature!, slot, at };
  await store.write(path, JSON.stringify(filed));
  const list = await readSignups(net, slot, store);
  const place = list.findIndex((f) => f.account === filed.account) + 1;
  return { ok: true, slot, slot_text: slotText(slot), message: signupMessage(net.id, slot, filed.account), place, at };
}
