import { describe, expect, it } from "vitest";
import { BASE_TAGS, fill, loadBook, maxCharsFor, readBook, tagsFor, worstLength } from "../src/lines.ts";
import { MASKS } from "../src/masks.ts";
import { BANNED, NOT_BUT } from "../src/voice.ts";

describe.each(MASKS)("voice book %s", (mask) => {
  const lines = loadBook(mask);

  it("has at least 150 hand-written lines", () => {
    expect(lines.length).toBeGreaterThanOrEqual(150);
  });

  it("covers every event and every rival", () => {
    const tags = new Set(lines.map((l) => l.tag));
    for (const tag of tagsFor(mask)) expect(tags, tag).toContain(tag);
    expect(tagsFor(mask).filter((t) => t.startsWith("rivalry:"))).toHaveLength(5);
  });

  it("every line fits on screen with its slots at their widest", () => {
    for (const l of lines) expect(worstLength(l.text), l.text).toBeLessThanOrEqual(maxCharsFor(l.tag));
  });

  it("no AI tells, no unmasking words, no exclamation, no dash parallelism", () => {
    for (const l of lines) {
      expect(BANNED.test(l.text), l.text).toBe(false);
      expect(NOT_BUT.test(l.text), l.text).toBe(false);
    }
  });

  it("no promises of profit", () => {
    for (const l of lines) expect(l.text, l.text).not.toMatch(/\b(?:you will|you'll|guaranteed?|sure thing|risk[- ]free)\b.*\b(?:win|profit|earn|rich)\b/i);
  });

  it("a rivalry line names that rival", () => {
    for (const l of lines.filter((x) => x.tag.startsWith("rivalry:"))) {
      expect(l.text, l.text).toContain(l.tag.slice("rivalry:".length).toUpperCase());
    }
  });

  it("thank and taunt lines speak to a backer by name", () => {
    for (const l of lines.filter((x) => x.tag === "thank_backer" || x.tag === "taunt_backer")) {
      expect(l.slots, l.text).toContain("backer");
    }
  });
});

describe("book format", () => {
  it("reports unknown tags, unknown slots, duplicates and long lines", () => {
    const { problems } = readBook("onyx", {
      pre_fight: ["Hi {nobody}.", "Same.", "same."],
      "rivalry:onyx": ["Talking to myself."],
      win: ["x".repeat(91)],
    });
    expect(problems.map((p) => p.problem).sort()).toEqual(["duplicate", "too long", "unknown slot nobody", "unknown tag"]);
  });

  it("ids survive reordering", () => {
    const a = readBook("onyx", { win: ["One.", "Two."] }).lines;
    const b = readBook("onyx", { win: ["Two.", "One."] }).lines;
    expect(a.find((l) => l.text === "One.")!.id).toBe(b.find((l) => l.text === "One.")!.id);
  });

  it("fills slots and clips long names", () => {
    expect(fill("{backer}, {amount} on {coin}.", { backer: "averyveryverylongname", amount: "$5", coin: "NEAR" })).toBe(
      "averyveryver, $5 on NEAR.",
    );
    expect(fill("{rival} again.", {})).toBe("{rival} again.");
  });

  it("base tags are the brief's list", () => {
    expect(BASE_TAGS).toHaveLength(17);
  });
});

describe("voices are told apart", () => {
  it("no line is shared between two masks", () => {
    const seen = new Map<string, string>();
    for (const mask of MASKS) {
      for (const l of loadBook(mask)) {
        const key = l.text.toLowerCase();
        expect(seen.get(key), `${mask}: ${l.text}`).toBeUndefined();
        seen.set(key, mask);
      }
    }
  });

  it("each mask has its own vocabulary", () => {
    const marks: Record<(typeof MASKS)[number], RegExp> = {
      onyx: /\b(wait|floor|sit|dip|slow|cold|ash|fire|patien|calm|still|ember|stone|sleep|wake|blood|bleed|fell|fall|chase)\w*/i,
      nova: /\b(fast|speed|run|green|lane|go|gone|pass|race|engine|gas|ride)\w*/i,
      oracle: /\b(written|scroll|door|eye|fate|prophe|foretold|riddle|future|old coin|seams?)\w*/i,
      wraith: /\b(crowd|favorite|behind|cold|ghost|haunt|shh|chill|boo|warm)\w*/i,
      ronin: /\b(blade|steel|cut|kneel|honou?r|dishonou?r|coward|loyal|sword|weak)\w*/i,
      volt: /\b(switch|swap|rotat|okay|honestly|commit|ex|date|zap|spark|plug|lime|chaos)\w*/i,
    };
    for (const mask of MASKS) {
      const lines = loadBook(mask);
      const own = lines.filter((l) => marks[mask].test(l.text)).length / lines.length;
      expect(own, mask).toBeGreaterThan(0.25);
    }
  });
});
