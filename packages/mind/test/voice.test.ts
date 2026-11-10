import { describe, expect, it } from "vitest";
import { MemoryJournal } from "../src/journal.ts";
import { LineMemory, loadAllBooks, readBook } from "../src/lines.ts";
import { FakeProvider } from "../src/provider.ts";
import { Voice, acceptTailored } from "../src/voice.ts";

const books = loadAllBooks();
const seeded = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
  return seed / 2 ** 31;
};

describe("picking lines", () => {
  it("never repeats a line within the last 20 fights while the pool allows", () => {
    // ONYX has 10 pre_fight lines plus 6 rivalry lines for NOVA: 16 fresh lines for 16 fights.
    const voice = new Voice({ memory: new LineMemory(20), lines: books, rng: seeded(7) });
    const said: string[] = [];
    for (let f = 1; f <= 16; f++) said.push(voice.say(`f-0-${f}`, "onyx", "pre_fight", { rival: "NOVA" })!.line.id);
    expect(new Set(said).size).toBe(16);
  });

  it("when a tag runs dry, the line said longest ago comes back first", () => {
    const { lines } = readBook("onyx", { hold: ["A.", "B.", "C."] });
    const voice = new Voice({ memory: new LineMemory(20), lines, rng: seeded(1) });
    const order = [1, 2, 3].map((f) => voice.say(`f-${f}`, "onyx", "hold", {})!.text);
    expect(new Set(order).size).toBe(3);
    expect(voice.say("f-4", "onyx", "hold", {})!.text).toBe(order[0]);
    expect(voice.say("f-5", "onyx", "hold", {})!.text).toBe(order[1]);
  });

  it("forgets after 20 fights", () => {
    const memory = new LineMemory(20);
    for (let f = 0; f < 25; f++) memory.remember("onyx", `f-${f}`, `line-${f}`);
    const recent = memory.recent("onyx");
    expect(recent.size).toBe(20);
    expect(recent.has("line-4")).toBe(false);
    expect(recent.has("line-5")).toBe(true);
  });

  it("memory survives a restart", () => {
    const memory = new LineMemory(20);
    memory.remember("nova", "f-1", "a");
    memory.remember("nova", "f-2", "b");
    const back = LineMemory.fromJSON(JSON.parse(JSON.stringify(memory.toJSON())));
    expect([...back.recent("nova")].sort()).toEqual(["a", "b"]);
    expect(back.lastSaid("b")).toBeGreaterThan(back.lastSaid("a"));
  });

  it("skips lines whose slots the facts cannot fill", () => {
    const voice = new Voice({ memory: new LineMemory(), lines: books, rng: seeded(3) });
    for (let i = 0; i < 30; i++) {
      const s = voice.say(`f-${i}`, "volt", "thank_backer", { backer: "kai" });
      expect(s!.text).not.toMatch(/[{}]/);
    }
  });

  it("cleans backer names before they reach the screen", () => {
    const voice = new Voice({ memory: new LineMemory(), lines: books, rng: seeded(5) });
    const s = voice.say("f-1", "ronin", "thank_backer", { backer: "<img src=x>@sh\u200Bark", amount: "$5" })!;
    expect(s.text).not.toMatch(/[<>@\u200B]/);
  });
});

describe("tailoring never holds the voice", () => {
  it("returns the written line at once, then the tailored one", async () => {
    const fake = new FakeProvider(["Up 340. Same chair, {rival} never stood."], "");
    const journal = new MemoryJournal();
    const { lines } = readBook("onyx", { take_lead: ["Up {points}. Same chair."] });
    const voice = new Voice({
      memory: new LineMemory(),
      lines,
      polish: { provider: fake, model: "z-ai/glm-5.3-flash", journal },
    });
    const s = voice.say("f-1", "onyx", "take_lead", { points: "340", rival: "NOVA" })!;
    expect(s.text).toBe("Up 340. Same chair.");
    // The candidate kept a raw slot, so it is refused and the written line stands.
    expect(await s.polished).toBe("Up 340. Same chair.");
    expect(journal.entries[0]).toMatchObject({ kind: "line", source: "default", reason: "unfilled slot" });
  });

  it("a slow model is ignored", async () => {
    const fake = new FakeProvider([{ delayMs: 2_000, text: "Up 340. Still sitting." }]);
    const { lines } = readBook("onyx", { take_lead: ["Up {points}. Same chair."] });
    const voice = new Voice({
      memory: new LineMemory(),
      lines,
      polish: { provider: fake, model: "z-ai/glm-5.3-flash", journal: new MemoryJournal(), timeoutMs: 40 },
    });
    const started = Date.now();
    const s = voice.say("f-1", "onyx", "take_lead", { points: "340" })!;
    expect(await s.polished).toBe("Up 340. Same chair.");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("a good tailoring is taken", async () => {
    const fake = new FakeProvider(["Up 340 on ZEC. Same chair."]);
    const { lines } = readBook("onyx", { take_lead: ["Up {points}. Same chair."] });
    const voice = new Voice({
      memory: new LineMemory(),
      lines,
      polish: { provider: fake, model: "z-ai/glm-5.3-flash", journal: new MemoryJournal() },
    });
    const s = voice.say("f-1", "onyx", "take_lead", { points: "340", coin: "ZEC" })!;
    expect(await s.polished).toBe("Up 340 on ZEC. Same chair.");
  });
});

describe("acceptTailored", () => {
  const ok = (c: string, facts = {}) => acceptTailored("Up 340. Same chair.", c, { points: "340", ...facts }, 90);
  it("refuses new numbers, banned words, dropped facts, long or multi-line output", () => {
    expect(ok("Up 9000. Same chair.").ok).toBe(false);
    expect(ok("As an AI, I am up 340.").ok).toBe(false);
    expect(ok("Same chair. Up big.").ok).toBe(false);
    expect(ok(`Up 340. ${"x".repeat(100)}`).ok).toBe(false);
    expect(ok("Up 340.\nSame chair.").ok).toBe(false);
    expect(ok("Up 340! Same chair.").ok).toBe(false);
    expect(ok("Up 340. Not luck, but patience.").ok).toBe(false);
    expect(ok("Up 340. It's not luck, it's the chair.").ok).toBe(false);
    expect(ok("Up 340. Luck isn't real. It's the chair.").ok).toBe(false);
  });
  it("accepts a light edit and strips quotes", () => {
    expect(ok('"Up 340. Same old chair."')).toEqual({ ok: true, text: "Up 340. Same old chair." });
  });
});
