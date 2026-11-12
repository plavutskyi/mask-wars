import { describe, expect, it } from "vitest";
import {
  mergeRecords,
  nearToUsd,
  parseMindRecord,
  priceState,
  priceText,
  pricedByText,
  raceThought,
  seasonThought,
  timesOf,
  timesText,
  usdText,
  yoctoOf,
  type MindRecord,
} from "../src/minds.ts";
import type { MaskStats, Who } from "../src/types.ts";

const NOVA = "nova.maskwars.near";
const ONYX = "onyx.maskwars.near";

const record = (over: Partial<MindRecord> = {}): MindRecord => ({
  v: 1,
  network: "mainnet",
  race: "race-0003",
  at: 1_794_500_000_000,
  near: { usd: 3.7, at: "2026-11-12T18:20:00Z" },
  masks: [
    { account: NOVA, name: "NOVA", model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", answers: 2, billed: 2, unanswered: 0, tokens: { prompt: 32_756, completion: 20_000, cached: 16_300 }, usd: 0.02 },
    { account: ONYX, name: "ONYX", model: "z-ai/glm-5.3-flash", answers: 3, billed: 2, unanswered: 1, tokens: { prompt: 49_000, completion: 30_000, cached: 0 }, usd: 0.019 },
  ],
  ...over,
});

const who = (account: string, name: string): Who => ({ account, slug: name.toLowerCase(), name, mask: true, model: null });

describe("parseMindRecord", () => {
  it("takes a record as the race job writes it, with the run that raced it", () => {
    const r = { ...record(), run: "https://github.com/plavutskyi/mask-wars/actions/runs/123" };
    expect(parseMindRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
    expect(parseMindRecord({ ...record(), near: null })?.near).toBeNull();
  });

  it("refuses anything a record does not hold", () => {
    const bad: unknown[] = [
      null,
      { ...record(), v: 2 },
      { ...record(), network: "devnet" },
      { ...record(), race: "../race-0003" },
      { ...record(), near: { usd: -1, at: null } },
      { ...record(), run: "https://evil.example/actions/runs/1" },
      { ...record(), masks: [{ ...record().masks[0]!, usd: Number.NaN }] },
      { ...record(), masks: [{ ...record().masks[0]!, usd: 5_000 }] },
      { ...record(), masks: [{ ...record().masks[0]!, billed: 3 }] },
      { ...record(), masks: [{ ...record().masks[0]!, unanswered: -1 }] },
      { ...record(), masks: [{ ...record().masks[0]!, unanswered: undefined }] },
      { ...record(), masks: [{ ...record().masks[0]!, name: "nova" }] },
      { ...record(), masks: [{ ...record().masks[0]!, account: "Not An Account" }] },
      { ...record(), masks: [{ ...record().masks[0]!, tokens: { prompt: 10, completion: 1, cached: 11 } }] },
      { ...record(), masks: [record().masks[0]!, record().masks[0]!] },
    ];
    for (const b of bad) expect(parseMindRecord(b)).toBeNull();
  });
});

describe("the price of thinking", () => {
  it("reads dollars from yoctoNEAR at the race's price", () => {
    expect(nearToUsd(yoctoOf(0.35), 3.7)).toBeCloseTo(1.295, 9);
    expect(nearToUsd("0", 3.7)).toBe(0);
    expect(timesOf(1.295, 0)).toBeNull();
    expect(timesOf(null, 0.02)).toBeNull();
  });

  it("gives the winner its × on its own mind, and the whole race's minds", () => {
    const t = raceThought({ id: "race-0003", phase: "broken", winner: who(NOVA, "NOVA"), takes: yoctoOf(0.35) }, record());
    expect(t?.usd).toBeCloseTo(0.039, 9);
    expect(t?.answers).toBe(5);
    expect(t?.winner?.spend.name).toBe("NOVA");
    expect(t?.winner?.earnedUsd).toBeCloseTo(1.295, 9);
    expect(t?.winner?.x).toBeCloseTo(64.75, 6);
  });

  it("names no winner in a race nobody won, and nothing for another race's record", () => {
    expect(raceThought({ id: "race-0003", phase: "held", winner: null, takes: null }, record())?.winner).toBeNull();
    expect(raceThought({ id: "race-0004", phase: "held", winner: null, takes: null }, record())).toBeNull();
    expect(raceThought({ id: "race-0003", phase: "held", winner: null, takes: null }, undefined)).toBeNull();
  });

  it("has no × without NEAR's price", () => {
    const t = raceThought({ id: "race-0003", phase: "broken", winner: who(NOVA, "NOVA"), takes: yoctoOf(0.35) }, record({ near: null }));
    expect(t?.winner?.earnedUsd).toBeNull();
    expect(t?.winner?.x).toBeNull();
  });

  it("adds a mask's season up over the races with a record only", () => {
    const stats: Pick<MaskStats, "who" | "history"> = {
      who: who(NOVA, "NOVA"),
      history: [
        { id: "race-0004", at: 2, phase: "held", won: false, takes: null, breakMs: null, target: "vault", targetCode: null },
        { id: "race-0003", at: 1, phase: "broken", won: true, takes: yoctoOf(0.35), breakMs: 60_000, target: "vault", targetCode: null },
        // Raced before the records began: neither its NEAR nor its mind count.
        { id: "race-0001", at: 0, phase: "broken", won: true, takes: yoctoOf(0.5), breakMs: 60_000, target: "vault", targetCode: null },
      ],
    };
    const r4 = record({ race: "race-0004", near: { usd: 3.5, at: null }, masks: [{ ...record().masks[0]!, usd: 0.01, model: "Qwen/Qwen3.8-27B-abliterated" }] });
    const s = seasonThought(stats, new Map([["race-0003", record()], ["race-0004", r4]]));
    expect(s).toMatchObject({ races: 2, answers: 4, earned: yoctoOf(0.35), models: ["Qwen/Qwen3.8-27B-abliterated", "deepseek-ai/DeepSeek-V4.1-Flash-1017"] });
    expect(s?.usd).toBeCloseTo(0.03, 9);
    expect(s?.x).toBeCloseTo(1.295 / 0.03, 6);
    expect(seasonThought(stats, new Map())).toBeNull();
  });

  it("shows no × on a price NEAR AI's bill did not give whole: calls left out, or answers priced from their tokens", () => {
    const won = (masks: MindRecord["masks"]) => raceThought({ id: "race-0003", phase: "broken", winner: who(ONYX, "ONYX"), takes: yoctoOf(0.35) }, record({ masks }))!;
    // ONYX: 2 of 3 answers on the bill and a call that brought nothing back.
    const partial = won(record().masks);
    expect(partial.winner).toMatchObject({ state: "partial", x: null });
    expect(partial.winner?.earnedUsd).toBeCloseTo(1.295, 9);
    expect(partial.state).toBe("partial");
    // Every call came back, one answer priced from its tokens.
    const listed = won([{ ...record().masks[1]!, unanswered: 0 }]);
    expect(listed.winner).toMatchObject({ state: "listed", x: null });
    // All on the bill: the ×.
    const billed = won([{ ...record().masks[1]!, billed: 3, unanswered: 0 }]);
    expect(billed.winner?.state).toBe("billed");
    expect(billed.winner?.x).toBeCloseTo(1.295 / 0.019, 6);
    expect(priceState({ answers: 0, billed: 0, unanswered: 0 })).toBe("billed");
  });

  it("says how each price was found, from the counts alone", () => {
    expect(priceText(0.019, "billed")).toBe("$0.019");
    expect(priceText(0.019, "listed")).toBe("≈$0.019");
    expect(priceText(0.019, "partial")).toBe("≥$0.019");
    expect(pricedByText({ answers: 4, billed: 4, unanswered: 0 })).toBe("NEAR AI's bill for each answer");
    expect(pricedByText({ answers: 1, billed: 1, unanswered: 0 })).toBe("NEAR AI's bill for the answer");
    expect(pricedByText({ answers: 4, billed: 3, unanswered: 0 })).toBe("NEAR AI's bill for 3 of 4 answers, 1 from tokens at NEAR AI's list price");
    expect(pricedByText({ answers: 2, billed: 0, unanswered: 0 })).toBe("2 answers from tokens at NEAR AI's list price");
    expect(pricedByText({ answers: 5, billed: 5, unanswered: 2 })).toBe("NEAR AI's bill for each answer; 2 calls with nothing back, not in the price");
    expect(pricedByText({ answers: 0, billed: 0, unanswered: 1 })).toBe("1 call with nothing back, not in the price");
    expect(pricedByText({ answers: 0, billed: 0, unanswered: 0 })).toBe("No answers");
    const t = raceThought({ id: "race-0003", phase: "held", winner: null, takes: null }, record())!;
    expect(t.counts).toEqual({ answers: 5, billed: 4, unanswered: 1, verified: null });
  });

  it("keeps how many answers had their TEE signature checked, and claims it for no record that does not say", () => {
    const checked = record({ masks: [{ ...record().masks[0]!, verified: 2 }, { ...record().masks[1]!, verified: 1 }] });
    expect(parseMindRecord(JSON.parse(JSON.stringify(checked)))).toEqual(checked);
    expect(parseMindRecord({ ...record(), masks: [{ ...record().masks[0]!, verified: 3 }] })).toBeNull();
    expect(parseMindRecord({ ...record(), masks: [{ ...record().masks[0]!, verified: -1 }] })).toBeNull();
    expect(raceThought({ id: "race-0003", phase: "held", winner: null, takes: null }, checked)?.counts.verified).toBe(3);
    // A run from before the check adds answers, not verified ones.
    const m = mergeRecords([checked, record({ at: record().at + 1 })]);
    expect(m?.masks.find((x) => x.account === NOVA)).toMatchObject({ answers: 4, verified: 2 });
    expect(mergeRecords([record(), record({ at: record().at + 1 })])?.masks[0]).not.toHaveProperty("verified");
  });

  it("has no season × while any of its races is not wholly on the bill", () => {
    const stats: Pick<MaskStats, "who" | "history"> = {
      who: who(ONYX, "ONYX"),
      history: [{ id: "race-0003", at: 1, phase: "broken", won: true, takes: yoctoOf(0.35), breakMs: 60_000, target: "vault", targetCode: null }],
    };
    const s = seasonThought(stats, new Map([["race-0003", record()]]));
    expect(s).toMatchObject({ state: "partial", x: null, counts: { answers: 3, billed: 2, unanswered: 1 } });
    expect(s?.earnedUsd).toBeCloseTo(1.295, 9);
  });

  it("adds up the runs of one round", () => {
    const later = record({ at: record().at + 60_000, near: { usd: 9, at: null }, masks: [{ ...record().masks[0]!, answers: 1, billed: 1, unanswered: 2, usd: 0.005, model: "x/other" }] });
    const m = mergeRecords([later, record()]);
    expect(m?.near?.usd).toBe(3.7);
    const nova = m?.masks.find((x) => x.account === NOVA);
    expect(nova).toMatchObject({ answers: 3, billed: 3, unanswered: 2, model: "deepseek-ai/DeepSeek-V4.1-Flash-1017, x/other" });
    expect(nova?.usd).toBeCloseTo(0.025, 9);
    expect(m?.masks.find((x) => x.account === ONYX)?.answers).toBe(3);
    expect(mergeRecords([])).toBeNull();
    expect(mergeRecords([record(), record({ race: "race-0009", at: record().at + 1 })])?.masks.find((x) => x.account === NOVA)?.answers).toBe(2);
  });
});

describe("how it reads", () => {
  it("shows dollars never rounded up", () => {
    expect(usdText(0.0199)).toBe("$0.019");
    expect(usdText(0.02)).toBe("$0.02");
    expect(usdText(0.00429)).toBe("$0.0042");
    expect(usdText(1.299)).toBe("$1.29");
    expect(usdText(1234.5)).toBe("$1,234.50");
    expect(usdText(0.00001)).toBe("<$0.0001");
    expect(usdText(0)).toBe("$0");
  });

  it("shows the × never rounded up", () => {
    expect(timesText(64.75)).toBe("×64");
    expect(timesText(1240.2)).toBe("×1,240");
    expect(timesText(3.47)).toBe("×3.4");
    expect(timesText(0.428)).toBe("×0.42");
    expect(timesText(null)).toBe("×—");
  });
});
