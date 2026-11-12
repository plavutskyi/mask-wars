/**
 * The tape of the masks at work (fixtures/jobs-work.json, recorded by scripts/jobs-sandbox.ts on a local NEAR sandbox)
 * replayed once for every test that reads it: each pass of the masks (src/work.ts) and of the house (src/sponsor.ts)
 * runs again with no network, signs the same transactions byte for byte, and keeps what it read, so a test can change
 * one fact of a pass and plan again.
 */
import { readFileSync } from "node:fs";
import { ChainReader } from "@maskwars/check";
import { Indexer } from "@maskwars/arena";
import { Jobs } from "@maskwars/arena/jobs";
import { outsideRules } from "@maskwars/arena/jobs";
import { NETWORKS } from "@maskwars/network";
import { base58Encode, JsonRpc, NearKey } from "../src/near-tx.ts";
import { describeSponsor, sponsor, type SponsorPass } from "../src/sponsor.ts";
import { replayingFetch, type Tape } from "../src/tape.ts";
import { describe as say, work, type OutsideRules, type Ours, type Pass, type Verdict } from "../src/work.ts";

export interface Recorded {
  label: string;
  who?: "house";
  crew: string | null;
  block: number;
  readAt: number;
  done: { what: string; ok: boolean; sent: boolean; hash: string | null; note?: string; error?: string }[];
  skips: { job: string; mask?: string; why: string }[];
  race: { job: string; bounty: string; round: string; striker: string | null } | null;
  next: number | null;
  steps: { job: string; seq: number; mask: string; revealed: boolean; copyOf: number | null; content: string | null }[];
}
export interface About {
  rpc: string;
  indexer: string;
  jobs: string;
  crews: string;
  bounty: string;
  team: string;
  masks: Record<string, string>;
  seeds: Record<string, string>;
  crew: string;
  outsider: string;
  house: string;
  /** The 32-byte seed of the house's throwaway key on that sandbox, in hex, as the masks' seeds are. */
  houseSeed: string;
  houseBefore: string;
  houseAfter: string;
  houseKeeps: string;
  blocked: string[];
  people: Record<string, string>;
  sources: Record<string, string>;
}

export const tape = JSON.parse(readFileSync(new URL("./fixtures/jobs-work.json", import.meta.url), "utf8")) as Tape & { passes: Recorded[]; about: About };
export const about = tape.about;
export const A = "break-safe-0101";
export const B = "break-safe-0102";
/** The jobs from outside on the house's round, as the recording opened them. */
export const C = "race-0103-ivy001";
export const D = "race-0103-dana01";
export const E = "race-0103-ivy002";
export const F = "race-0103-erin01";
export const G = "race-0103-finn01";
export const H = "race-0103-mal001";
const OURS = [A, B, C, D, E, F, G, H];
/** The sandbox's root account: the owner who locked every bond on our team's jobs (jobs-sandbox.ts, `bondFor`). */
export const OWNER = "test.near";
/**
 * The network's limits.jobs as the recording ran them: as on mainnet, but for the site's clock. A sandbox has none: its
 * passes are made by hand, at whatever hour the recording ran, so no run of the clock is asked inside a reveal window.
 */
export const OUTSIDE: OutsideRules = { ...outsideRules(NETWORKS.mainnet), revealRuns: 0 };
/** The house's key on the tape's sandbox, from its seed: no secret key is written out in the fixture. */
export const houseKey = () => new NearKey(`ed25519:${base58Encode(Buffer.from(about.houseSeed, "hex"))}`);

export const ours = (crew: string | null): Ours => ({
  masks: about.masks,
  signers: Object.keys(about.seeds),
  bounties: [about.bounty],
  teams: [about.team, about.house],
  owners: [OWNER, about.team, about.house],
  raceBounty: about.bounty,
  raceTeams: [about.team],
  crew,
  outside: OUTSIDE,
});
/** MASK CHECK's stand-in on the tape: it blocks MALLORY and lets everyone else through. */
export const check = async (account: string): Promise<Verdict> => (about.blocked.includes(account) ? "block" : "allow");

