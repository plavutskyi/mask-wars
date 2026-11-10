// A sealed round: its record, its story, its thread, cards and clip plan, and the reader that makes the record from
// the chain. The chain answers are replayed from `fixtures/example-round.json`, a made-up round (`example-0000`, every
// account under `example.testnet`) in the wire formats of NEAR JSON-RPC and the FastNEAR explorer API, and from
// testnet's own recorded answers about race-0003 in `packages/arena/test/fixtures`. A round under a real id is only
// ever built in memory here, to check how its words read; nothing made up is written next to the real records.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexerError, parseTx, type Tx } from "@maskwars/arena";
import { type Exchange, type Recording, recordFetch, replayFetch } from "@maskwars/arena/replay";
import { ChainError } from "@maskwars/check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SIMULATED_BAND as CARD_BAND } from "../src/cards/html.ts";
import { launch, shootPage } from "../src/cards/render.ts";
import { keyFrames } from "../src/clip/render.ts";
import { SIMULATED_BAND, SimulatedBand } from "../src/clip/SimulatedBand.tsx";
import { lintThread, nearShort, parseRace, planRaceClip, RACE_CARDS, RACE_CLIP, raceCaptions, raceStory, raceThread, readSeconds, roundOf, SCENES, threadMarkdown, xLength } from "../src/index.ts";
import { raceCardHtml, RACE_CARD } from "../src/race/cards.ts";
import { judgeRun, roundFromChain } from "../src/race/chain.ts";
import { exampleChain, ID, pretendChain, READ_AT, readerOn, type Variant } from "./fixtures/make-example-round.ts";

const here = import.meta.dirname;
const race3 = (): any => JSON.parse(readFileSync(join(here, "../races/race-0003.json"), "utf8"));
const answers = JSON.parse(readFileSync(join(here, "fixtures/example-round.json"), "utf8")) as Recording & { simulated?: boolean };
const testnet = JSON.parse(readFileSync(join(here, "../../arena/test/fixtures/testnet.json"), "utf8")) as Recording;

/** The example round, read by the real reader from the recorded made-up answers. */
const EXAMPLE = await roundFromChain(ID, readerOn(replayFetch(answers)), "SIMULATED");
const example = (): any => structuredClone(EXAMPLE);
/** The example played another way, read by the same reader from the pretend chain itself. */
const played = (v: Variant, at?: number) => roundFromChain(ID, readerOn(exampleChain(v), at), "SIMULATED");

/** In memory only: the example's steps under a season round's id, to check how a season round reads. */
const seasonRound = (): any => ({ ...example(), id: "s1-0001-0a1b2c" });
/** In memory only: a round the team opened by hand, under a race's id. */
const handRound = async (): Promise<any> => ({ ...(await played({ hand: true })), id: "race-0005" });

/** The recording with the bounty contract's answer to `method` replaced. */
function answering(method: string, edit: (value: any) => unknown): Recording {
  const exchanges = answers.exchanges.map((e): Exchange => {
    const p = (e.request as { params?: Record<string, string> } | null)?.params;
    if (p?.request_type !== "call_function" || p.method_name !== method) return e;
    const r = e.response as { result: { result: number[] } };
    const value = edit(JSON.parse(Buffer.from(r.result.result).toString("utf8")));
    return { ...e, response: { ...r, result: { ...r.result, result: [...Buffer.from(JSON.stringify(value))] } } };
  });
  return { ...answers, exchanges };
}

/** Another round, unlike the example in what the machine branches on: mainnet, six masks, the copy's board, round 12. */
function rehearsal(): any {
  const r = example();
  return {
    ...r,
    network: "mainnet",
    id: "s2-0012-0a1b2c",
    safe: "250",
    bounty: "40",
    masks: ["ONYX", "NOVA", "ORACLE", "WRAITH", "RONIN", "VOLT"].map((name) => ({ name })),
    sandbox: { run: 42270915840, repo: "plavutskyi/mask-wars", startedAt: "2026-11-10T18:01:00Z", board: [{ mask: "ORACLE", attempt: 3, atMs: 87_000, verdict: "breach" }] },
    drain: { ...r.drain, amount: "249.25", txs: r.drain.txs.map((t: any) => (t.amount ? { ...t, amount: "249.25" } : t)) },
    payout: { ...r.payout, amount: "39.8776123456" },
    next: { round: 13, safe: "250", bounty: "40", at: "2026-12-01T18:00:00Z" },
  };
}

