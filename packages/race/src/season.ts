/**
 * The season's scheduler (contracts/season). Its key is a function-call key on the treasury for `open_next` and
 * `collect` alone: it says "now", and the treasury decides the rest from its program (target, masks, bounty, the
 * safe's NEAR, windows, judge) and opens nothing that is not due or not within its limits; `collect` only brings
 * finished rounds home. This is all the scheduled workflow does before it starts the race on the round that opened.
 *
 * A round already open for this slot and still sealing is raced as it is, whoever opened it: an earlier run that died
 * after `open_next`, or anyone holding the scheduler's key. A slot that was due and got no round turns the run red.
 */
import { call, view, type CallResult, type Chain, type NearKey } from "./near-tx.ts";
import { chainTime } from "./live.ts";

/** A round the treasury opened (`latest`, and the value `open_next` returns). Amounts and times are decimal strings. */
export interface SeasonRound {
  readonly id: string;
  readonly n: number;
  readonly safe: string;
  readonly challenge: string;
  readonly code_hash: string;
  readonly prize: string;
  readonly safe_fund: string;
  readonly min_loot: string;
  readonly masks: readonly string[];
  readonly slot_ns: string;
  readonly opened_ns: string;
  readonly commit_until_ns: string;
  readonly deadline_ns: string;
  /** The bounty contract it opened on, and how it ended there once `collect` saw it. */
  readonly bounty?: string;
  readonly outcome?: string | null;
}

/** The treasury's schedule (`season().program`): a round is due every `every_minutes` from `first_minute`. */
export interface Schedule {
  readonly first_minute: number;
  readonly every_minutes: number;
}

/** The next round (`next`): when, on what, for how much, and whether the treasury can pay for it. */
export interface NextRound {
  readonly at_ns: string;
  readonly n: number;
  readonly challenge: string;
  readonly code_hash: string;
  readonly prize: string;
  readonly safe_fund: string;
  readonly min_loot: string;
  readonly masks: readonly string[];
  readonly hours: number;
  readonly commit_minutes: number;
  readonly reveal_minutes: number;
  readonly funded: boolean;
  readonly treasury: string;
}

export interface OpenOptions {
  readonly chain: Chain;
  /** The treasury's account. */
  readonly season: string;
  /** The scheduler's account and its function-call key for `open_next`. */
  readonly scheduler: string;
  readonly key: NearKey;
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** How long to look for the round in `latest` after `open_next` failed or its answer was lost. */
  readonly settleMs?: number;
}

export type Opened =
  /** This run opened the round. */
  | { readonly kind: "opened"; readonly round: SeasonRound; readonly tx: string }
  /** A round is already open for this slot and still sealing: the race takes it as it is. */
  | { readonly kind: "open"; readonly round: SeasonRound; readonly why: string }
  /** Nothing is due: the run stays green. */
  | { readonly kind: "waiting"; readonly why: string }
  /** A slot was due and no round opened for it: the show missed it, and the run goes red. */
  | { readonly kind: "missed"; readonly why: string; readonly tx?: string };

/** The gas `open_next` carries for the whole chain: the bounty contract's state, the safe, `open_safe`, callbacks. */
export const OPEN_GAS_TGAS = 300;

const near = (yocto: string) => `${(Number(BigInt(yocto) / 10n ** 21n) / 1000).toFixed(3)} NEAR`;
const when = (ns: string | bigint) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().replace(".000Z", "Z");
const NS_PER_MINUTE = 60_000_000_000n;

/** The latest slot of the schedule at or before `now`, ns, as the treasury counts it; `null` before the first. */
export function latestSlot(p: Schedule, now: bigint): bigint | null {
  const minute = now / NS_PER_MINUTE;
  const first = BigInt(p.first_minute);
  const every = BigInt(Math.max(p.every_minutes, 1));
  return minute < first ? null : (first + ((minute - first) / every) * every) * NS_PER_MINUTE;
}

/** The round the treasury opened for `slot`, if its latest round is that one. */
async function roundOfSlot(o: OpenOptions, slot: bigint): Promise<SeasonRound | null> {
  const [last] = await view<SeasonRound[]>(o.chain, o.season, "latest", { limit: 1 });
  return last && BigInt(last.slot_ns) === slot ? last : null;
}

/**
 * Opens the round that is due, if one is, or hands over the one already open for this slot while it still seals. A
 * treasury that cannot pay for the round is an error: the show would stop, and the workflow should go red so somebody
 * tops it up.
 */
