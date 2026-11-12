// The encyclopedia on NEAR mainnet as it answered on 11.11.2026 after the daily round (test/fixtures/mainnet.json,
// `pnpm record`): race-0001 on safe-0001.maskwars.near, the team's round of 10.11, and race-0002 on the house's vault,
// the first daily round. Both pages in test/fixtures/written were written by DeepSeek V4.1 Flash in a Confidential TEE
// on NEAR AI Cloud from exactly these facts (`pnpm write`); they are checked here as a partner would check them.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Dossier = import("../src/index.ts").Dossier;
type Pkg = typeof import("../src/index.ts");

const SAFE = "safe-0001.maskwars.near";
const VAULT = "vault.house.maskwars.near";
const ORACLE = "oracle.maskwars.near";

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

let pkg: Pkg;
let safe: Dossier;
let vault: Dossier;
let view: import("@maskwars/arena").ArenaView;
let recordedAt: number;

beforeAll(async () => {
  vi.stubEnv("MASKWARS_NETWORK", "mainnet");
  vi.resetModules();
  const arena = await import("@maskwars/arena");
  const { replayFetch } = await import("@maskwars/arena/replay");
  const { ChainReader } = await import("@maskwars/check");
  pkg = await import("../src/index.ts");
  const recording = json("./fixtures/mainnet.json");
  const fetch = replayFetch(recording);
  view = await new arena.Arena({ rpc: new ChainReader({ endpoints: arena.RPCS, fetch }), indexer: new arena.Indexer({ fetch }), now: () => recording.recordedAt }).view();
  recordedAt = recording.recordedAt;
  safe = pkg.collect({ account: SAFE, view, check: null, now: recording.recordedAt });
  vault = pkg.collect({ account: VAULT, view, check: null, now: recording.recordedAt });
// The first import of the arena and the check on a busy machine takes longer than the default 10 s.
}, 60_000);