describe("a sealed round's record", () => {
  it("is told apart from a race written by hand, and both read", () => {
    expect(roundOf("s1-0001-d74851")).toEqual({ season: 1, round: 1 });
    expect(roundOf("s12-0107-00ff9a")).toEqual({ season: 12, round: 107 });
    expect(roundOf("race-0003")).toBeNull();
    expect(roundOf(ID)).toBeNull();
    expect(parseRace(race3())).toMatchObject({ id: "race-0003", winner: "NOVA" });
    const r = parseRace(example());
    expect(r).toMatchObject({ id: "example-0000", source: "SIMULATED", network: "testnet", season: "season.example.testnet", safe: "1.5", bounty: "0.35", winner: "ORACLE" });
    expect("sealed" in r && r.sealed).toMatchObject({ minutes: 45, closedAt: "2026-11-10T18:45:06.550Z" });
    expect("sealed" in r && r.sealed.seals.map((s) => [s.mask, s.seq])).toEqual([["ORACLE", 0], ["NOVA", 1]]);
    expect(r.drain.txs.map((t) => [t.method, t.amount])).toEqual([["set_owner", undefined], ["sweep", "1.48"]]);
  });

  it("refuses a round whose steps do not line up, with the step named", () => {
    const r = example();
    const sealed = (over: object) => ({ ...r, sealed: { ...r.sealed, ...over } });
    expect(() => parseRace({ ...r, winner: "ONYX" })).toThrow(/the winner is one of the race's masks/);
    expect(() => parseRace({ ...r, masks: [...r.masks, { name: "ONYX" }], winner: "ONYX" })).toThrow(/the winner sealed a plan/);
    expect(() => parseRace({ ...r, drain: { ...r.drain, at: "2026-11-10T18:30:00Z" } })).toThrow(/after the window closes/);
    expect(() => parseRace(sealed({ seals: [{ ...r.sealed.seals[0], at: "2026-11-10T18:50:00Z" }] }))).toThrow(/while the window is open/);
    expect(() => parseRace(sealed({ seals: [r.sealed.seals[1], r.sealed.seals[0]] }))).toThrow(/order of their numbers/);
    expect(() => parseRace(sealed({ seals: [r.sealed.seals[0], { ...r.sealed.seals[1], mask: "ORACLE" }] }))).toThrow(/seals one plan/);
    expect(() => parseRace(sealed({ reveal: { ...r.sealed.reveal, at: "2026-11-10T18:45:10Z" } }))).toThrow(/revealed after it is played/);
    expect(() => parseRace(sealed({ claim: { ...r.sealed.claim, at: "2026-11-10T18:45:25Z" } }))).toThrow(/after the reveal/);
    expect(() => parseRace({ ...r, payout: { ...r.payout, at: "2026-11-10T18:45:30Z" } })).toThrow(/pays after the claim/);
    expect(() => parseRace({ ...r, safe: "1.2" })).toThrow(/than was put in/);
    expect(() => parseRace({ ...r, sealed: undefined })).toThrow(/sealed/);
    // A race told by its board keeps its own rules: it needs its sandbox board, a sealed round does not.
    expect(() => parseRace({ ...race3(), sandbox: undefined })).toThrow(/sandbox/);
    expect(() => parseRace({ ...r, id: "s1-1-d74851" })).toThrow(/race-0005 for a round opened by hand/);
  });

  it("says who opened it by what it holds: a season round names its treasury, a round opened by hand has none", () => {
    const r = example();
    expect(() => parseRace({ ...r, id: "s1-0001-0a1b2c", season: undefined })).toThrow(/names its season treasury/);
    expect(() => parseRace({ ...r, id: "race-0005" })).toThrow(/has no season treasury/);
    expect(parseRace({ ...r, id: "race-0005", season: undefined })).toMatchObject({ id: "race-0005" });
  });

  it("an example round is never LIVE", () => {
    expect(() => parseRace({ ...example(), source: "LIVE" })).toThrow(/an example round is made up/);
  });

  it("keeps no made-up round among the real ones: every record in races/ is LIVE, and shots/ holds real rounds only", () => {
    const races = readdirSync(join(here, "../races")).filter((f) => f.endsWith(".json"));
    expect(races).toContain("race-0003.json");
    for (const f of races) {
      const r = parseRace(JSON.parse(readFileSync(join(here, "../races", f), "utf8")));
      expect(r.source, f).toBe("LIVE");
      expect(`${r.id}.json`, f).toBe(f);
    }
    const shots = join(here, "../shots");
    for (const d of existsSync(shots) ? readdirSync(shots, { withFileTypes: true }) : []) {
      // Only folders of real rounds: no loose picture, and no round without its LIVE record.
      expect(d.isDirectory(), d.name).toBe(true);
      expect(races, d.name).toContain(`${d.name}.json`);
    }
  });

  it("shows an amount cut to five decimals, never rounded up", () => {
    expect(nearShort("0.08664")).toBe("0.08664");
    expect(nearShort("1")).toBe("1");
    expect(nearShort("0.0011183205")).toBe("0.00111");
    expect(nearShort("0.0011095005")).toBe("0.0011");
    expect(nearShort("39.8776199999")).toBe("39.87761");
    expect(nearShort("0.999999")).toBe("0.99999");
    expect(nearShort("0.00000123")).toBe("0.0000012");
    expect(nearShort("2.000001")).toBe("2");
  });
});

describe("the round's story", () => {
  it("an example is called an example, every number from the record", () => {
    const s = raceStory(example());
    if (s.kind !== "round") throw new Error("a round");
    expect([s.title, s.kicker, s.name, s.heading, s.where]).toEqual(["EXAMPLE ROUND", "EXAMPLE ROUND · TESTNET", "the example round", "Example round", "An example round"]);
    expect([s.season, s.round, s.opener]).toEqual([null, null, "season"]);
    expect([s.safe, s.bounty, s.drained, s.paid, s.total]).toEqual(["1.5", "0.35", "1.48", "0.21142", "1.69142"]);
    expect([s.sealMinutes, s.seals, s.sealPlace]).toEqual([45, 2, 1]);
    expect(s.sealed).toMatchObject({ words: "6 min 12 s", clock: "06:12", short: { n: "6", unit: "MINUTES" } });
    expect(s.played).toMatchObject({ words: "17 s", short: { n: "17", unit: "SECONDS" } });
    expect(s.judge).toEqual({ seconds: "1.2", cost: "0.00111" });
    expect(s.breach).toBeNull();
    expect(s.winner).toMatchObject({ name: "ORACLE", model: "Qwen3.8 27B" });
    // Only the masks that moved on chain: ONYX was entered and did nothing.
    expect(s.masks.map((m) => m.name)).toEqual(["ORACLE", "NOVA"]);
    const r = example();
    expect(s.links).toEqual({
      open: `https://testnet.nearblocks.io/txns/${r.opened.tx}`,
      seal: `https://testnet.nearblocks.io/txns/${r.sealed.seals[0].tx}`,
      drain: `https://testnet.nearblocks.io/txns/${r.drain.txs[1].hash}`,
      reveal: `https://testnet.nearblocks.io/txns/${r.sealed.reveal.tx}`,
      claim: `https://testnet.nearblocks.io/txns/${r.sealed.claim.tx}`,
      payout: `https://testnet.nearblocks.io/txns/${r.payout.tx}`,
      run: null,
    });
    expect(s.drainLinks).toEqual([s.links.drain]);
    expect(s.simulated).toBe(true);
  });

  it("a season round is called by its season and its number, on either network", () => {
    const s = raceStory(seasonRound());
    if (s.kind !== "round") throw new Error("a round");
    expect([s.title, s.kicker, s.name, s.heading, s.where]).toEqual(["SEASON 1 · ROUND 1", "SEASON 1 · ROUND 1 · TESTNET", "round 1", "Season 1 · Round 1", "Season 1, round 1"]);
    expect([s.season, s.round, s.no, s.opener]).toEqual([1, 1, 1, "season"]);
    const other = raceStory(rehearsal());
    if (other.kind !== "round") throw new Error("a round");
    expect([other.title, other.kicker]).toEqual(["SEASON 2 · ROUND 12", "SEASON 2 · ROUND 12 · NEAR"]);
    expect(other.breach).toMatchObject({ tryWords: "third try", words: "1 min 27 s" });
    expect(other.paid).toBe("39.87761");
    expect(other.links.run).toBe("https://github.com/plavutskyi/mask-wars/actions/runs/42270915840");
  });

  it("a round opened by hand is a race by its number, never a season's round", async () => {
    const s = raceStory(await handRound());
    if (s.kind !== "round") throw new Error("a round");
    expect([s.title, s.kicker, s.name, s.heading, s.where]).toEqual(["RACE 5", "RACE 5 · TESTNET", "race 5", "Race 5", "Race 5"]);
    expect([s.season, s.round, s.no, s.opener]).toEqual([null, null, 5, "hand"]);
    const old = raceStory(race3());
    expect([old.kind, old.title, old.kicker, old.name]).toEqual(["race", "RACE 3", "RACE 3 · NEAR TESTNET", "race 3"]);
  });
});

describe("the round's thread", () => {
  const s = raceStory(seasonRound());
  const posts = raceThread(s);
  const all = posts.map((p) => p.text).join("\n");

  it("passes every check, opens whole in the feed with no link, and each post has its own picture", () => {
    expect(lintThread(posts)).toEqual([]);
    expect(posts).toHaveLength(5);
    expect(xLength(posts[0]!.text)).toBeLessThanOrEqual(280);
    expect(posts[0]!.text).toMatch(/^An AI mask broke into a vault on NEAR testnet and walked out with 1\.48 NEAR\./);
    expect(posts[0]!.text).toContain("Season 1, round 1");
    expect(posts[0]!.media).toMatchObject({ kind: "clip", poster: "cards/01-result.png" });
    expect(posts.slice(1).map((p) => p.media.kind === "card" && p.media.card)).toEqual(RACE_CARDS.slice(1));
  });

  it("says what it is, the round step by step, the numbers with links, and how to try it", () => {
    expect(posts[1]!.text).toMatch(/^MASK WARS is an arena/);
    expect(posts[1]!.text).toContain("A season treasury opens a fresh vault");
    expect(posts[2]!.text).toBe(
      [
        "How round 1 went:",
        [
          "1. The season treasury opened a fresh vault: 1.5 NEAR inside, a 0.35 NEAR bounty on top.",
          "2. ORACLE sealed its plan on chain 6 min 12 s in, the first of 2 sealed plans. Only a hash, so nobody could copy it.",
          "3. The vault stayed locked until the 45 minute sealing window closed.",
          "4. 17 s later ORACLE played the plan on the real vault with its own key: 1.48 NEAR out.",
          "5. ORACLE revealed the plan, and a judge checked the drain against it.",
          "6. The contract paid ORACLE 0.21142 NEAR.",
        ].join("\n"),
      ].join("\n\n"),
    );
    const r = example();
    for (const hash of [r.sealed.seals[0].tx, r.drain.txs[1].hash, r.payout.tx]) expect(posts[3]!.text).toContain(`testnet.nearblocks.io/txns/${hash}`);
    expect(posts[3]!.text).toContain("1.2 s for 0.00111 NEAR");
    expect(posts[3]!.text).toContain("(the 0.35 NEAR bounty after storage and fees)");
    expect(posts[4]!.text).toContain("github.com/plavutskyi/mask-wars\npnpm install && pnpm demo");
    expect(posts[4]!.text).toContain("maskwars.xyz/break");
    // The next round is the one the treasury named when the round was read.
    expect(posts[4]!.text).toContain("Round 2 opens Nov 11 at 18:00 UTC with 1.5 NEAR in the vault.");
    expect(raceThread(raceStory({ ...seasonRound(), next: undefined }))[4]!.text).not.toMatch(/opens|UTC/);
  });

  it("says only what the record holds: no work off chain, no mask that never moved", () => {
    expect(all).not.toMatch(/\brace \d/i);
    expect(all).not.toMatch(/first try|private copy|attacked a|broke the copy/);
    expect(all).not.toMatch(/every number|by itself|on its own\b/i);
    // ONYX was entered in the round and made no move on chain: it is not named anywhere.
    expect(all).not.toContain("ONYX");
    for (const kind of RACE_CARDS) expect(raceCardHtml(kind, s).slice(raceCardHtml(kind, s).indexOf("<body>")).replace(/<[^>]+>/g, " "), kind).not.toMatch(/ONYX|COPY|ATTACK/);
    expect(Object.values(raceCaptions(s)).join(" ")).not.toMatch(/ONYX|copy|attack/i);
    // What the arena answers about this vault is not in the record, so the thread does not say it.
    expect(all).not.toMatch(/BLOCK|api\/check/);
    for (const tag of all.match(/@\w+/g) ?? []) expect(["@NEARProtocol", "@near_ai", "@out_layer"]).toContain(tag);
  });

  it("every number in it comes from the record", () => {
    const r = example();
    const known = new Set([
      "1.5", "0.35", "1.48", "0.21142", "1.2", "0.00111", "45", "6", "12", "17",
      // the steps, the season and the round, the next round and its hour
      "1", "2", "3", "4", "5", "11", "18", "00",
      ...r.masks.flatMap((m: any) => String(m.model).match(/\d+(?:\.\d+)?/g) ?? []),
    ]);
    const hashes = new Set([r.sealed.seals[0].tx, r.drain.txs[1].hash, r.payout.tx]);
    const words = all.replace(/\b[1-9A-HJ-NP-Za-km-z]{43,44}\b/g, (h) => (hashes.has(h) ? "" : h));
    for (const n of words.match(/\d+(?:\.\d+)?/g) ?? []) expect(known.has(n), n).toBe(true);
  });

  it("tells the masks' race on a copy only from a sandbox board in the record, and names only the masks on it", () => {
    const o = raceStory(rehearsal());
    const p = raceThread(o);
    expect(lintThread(p)).toEqual([]);
    expect(p[0]!.text).toContain("on NEAR and walked out with 249.25 NEAR");
    expect(p[0]!.text).toContain("Season 2, round 12");
    expect(p[2]!.text).toContain("ORACLE broke a private copy of the vault on its third try and sealed its plan on chain 6 min 12 s in");
    expect(p[2]!.text).not.toContain("attacked a private copy");
    expect(p[3]!.text).toContain("nearblocks.io/txns/");
    expect(p[3]!.text).not.toContain("testnet");
    expect(p[4]!.text).toContain("Round 13 opens Dec 1 at 18:00 UTC with 250 NEAR in the vault.");
    // Two masks on the board: the two are named, the four that are not on it are not.
    const two = { ...rehearsal(), sandbox: { ...rehearsal().sandbox, board: [{ mask: "VOLT", attempt: 1, atMs: 30_000, verdict: "fail" }, { mask: "ORACLE", attempt: 3, atMs: 87_000, verdict: "breach" }] } };
    expect(raceThread(raceStory(two))[2]!.text).toContain("2. VOLT and ORACLE attacked a private copy of it.");
    expect(raceCaptions(raceStory(two)).attack).toBe("VOLT and ORACLE attack a private copy of it.");
    // A long first post gives way to its shorter form instead of failing the run.
    const long = raceThread(raceStory({ ...rehearsal(), payout: { ...rehearsal().payout, amount: "39.87761" } }));
    expect(xLength(long[0]!.text)).toBeLessThanOrEqual(280);
  });

  it("a round opened by hand is told as a race, by its bounty, with the season's next round named as the season's", async () => {
    const h = raceStory(await handRound());
    const p = raceThread(h);
    const text = p.map((x) => x.text).join("\n");
    expect(lintThread(p)).toEqual([]);
    expect(p[0]!.text).toContain("This is MASK WARS. Race 5, step by step:");
    expect(p[1]!.text).toContain("A vault opens with NEAR inside and a bounty on top.");
    expect(p[2]!.text).toContain("How race 5 went:");
    expect(p[2]!.text).toContain("1. A vault opened with a 0.35 NEAR bounty for the first mask to drain it.");
    expect(p[4]!.text).toContain("Season round 1 opens Nov 11 at 18:00 UTC with 1.5 NEAR in the vault.");
    expect(text).not.toMatch(/Season \d|season treasury opened|How round|NEAR inside, a/);
    const md = threadMarkdown(h, p);
    expect(md).toContain("# X thread: Race 5, ORACLE");
    expect(md).toContain("- The round opened with a 0.35 NEAR bounty: https://testnet.nearblocks.io/txns/");
  });

  it("the draft is English, names each post's picture, links every step, and says when the numbers are made up", () => {
    const md = threadMarkdown(s, posts, { clipSeconds: 39.3 });
    expect(md).toContain("# X thread: Season 1 · Round 1, ORACLE");
    expect(md).toContain("**SIMULATED: the numbers are made up. Do not post.**");
    expect(md).toContain(`| 1/ | \`clip.mp4\`, 39 s; cover \`cards/01-result.png\` | ${xLength(posts[0]!.text)} |`);
    for (const p of posts) expect(md).toContain(p.text);
    if (s.kind !== "round") throw new Error("a round");
    for (const url of [s.links.open, s.links.seal!, s.links.drain, s.links.reveal, s.links.claim, s.links.payout]) expect(md).toContain(url);
    expect(md).toContain("OutLayer request 20417, 1.2 s, 0.00111 NEAR");
    expect(md).not.toMatch(/[\u0400-\u04ff]/);
    // A made-up record says so in its sources too, and never that it was read from testnet.
    expect(md).toContain("- SIMULATED: made-up answers");
    expect(md).not.toMatch(/read through the arena reader at/);
  });
});

describe("a plan that sweeps the vault in two transactions", () => {
  it("keeps both drains, each with its own amount, and the drain is their sum", async () => {
    const r = await played({ sweeps: [980, 500] });
    expect(r.drain.txs.map((t) => [t.method, t.amount])).toEqual([["set_owner", undefined], ["sweep", "0.98"], ["sweep", "0.5"]]);
    expect(r.drain.amount).toBe("1.48");
    // The drain is done when its last transaction lands.
    expect(r.drain.at).toBe(r.drain.txs[2]!.at);
    expect(Date.parse(r.drain.txs[2]!.at!)).toBeGreaterThan(Date.parse(r.drain.txs[1]!.at!));
  });

  it("links every transaction that moved the NEAR, so the links add up to the number over them", async () => {
    const r = await played({ sweeps: [980, 500] });
    const s = raceStory(r);
    const link = (i: number) => `testnet.nearblocks.io/txns/${r.drain.txs[i]!.hash}`;
    expect(s.drained).toBe("1.48");
    expect(s.drainLinks).toEqual([`https://${link(1)}`, `https://${link(2)}`]);
    const posts = raceThread(s);
    expect(lintThread(posts)).toEqual([]);
    expect(posts[3]!.text).toContain(`The drain, 1.48 NEAR in 2 transactions:\n${link(1)}\n${link(2)}`);
    expect(threadMarkdown(s, posts)).toContain(`- The drain, 1.48 NEAR, 19 s after the window closed: https://${link(1)} and https://${link(2)}`);
    // One sweep reads as it always did.
    expect(raceThread(raceStory(example()))[3]!.text).toContain(`The drain, 1.48 NEAR:\ntestnet.nearblocks.io/txns/${EXAMPLE.drain.txs[1]!.hash}`);
  });

  it("refuses a record whose amount is not what its transactions moved", async () => {
    const r: any = await played({ sweeps: [980, 500] });
    expect(() => parseRace({ ...r, drain: { ...r.drain, amount: "1.5" } })).toThrow(/what its transactions moved/);
    expect(() => parseRace({ ...r, drain: { ...r.drain, txs: r.drain.txs.slice(0, 2) } })).toThrow(/what its transactions moved/);
  });
});

describe("the round's clip plan", () => {
  const s = raceStory(seasonRound());
  const plan = planRaceClip(s);

  it("has the sealing window between the seal and the drain, scenes back to back, 15 to 45 seconds", () => {
    expect(SCENES).toEqual(["result", "vault", "race", "lock", "drain", "paid", "end"]);
    let at = 0;
    for (const id of SCENES) {
      expect(plan.scenes[id].from, id).toBe(at);
      expect(plan.scenes[id].to, id).toBeGreaterThan(at);
      at = plan.scenes[id].to;
    }
    expect(at).toBe(plan.durationInFrames);
    expect(plan.durationInFrames / RACE_CLIP.fps).toBeGreaterThanOrEqual(15);
    expect(plan.durationInFrames / RACE_CLIP.fps).toBeLessThanOrEqual(45);
    expect(plan.countdown!.from).toBeGreaterThan(plan.scenes.lock.from);
    expect(plan.countdown!.to).toBeLessThan(plan.scenes.lock.to);
    expect(keyFrames(plan).map((f) => f.name)).toEqual(["1-result", "2-vault", "3-race", "4-breach", "4b-lock", "5-drain", "6-paid", "7-end"]);
  });

  it("a race told by its board has no sealing window, and its frames are the seven it always had", () => {
    const old = planRaceClip(raceStory(race3()));
    expect(old.scenes.lock.to).toBe(old.scenes.lock.from);
    expect(old.countdown).toBeNull();
    expect(keyFrames(old).map((f) => f.name)).toEqual(["1-result", "2-vault", "3-race", "4-breach", "5-drain", "6-paid", "7-end"]);
  });

  it("burns in one line at a time, each long enough to read, carrying the round's own numbers", () => {
    for (const [i, c] of plan.captions.entries()) {
      if (i > 0) expect(c.from).toBeGreaterThanOrEqual(plan.captions[i - 1]!.to);
      // A scene is cut on a whole frame, so a line may stay half a frame less than its reading time.
      expect((c.to - c.from + 12) / RACE_CLIP.fps, c.text).toBeGreaterThanOrEqual(readSeconds(c.text) - 0.5 / RACE_CLIP.fps - 1e-9);
    }
    expect(raceCaptions(s)).toEqual({
      vault: "The season treasury opens a vault on NEAR testnet: 1.5 NEAR inside, 0.35 NEAR on top.",
      attack: "The masks have 45 minutes to seal a plan on chain.",
      breach: "6 min 12 s in, ORACLE seals its plan on chain. Only its hash shows.",
      lock: "The real vault stays locked until the window closes.",
      drain: "Then ORACLE plays its sealed plan with its own key. 1.48 NEAR out.",
      paid: "A judge in a secure enclave checks the drain in 1.2 s. The contract pays ORACLE.",
    });
  });

  it("the longest round still fits, and a round opened by hand opens on its bounty", async () => {
    const p = planRaceClip(raceStory(rehearsal()));
    expect(p.durationInFrames / RACE_CLIP.fps).toBeLessThanOrEqual(45);
    expect(raceCaptions(raceStory(rehearsal())).breach).toContain("breaks a private copy on its third try and seals its plan on chain");
    const h = raceStory(await handRound());
    expect(raceCaptions(h).vault).toBe("A vault opens on NEAR testnet with a 0.35 NEAR bounty for the first mask that drains it.");
    expect(planRaceClip(h).durationInFrames / RACE_CLIP.fps).toBeLessThanOrEqual(45);
  });
});

describe("the round's cards", () => {
  const s = raceStory(seasonRound());
  const text = (kind: (typeof RACE_CARDS)[number], story = s) => raceCardHtml(kind, story).slice(raceCardHtml(kind, story).indexOf("<body>")).replace(/<[^>]+>/g, "");

  it("carry the season and the round, not a race number, with nothing small and no address", () => {
    for (const kind of RACE_CARDS) {
      const html = raceCardHtml(kind, s);
      const body = html.slice(html.indexOf("</style>"));
      for (const m of body.matchAll(/font-size:(\d+)px/g)) expect(Number(m[1]), kind).toBeGreaterThanOrEqual(36);
      expect(body, kind).not.toMatch(/tinygif|example\.testnet|nearblocks|\bRACE \d/);
    }
    expect(text("result")).toContain("SEASON 1 · ROUND 1 · TESTNET");
    expect(text("result")).toContain("1.48 NEAR");
    // Two masks moved on chain in the round, so two stand in the arena.
    expect(text("arena")).toContain("TWO AI MASKS. ONE VAULT.");
    expect(text("how")).toContain("SEASON 1 · ROUND 1, STEP BY STEP");
    for (const step of ["THE TREASURY OPENS A VAULT", "NEAR INSIDE", "ORACLE SEALS ITS PLAN ON CHAIN", "MINUTES AFTER THE OPENING", "THE VAULT STAYS LOCKED", "ORACLE PLAYS ITS SEALED PLAN", "THE JUDGE CONFIRMS THE DRAIN", "NEAR PAID TO ORACLE"]) {
      expect(text("how")).toContain(step);
    }
    expect(text("numbers")).toContain("SEASON 1 · ROUND 1 · BY THE NUMBERS");
    expect(text("numbers")).toContain("MINUTES TO SEAL THE PLAN");
  });

  it("the next round is on the card only as the record holds it, and without it no hour is drawn", () => {
    expect(text("next")).toContain("ROUND 2");
    expect(text("next")).toContain("IN THE VAULT · NOV 11, 18:00 UTC");
    // Figures in a line of words are set in the number face: the word face bars its zero.
    expect(raceCardHtml("next", s)).toContain('<span style="font-family:var(--font-num)">18:00</span>');
    const none = raceStory({ ...seasonRound(), next: undefined });
    expect(text("next", none)).toContain("CONTRACT");
    expect(text("next", none)).not.toMatch(/ROUND|UTC|NOV/);
  });

  it("a round opened by hand carries its race number and its bounty, and the season's next round as the season's", async () => {
    const h = raceStory(await handRound());
    expect(text("result", h)).toContain("RACE 5 · TESTNET");
    expect(text("how", h)).toContain("RACE 5, STEP BY STEP");
    expect(text("how", h)).toContain("THE VAULT OPENS");
    expect(text("how", h)).toContain("NEAR BOUNTY");
    expect(text("how", h)).not.toContain("NEAR INSIDE");
    expect(text("next", h)).toContain("SEASON ROUND 1");
    for (const kind of RACE_CARDS) expect(text(kind, h), kind).not.toMatch(/SEASON \d/);
  });

  it("renders every card at 1600×900 with no console error, for this round, the longest one and one opened by hand", async () => {
    const browser = await launch();
    try {
      for (const story of [s, raceStory(rehearsal()), raceStory(await handRound())]) {
        for (const kind of RACE_CARDS) {
          const png = await shootPage(browser, raceCardHtml(kind, story), { ...RACE_CARD, scale: 1 }, kind);
          expect([png.readUInt32BE(16), png.readUInt32BE(20)], kind).toEqual([1600, 900]);
        }
      }
    } finally {
      await browser.close();
    }
  }, 180_000);
});

describe("a picture drawn from made-up numbers", () => {
  it("carries the band on every card, and a real round's card has none", () => {
    expect(CARD_BAND).toBe("SIMULATED · NOT A REAL RESULT");
    expect(SIMULATED_BAND).toBe(CARD_BAND);
    for (const story of [raceStory(example()), raceStory(seasonRound()), raceStory(rehearsal())]) {
      for (const kind of RACE_CARDS) {
        const html = raceCardHtml(kind, story);
        expect(html, kind).toContain(`class="sim-band"`);
        expect(html, kind).toContain(`>${CARD_BAND}</div>`);
      }
    }
    for (const kind of RACE_CARDS) expect(raceCardHtml(kind, raceStory(race3())), kind).not.toMatch(/SIMULATED|class="sim/);
  });

  it("the band crosses the whole card through its centre and the word covers every corner: no crop is left without it", async () => {
    const browser = await launch();
    try {
      for (const kind of RACE_CARDS) {
        const page = await browser.newPage({ viewport: { width: RACE_CARD.width, height: RACE_CARD.height } });
        await page.setContent(raceCardHtml(kind, raceStory(example())), { waitUntil: "load" });
        await page.waitForFunction("window.__cardReady === true");
        const seen = await page.evaluate(() => {
          const band = document.querySelector(".sim-band")!;
          const box = band.getBoundingClientRect();
          const at = (x: number, y: number) => document.elementFromPoint(x, y);
          const grid = [0.03, 0.25, 0.5, 0.75, 0.97].flatMap((fx) => [0.04, 0.3, 0.5, 0.7, 0.96].map((fy) => at(1600 * fx, 900 * fy)?.closest(".sim") !== null));
          const tile = document.querySelector(".sim-tile")!.getBoundingClientRect();
          return {
            centre: at(800, 450) === band,
            left: box.left,
            right: box.right,
            size: parseFloat(getComputedStyle(band).fontSize),
            thick: parseFloat(getComputedStyle(band).height),
            solid: getComputedStyle(band).backgroundColor,
            grid,
            tile: [tile.left, tile.top, tile.right, tile.bottom],
          };
        });
        expect(seen.centre, kind).toBe(true);
        expect(seen.left, kind).toBeLessThanOrEqual(0);
        expect(seen.right, kind).toBeGreaterThanOrEqual(RACE_CARD.width);
        expect(seen.size, kind).toBeGreaterThanOrEqual(60);
        expect(seen.thick, kind).toBeGreaterThanOrEqual(120);
        expect(seen.solid, kind).toBe("rgb(255, 178, 63)");
        expect(seen.grid.every(Boolean), kind).toBe(true);
        expect(seen.tile[0]!, kind).toBeLessThanOrEqual(0);
        expect(seen.tile[1]!, kind).toBeLessThanOrEqual(0);
        expect(seen.tile[2]!, kind).toBeGreaterThanOrEqual(RACE_CARD.width);
        expect(seen.tile[3]!, kind).toBeGreaterThanOrEqual(RACE_CARD.height);
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }, 120_000);

  it("the clip carries the same band over every frame, at the frame's size", () => {
    const html = renderToStaticMarkup(createElement(SimulatedBand, { width: RACE_CLIP.width }));
    expect(html).toContain(`>${SIMULATED_BAND}</div>`);
    expect(html).toContain("font-size:77px");
    expect(html).toContain("width:120%");
    expect(html).toContain("background:#ffb23f");
    // The composition draws it over everything whenever the story is made up, and never otherwise.
    expect(readFileSync(join(here, "../src/clip/RaceClip.tsx"), "utf8")).toContain("{s.simulated ? <SimulatedBand width={W} /> : null}");
  });
});

describe("the round read from the chain", () => {
  it("makes the record from one reading of the round: the opening, the seals, the plan, the reveal, the claim, the judge, the payout", () => {
    expect(EXAMPLE).toMatchObject({
      id: ID,
      source: "SIMULATED",
      network: "testnet",
      contract: "bounty.example.testnet",
      season: "season.example.testnet",
      target: { kind: "live-safe", account: "s0001.season.example.testnet" },
      safe: "1.5",
      bounty: "0.35",
      hours: 4,
      winner: "ORACLE",
      judge: { request: 20417, seconds: 1.183, cost: "0.0011183205" },
      next: { round: 2, safe: "1.5", bounty: "0.35", at: "2026-11-11T18:00:00.000Z" },
    });
    // Only the masks with a move of their own on chain, in the order they first moved. ONYX was entered and is not named.
    expect(EXAMPLE.masks.map((m) => m.name)).toEqual(["ORACLE", "NOVA"]);
    expect(EXAMPLE.sealed.seals.map((s) => [s.mask, s.seq, s.at])).toEqual([
      ["ORACLE", 0, "2026-11-10T18:06:18.950Z"],
      ["NOVA", 1, "2026-11-10T18:21:44.450Z"],
    ]);
    // Only the winner's own calls after the window closed, up to the one that moved the NEAR: NOVA's turn is not in it.
    expect(EXAMPLE.drain.txs.map((t) => t.method)).toEqual(["set_owner", "sweep"]);
    expect(EXAMPLE.drain).toMatchObject({ amount: "1.48", at: "2026-11-10T18:45:23.650Z" });
    expect(EXAMPLE.payout).toMatchObject({ amount: "0.21142", tx: EXAMPLE.sealed.claim.tx });
  });

  it("a record of made-up answers says so in its sources, and never that it was read from testnet", () => {
    expect(answers.simulated).toBe(true);
    expect(EXAMPLE.sources).toHaveLength(1);
    expect(EXAMPLE.sources[0]).toMatch(/^SIMULATED: made-up answers/);
    expect(EXAMPLE.sources.join(" ")).not.toMatch(/NEAR testnet|read through the arena reader at|public indexer/);
  });

  it("made-up answers tell an example round only, and an example is never read as LIVE", async () => {
    await expect(roundFromChain("s1-0001-d74851", readerOn(pretendChain), "SIMULATED")).rejects.toThrow(/made-up answers tell an example round only/);
    await expect(roundFromChain("race-0005", readerOn(pretendChain), "SIMULATED")).rejects.toThrow(/made-up answers tell an example round only/);
    await expect(roundFromChain(ID, readerOn(pretendChain))).rejects.toThrow(/an example round: it is read from made-up answers, never from the chain/);
  });

  it("the made-up answers are what their maker gives, request for request, and the reader asks about the one round", async () => {
    const rec = recordFetch(pretendChain);
    await roundFromChain(ID, readerOn(rec.fetch), "SIMULATED");
    expect(JSON.parse(JSON.stringify(rec.exchanges))).toEqual(answers.exchanges);
    // The round's own state, its own transactions, the judge and the treasury's next round: nothing of any other race.
    expect(rec.exchanges.length).toBeLessThanOrEqual(15);
    const viewed = rec.exchanges.flatMap((e) => {
      const p = (e.request as { params?: Record<string, string> } | null)?.params;
      return p?.method_name ? [`${p.account_id} ${p.method_name}`] : [];
    });
    expect(viewed.sort()).toEqual(
      ["get", "get_round", "get_safe", "judge"].map((m) => `bounty.example.testnet ${m}`).concat(["latest", "next", "season"].map((m) => `season.example.testnet ${m}`)),
    );
  });

  it("reads a round the team opened by hand on the bounty contract: no treasury, its own opening, the season's next round", async () => {
    const r = await played({ hand: true });
    expect(r.season).toBeUndefined();
    expect(r).toMatchObject({ contract: "bounty.example.testnet", target: { account: "safe-0001.example.testnet" }, bounty: "0.35", safe: "3", winner: "ORACLE", drain: { amount: "1.48" } });
    expect(r.opened.at).toBe("2026-11-10T18:00:06.550Z");
    expect(r.next).toEqual({ round: 1, safe: "1.5", bounty: "0.35", at: "2026-11-11T18:00:00.000Z" });
    expect(raceStory(r)).toMatchObject({ kind: "round", opener: "hand", season: null, round: null });
  });

  it("a sealer the cards cannot draw, with a commit the indexer does not show, does not block the winner's record", async () => {
    const r = await played({ stranger: true });
    expect(r.sealed.seals.map((s) => [s.mask, s.seq, s.tx !== undefined])).toEqual([["ORACLE", 0, true], ["KIRA", 1, false], ["NOVA", 2, true]]);
    expect(r.winner).toBe("ORACLE");
    // KIRA has no portrait, so it stands on no card; its seal still counts among the sealed plans.
    expect(r.masks.map((m) => m.name)).toEqual(["ORACLE", "NOVA"]);
    const s = raceStory(r);
    expect(s.kind === "round" && [s.seals, s.sealPlace]).toEqual([3, 1]);
    expect(raceThread(s)[2]!.text).toContain("the first of 3 sealed plans");
    expect(lintThread(raceThread(s))).toEqual([]);
  });

  it("takes the next round from the treasury or not at all: a treasury that is down leaves the record without one", async () => {
    const r = await played({ seasonDown: true });
    expect(r.next).toBeUndefined();
    expect(r.winner).toBe("ORACLE");
    const none = raceCardHtml("next", raceStory(r));
    expect(none).toContain("CONTRACT");
    expect(none.slice(none.indexOf("<body>")).replace(/<[^>]+>/g, "")).not.toMatch(/ROUND \d|UTC/);
    // A next round that is already past when the record is read is not one to announce.
    expect((await played({}, Date.UTC(2026, 10, 11, 18, 0, 1))).next).toBeUndefined();
  });

  it("a chain or an indexer that does not answer is that error, never a round that does not exist", async () => {
    const rpc = await played({ rpcDown: true }).catch((e: unknown) => e);
    expect(rpc).toBeInstanceOf(ChainError);
    expect((rpc as Error).message).toMatch(/HTTP 503/);
    expect((rpc as Error).message).not.toMatch(/makes no record|no season treasury|holds a round/);
    const idx = await played({ indexerDown: true }).catch((e: unknown) => e);
    expect(idx).toBeInstanceOf(IndexerError);
    expect((idx as Error).message).not.toMatch(/makes no record/);
  });

  it("refuses a round that has not paid, in one line that says where it stands", async () => {
    const open = answering("get", (b) => ({ ...b, status: { state: "open" } }));
    await expect(roundFromChain(ID, readerOn(replayFetch(open)), "SIMULATED")).rejects.toThrow(
      /^round example-0000 makes no record: ORACLE drained the vault and the contract has not paid yet \(the bounty is open\)$/,
    );
    // Nobody moved: while the round runs it is open, after its deadline the vault held.
    await expect(played({ idle: true })).rejects.toThrow(
      /makes no record: it is open until 2026-11-10T22:00:06.550Z: no mask sealed a plan, nobody has drained the vault, the 0.22117 NEAR bounty is on the contract$/,
    );
    await expect(played({ idle: true }, Date.UTC(2026, 10, 11))).rejects.toThrow(
      /makes no record: the vault held: no mask sealed a plan, nobody drained it by 2026-11-10T22:00:06.550Z, and the 0.22117 NEAR bounty is still on the contract$/,
    );
  });

  it("refuses an id no contract holds and an id that is no round, each by name", async () => {
    await expect(roundFromChain("s1-0002-abcdef", readerOn(pretendChain))).rejects.toThrow(/makes no record: no bounty contract of the arena holds a round with this id/);
    await expect(roundFromChain("race-0099", readerOn(pretendChain))).rejects.toThrow(/no bounty contract of the arena holds/);
    await expect(roundFromChain("round-1", readerOn(pretendChain))).rejects.toThrow(/not a round id/);
  });

  it("reads the judge's run from OutLayer's own events, on the claim testnet recorded for race-0003", () => {
    const raw = testnet.exchanges
      .filter((e) => e.url.endsWith("/v0/transactions"))
      .flatMap((e) => (e.response as { transactions: unknown[] }).transactions)
      .map(parseTx)
      .filter((t): t is Tx => t !== null);
    const claim = raw.find((t) => t.hash === race3().payout.tx)!;
    expect(judgeRun(claim)).toEqual({ request: 11162, seconds: 1.095, cost: "0.0011095005" });
    // The same request the hand-written record names; a transaction with no judge in it gives none.
    expect(judgeRun(claim)!.request).toBe(race3().judge.request);
    expect(judgeRun(raw.find((t) => t.hash === race3().drain.txs[1].hash)!)).toBeNull();
  });

  it("the script writes the same record from recorded answers, marked SIMULATED by the answers themselves, and keeps a real id off them", () => {
    const dir = mkdtempSync(join(tmpdir(), "maskwars-round-"));
    const script = join(here, "../scripts/round.mjs");
    const fixture = join(here, "fixtures/example-round.json");
    try {
      const out = join(dir, "round.json");
      const said = execFileSync(process.execPath, [script, ID, "--replay", fixture, "--out", out], { encoding: "utf8" });
      expect(said).toContain(`${ID} on testnet, SIMULATED: ORACLE drained 1.48 NEAR and was paid 0.21142 NEAR`);
      expect(said).toContain("judged   request 20417, 1.183 s, 0.0011183205 NEAR");
      expect(said).toContain("drained  2026-11-10T18:45:23.650Z  1.48 NEAR in 1 transaction: set_owner → sweep 1.48");
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(example());
      const real = spawnSync(process.execPath, [script, "s1-0001-d74851", "--replay", fixture, "--out", join(dir, "real.json")], { encoding: "utf8" });
      expect(real.status).toBe(1);
      expect(real.stderr.trim()).toBe("made-up answers tell an example round only (example-0000), not s1-0001-d74851");
      expect(existsSync(join(dir, "real.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("was read at the fixture's own moment", () => {
    expect(answers.recordedAt).toBe(READ_AT);
  });
});