/** The chain as the tape has it: a reader and a signer over one replay, as one run of the workflow has them. */
export function replay(f: typeof fetch) {
  const jobs = new Jobs({
    config: { network: "sandbox", contract: about.jobs, crews: about.crews, rpc: [about.rpc], indexer: about.indexer, explorer: null },
    rpc: new ChainReader({ endpoints: [about.rpc], fetch: f }),
    indexer: new Indexer({ base: about.indexer, fetch: f, timeoutMs: 2_000 }),
    ttlMs: 0,
  });
  return { jobs, chain: new JsonRpc(about.rpc, 60_000, f) };
}

export interface Replayed {
  /** Each pass as the recording wrote it down, from the replay. */
  readonly seen: Recorded[];
  /** Each pass itself: the masks' or the house's, with what it read. */
  readonly raw: ({ who: "masks"; pass: Pass } | { who: "house"; pass: SponsorPass })[];
  readonly unasked: string[];
}

const stepsOf = (board: Pass["board"]) =>
  board.jobs.filter((j) => OURS.includes(j.id)).flatMap((j) => j.steps.map((st) => ({ job: j.id, seq: st.seq, mask: st.mask.account, revealed: st.revealed, copyOf: st.copyOf, content: st.content })));

/** Every pass of the tape, run again in order over one replay. */
export async function replayAll(): Promise<Replayed> {
  const r = replayingFetch(tape);
  const { jobs, chain } = replay(r.fetch);
  const refused = new Set<string>();
  const seen: Recorded[] = [];
  const raw: Replayed["raw"] = [];
  const key = houseKey();
  for (const rec of tape.passes) {
    if (rec.who === "house") {
      const p = await sponsor({
        chain,
        jobs,
        jobsContract: about.jobs,
        crewsContract: about.crews,
        ours: ours(rec.crew),
        house: about.house,
        key,
        keeps: BigInt(about.houseKeeps),
        check,
        houseSealUntil: async () => null,
        round: { live: false, first_minute: 0, every_minutes: 1440 },
        nonceRetryMs: 0,
      });
      raw.push({ who: "house", pass: p });
      seen.push({
        ...rec,
        block: p.board.block!.height,
        readAt: p.board.readAt,
        done: p.done.map((d) => ({ what: describeSponsor(d.act), ok: d.ok, sent: true, hash: d.hash, ...(d.error ? { error: d.error } : {}) })),
        skips: [...p.plan.skips],
        race: null,
        next: null,
        steps: [],
      });
      continue;
    }
    const p = await work({ chain, jobs, jobsContract: about.jobs, crewsContract: about.crews, ours: ours(rec.crew), seeds: about.seeds, check, refused, nonceRetryMs: 0 });
    raw.push({ who: "masks", pass: p });
    seen.push({
      ...rec,
      block: p.board.block!.height,
      readAt: p.board.readAt,
      done: p.done.map((d) => ({ what: say(d.act), ok: d.ok, sent: d.sent, hash: d.hash, ...(d.note ? { note: d.note } : {}), ...(d.error ? { error: d.error } : {}) })),
      skips: [...p.plan.skips],
      race: p.plan.race,
      next: p.plan.next,
      steps: stepsOf(p.board),
    });
  }
  return { seen, raw, unasked: r.unasked() };
}

let once: Promise<Replayed> | null = null;
/** `replayAll`, once for the whole test file. */
export const replayed = () => (once ??= replayAll());

/** The n-th pass of the tape (from 1), the masks' own, with what it read. */
export async function masksPass(n: number): Promise<Pass> {
  const p = (await replayed()).raw[n - 1]!;
  if (p.who !== "masks") throw new Error(`pass ${n} is the house's`);
  return p.pass;
}

/** The n-th pass of the tape (from 1), the house's, with what it read. */
export async function housePass(n: number): Promise<SponsorPass> {
  const p = (await replayed()).raw[n - 1]!;
  if (p.who !== "house") throw new Error(`pass ${n} is the masks'`);
  return p.pass;
}