afterAll(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("safe-0001.maskwars.near, the team's round of 10.11", () => {
  it("stands broken by ORACLE, with what it took in all and how fast", () => {
    expect(safe).toMatchObject({ network: "mainnet", role: "safe", incomplete: false });
    expect(safe.headline).toMatchObject({ standing: "broken", amountIs: "taken", amount: "751860000000000000000000", races: 1, masks: 3 });
    expect(safe.headline.broken).toMatchObject({ race: "race-0001", breakMs: 15_847, confirmed: true });
    expect(safe.headline.broken?.by?.account).toBe(ORACLE);
    expect(safe.code).toBe("7u1QBYjTPhXZhFHzJ4qdhuJdB33y3GfLEiXHAZFrbdZx");
    expect(safe.library?.id).toBe("live-safe");
  });

  it("writes every step as a fact with its mainnet transaction", () => {
    const drain = safe.evidence.find((e) => e.kind === "drain")!;
    expect(drain.tx).toBe("CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM");
    expect(drain.href).toBe("https://nearblocks.io/txns/CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM");
    const paid = safe.evidence.find((e) => e.kind === "paid")!;
    expect(paid.tx).toBe("9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM");
    expect(safe.evidence.find((e) => e.kind === "arena")!.fact).toMatch(/on NEAR mainnet runs its races on the bounty contracts bounty\.maskwars\.near/);
    // Every step a mask or the team made has its own transaction.
    for (const e of safe.evidence.filter((x) => !["arena", "library", "code", "race"].includes(x.kind))) expect(e.tx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it("answers the partners' question for race-0001 with the payout as proof", () => {
    expect(pkg.outcomesOf(safe)).toEqual([
      {
        race: "race-0001",
        contract: "bounty.maskwars.near",
        question: `Did the judge in a TEE confirm that a mask broke ${SAFE} in race-0001?`,
        answer: "yes",
        final: true,
        verdict: "broken",
        drainedOnChain: true,
        winner: ORACLE,
        proof: {
          tx: "9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM",
          url: "https://nearblocks.io/txns/9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM",
          judgeCode: "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7",
          at: "2026-11-10T16:00:10.484Z",
        },
      },
    ]);
  });
});

describe("the oracle's answer, once final, never changes", () => {
  // The vault's round as a bounty that went back with nothing drained, its refund's own transaction not read (the
  // indexer's history cut short): whether it held or was called off is not known, the answer is.
  const refunded = () => {
    const r = view.races.find((x) => x.id === "race-0002")!;
    const events = r.events.filter((e) => e.kind !== "drain" && e.kind !== "move" && e.kind !== "claim" && e.kind !== "paid");
    const race = { ...r, phase: "held" as const, state: "refunded" as const, winner: null, payout: null, loot: null, takes: null, breakMs: null, brokeAt: null, refund: { amount: r.bounty, at: null, tx: null }, events, txs: { ...r.txs, drain: null, payout: null } };
    return { ...view, races: view.races.map((x) => (x.id === r.id ? race : x)) } as typeof view;
  };

  it("is final and no from the contract's state alone, before and after the deadline", () => {
    const r = view.races.find((x) => x.id === "race-0002")!;
    for (const now of [r.deadline - 60_000, r.deadline + 86_400_000]) {
      const [o] = pkg.outcomesOf(pkg.collect({ account: VAULT, view: refunded(), check: null, now }));
      expect(o).toMatchObject({ race: "race-0002", final: true, answer: "no", drainedOnChain: false });
    }
    // The finer word rests on the refund's time: called off before the deadline, not known after it.
    expect(pkg.outcomesOf(pkg.collect({ account: VAULT, view: refunded(), check: null, now: r.deadline - 60_000 }))[0]!.verdict).toBe("called_off");
    expect(pkg.outcomesOf(pkg.collect({ account: VAULT, view: refunded(), check: null, now: r.deadline + 86_400_000 }))[0]!.verdict).toBe("pending");
  });

  it("is not final while the contract has not settled", () => {
    const open = { ...view, races: view.races.map((x) => (x.id === "race-0002" ? { ...x, state: "open" as const, phase: "racing" as const, winner: null, payout: null, events: x.events.filter((e) => e.kind === "open" || e.kind === "fund") } : x)) } as typeof view;
    expect(pkg.outcomesOf(pkg.collect({ account: VAULT, view: open, check: null, now: recordedAt }))[0]).toMatchObject({ final: false, answer: null });
  });
});

describe("vault.house.maskwars.near, the house's daily round", () => {
  it("counts the house's round, and names the vault as the house's own", () => {
    expect(vault).toMatchObject({ network: "mainnet", role: "safe", incomplete: false });
    expect(vault.races.map((r) => [r.id, r.team])).toEqual([["race-0002", "house.maskwars.near"]]);
    expect(vault.headline).toMatchObject({ standing: "broken", amount: "351760000000000000000000", races: 1 });
    expect(vault.headline.broken?.by?.account).toBe(ORACLE);
    expect(vault.code).toBe("GBcgJ4RABNHWXb86XHK6aFeEk6qMtSNFhS3ka8NyK7jV");
    const house = vault.evidence.find((e) => e.kind === "library")!;
    expect(house.fact).toMatch(/^vault\.house\.maskwars\.near is the vault of the house house\.maskwars\.near, which opened a race on it: a live safe/);
    // A model may quote a fact word for word: no fact of ours writes a number in words for the gate to refuse.
    for (const e of [...vault.evidence, ...safe.evidence]) expect(pkg.numberWord(e.fact), e.fact).toBeNull();
    expect(house.href).toBe("https://nearblocks.io/address/house.maskwars.near");
    expect(vault.library?.id).toBe("live-safe");
  });

  it("is a record a page may be written from", () => {
    expect(pkg.writable(vault, { teams: pkg.ARENA_TEAMS })).toBe(true);
    expect(pkg.ARENA_TEAMS).toEqual(["maskwars.near", "season.maskwars.near", "house.maskwars.near"]);
  });

  it("is no house vault when the house never raced on it", () => {
    const stranger = pkg.collect({ account: VAULT, view: null, check: null, now: 0, house: { account: "house.maskwars.near", vault: VAULT, target: "live-safe" } });
    expect(stranger.library).toBeNull();
    expect(stranger.evidence).toEqual([]);
  });
});

describe("the pages NEAR AI wrote in a TEE from these facts", () => {
  for (const [account, which] of [
    [SAFE, () => safe],
    [VAULT, () => vault],
  ] as const) {
    it(`${account}: holds as a partner checks it, and belongs to exactly these facts`, () => {
      const written = json(`./fixtures/written/${account}.page.json`);
      const page = pkg.readWritten(written, { account, evidenceHash: which().evidenceHash });
      expect(page).not.toBeNull();
      expect(page!.model).toBe("deepseek-ai/DeepSeek-V4.1-Flash-1017");
      expect(page!.attestation.signatureVerified).toBe(true);
      expect(page!.attestation.tee?.outcome).toBe("pass");
      expect(JSON.parse(page!.attestation.request!).chat_template_kwargs).toEqual({ thinking: false });
      expect(pkg.verifyWritten(page!)).toEqual({ ok: true, problems: [] });
      // Every number on the page is a slot the code fills from a fact the sentence cites.
      const text = [page!.page.lede, ...page!.page.sections.flatMap((s) => s.claims)].map((c) => pkg.renderClaim(c, page!.evidence)).join(" ");
      expect(text).toMatch(/ORACLE/);
      const reply = JSON.parse(page!.attestation.response!).choices[0].message.content as string;
      expect(pkg.checkPage(reply, which().evidence).ok).toBe(true);
    });

    it(`${account}: a page with one fact changed, or another signer, is refused`, () => {
      const written = json(`./fixtures/written/${account}.page.json`);
      const changed = structuredClone(written);
      const step = changed.evidence.find((e: { kind: string }) => e.kind === "drain");
      step.data.amount_near = "5";
      expect(pkg.readWritten(changed)).toBeNull();
      expect(pkg.readWritten(written, { account, evidenceHash: which().evidenceHash }, { signers: new Set(["0x0000000000000000000000000000000000000001"]) })).toBeNull();
    });
  }
});
