import { describe, expect, it } from "vitest";
import { cardHtml, CARD_H, CARD_SCALE, CARD_W } from "../src/cards/html.ts";
import { cardRenderer } from "../src/cards/render.ts";
import type { MediaJob } from "../src/index.ts";
import { fromFightEvent, parseEvent } from "../src/index.ts";
import { examples, live } from "./helpers.ts";

const ex = examples();
type CardJob = Extract<MediaJob, { kind: "card" }>;
const cards = (): CardJob[] => Object.values(ex).flatMap((e) => fromFightEvent(e).filter((j): j is CardJob => j.kind === "card"));

describe("cards", () => {
  it("one format: 16:9, laid out at 1200×675 and shot at ×4/3, so 1600×900 as the brandbook says", () => {
    expect([CARD_W, CARD_H]).toEqual([1200, 675]);
    expect([CARD_W * CARD_SCALE, CARD_H * CARD_SCALE]).toEqual([1600, 900]);
  });

  it("five card types come out of the examples", () => {
    expect(cards().map((c) => c.card).sort()).toEqual(["birth", "lose", "seal", "unmask", "win"]);
  });

  it("a win card under ×3 cannot be drawn", () => {
    expect(() => cardHtml("win", parseEvent(ex.win_card_small))).toThrow(/×3/);
  });

  it("no small print: no ids, handles' addresses or text under 30 px, and no SIMULATED band on real numbers", () => {
    for (const c of cards()) {
      const html = cardHtml(c.card, live(c.event));
      expect(html).not.toMatch(/f-s0-\d+/);
      expect(html).not.toContain("SIMULATED");
      const body = html.slice(html.indexOf("</style>"));
      for (const m of body.matchAll(/font-size:(\d+)px/g)) expect(Number(m[1]), c.card).toBeGreaterThanOrEqual(30);
    }
  });

  it("SIMULATED numbers carry the band across the whole card, never a stamp in a corner", () => {
    for (const c of cards()) {
      const html = cardHtml(c.card, c.event);
      expect(html, c.card).toContain('class="sim-band"');
      expect(html, c.card).toContain(">SIMULATED · NOT A REAL RESULT</div>");
      const band = /class="sim-band" style="([^"]+)"/.exec(html)![1]!;
      expect(band, c.card).toMatch(/left:-10%;top:50%;width:120%/);
      expect(Number(/font-size:(\d+)px/.exec(band)![1]), c.card).toBeGreaterThanOrEqual(48);
    }
  });

  it("renders a 1600×900 PNG with no console error", async () => {
    const r = await cardRenderer();
    try {
      const png = await r.render("win", parseEvent(ex.win_card));
      expect(png.subarray(1, 4).toString()).toBe("PNG");
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1600, 900]);
    } finally {
      await r.close();
    }
  }, 90_000);
});