export async function openNext(o: OpenOptions): Promise<Opened> {
  const log = o.log ?? (() => {});
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = await chainTime(o.chain);
  const { program } = await view<{ program: Schedule }>(o.chain, o.season, "season");
  const slot = latestSlot(program, now);
  if (slot !== null) {
    const opened = await roundOfSlot(o, slot);
    if (opened && now < BigInt(opened.commit_until_ns)) {
      return { kind: "open", round: opened, why: `round ${opened.id} is already open for the slot of ${when(slot)}: racing it` };
    }
    if (opened) return { kind: "waiting", why: `round ${opened.id} already sealed for the slot of ${when(slot)}` };
  }
  const next = await view<NextRound | null>(o.chain, o.season, "next");
  if (!next) {
    const why = "no target of the program can run: the admin's program needs a fix";
    return slot === null ? { kind: "waiting", why } : { kind: "missed", why: `the slot of ${when(slot)} gets no round: ${why}` };
  }
  log(`next: #${next.n} ${next.challenge} at ${when(next.at_ns)}, bounty ${near(next.prize)}, safe ${near(next.safe_fund)}`);
  const due = BigInt(next.at_ns);
  if (due > now) return { kind: "waiting", why: `no round is due before ${when(next.at_ns)}` };
  if (!next.funded) {
    throw new Error(`the treasury holds ${near(next.treasury)} for rounds: too little for round #${next.n}, fund ${o.season}`);
  }
  // The call may land even when its answer does not come back, or fail because another run's round is on its way: in
  // both cases the round that opened for the slot shows in `latest` within a few blocks.
  const landed = async (): Promise<SeasonRound | null> => {
    const until = Date.now() + (o.settleMs ?? 60_000);
    for (;;) {
      const round = await roundOfSlot(o, due).catch(() => null);
      if (round || Date.now() >= until) return round;
      await sleep(5_000);
    }
  };
  let r: CallResult;
  try {
    r = await call(o.chain, o.scheduler, o.key, o.season, "open_next", {}, OPEN_GAS_TGAS);
  } catch (e) {
    const round = await landed();
    if (round) return { kind: "opened", round, tx: `(the answer was lost: ${round.id} is in latest)` };
    throw new Error(`open_next: ${(e as Error).message}`);
  }
  for (const line of r.logs ?? []) if (!line.startsWith("EVENT_JSON:")) log(`  ${line}`);
  if (!r.ok) {
    const round = await landed();
    if (round) return { kind: "opened", round, tx: r.hash };
    throw new Error(`open_next failed: ${r.error ?? r.hash}`);
  }
  const round = r.value as SeasonRound | null | boolean | undefined;
  if (round && typeof round === "object" && typeof round.id === "string") return { kind: "opened", round, tx: r.hash };
  const why = (r.logs ?? []).find((l) => l.startsWith("no round this time: ") || l.includes("did not open"));
  return { kind: "missed", why: `the slot of ${when(due)} gets no round: ${why ?? "the treasury opened none"}`, tx: r.hash };
}

/** The gas `collect` carries: `settle`, `refund`, the round's state and the callback, for up to 2 finished rounds. */
export const COLLECT_GAS_TGAS = 300;

/**
 * Brings finished rounds home with the same key: the bounty contract pays a confirmed winner nobody paid yet, and sends
 * a bounty nobody won back to the treasury. Returns how many rounds it asked about; 0 sends nothing.
 *
 * For every round, one of `settle` and `refund` always fails on the bounty contract, by design: the transaction
 * then shows a failed receipt, but what counts is the value `collect` itself returned.
 */
export async function collectFinished(o: OpenOptions): Promise<number> {
  const ready = await view<number>(o.chain, o.season, "collectable");
  if (!ready) return 0;
  const r = await call(o.chain, o.scheduler, o.key, o.season, "collect", {}, COLLECT_GAS_TGAS);
  if (typeof r.value === "number") return r.value;
  throw new Error(`collect failed: ${r.error ?? r.hash}`);
}

/** The lines the workflow's summary shows for a round. */
export function roundSummary(round: SeasonRound, tx: string): string[] {
  return [
    `### Round ${round.id}`,
    "",
    `- target: \`${round.challenge}\` on \`${round.safe}\` (code \`${round.code_hash}\`)`,
    `- in the safe: ${near(round.safe_fund)}, bounty: ${near(round.prize)}, a drain counts from ${near(round.min_loot)}`,
    `- masks: ${round.masks.map((m) => `\`${m}\``).join(", ")}`,
    `- sealing until ${when(round.commit_until_ns)}, deadline ${when(round.deadline_ns)}`,
    `- open_next: ${tx}`,
  ];
}
