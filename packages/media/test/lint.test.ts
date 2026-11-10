import { describe, expect, it } from "vitest";
import { draftFor, fromFightEvent, lintPost, parseEvent } from "../src/index.ts";
import { examples } from "./helpers.ts";

const ex = examples();
const bad = (t: string, opts = {}) => expect(lintPost(t, opts).length, t).toBeGreaterThan(0);
const ok = (t: string, opts = {}) => expect(lintPost(t, opts), t).toEqual([]);

describe("lintPost", () => {
  it("passes a human line", () => {
    ok("ronin only buys near, oracle only buys bitcoin, and tonight one of them has to shut up.");
    ok("@kaito_trades put $5 on ronin and left with $41.");
  });

  it("cuts the machine's words", () => {
    for (const w of ["Unleash your edge.", "pure alpha tonight", "let's delve into the fight", "what a journey", "seamless entry", "unlock the arena"]) bad(w);
  });

  it("cuts dash parallelisms and not-X-but-Y", () => {
    bad("it's a fight — and a bank");
    bad("not a game, but a war");
    bad("it's not luck, it's the mask");
  });

  it("cuts profit promises", () => {
    for (const t of ["guaranteed returns", "risk-free fight", "100x tonight", "easy money on ronin", "this will make you rich, it will pay you back", "profit every night"]) bad(t);
  });

  it("cuts junk hashtags and allows only #NEARHackathon", () => {
    bad("fight night #crypto");
    bad("built at NEAR HACKATHON #NEARHackathon #AI");
    ok("built at NEAR HACKATHON #NEARHackathon");
  });

  it("no link in the post; exactly one in the reply", () => {
    bad("watch at maskwars.xyz");
    bad("watch https://maskwars.xyz/f/1");
    ok("next fight: maskwars.xyz", { role: "reply" });
    bad("no link here", { role: "reply" });
    bad("maskwars.xyz and near.org", { role: "reply" });
  });

  it("cuts exclamations, emoji, addresses, hashes, ids", () => {
    bad("ronin wins!");
    bad("ronin wins 🔥");
    bad("sent from 0xabcdef1234567890");
    bad("tx 4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi8 done");
    bad("vault arena.maskwars.near holds it");
    bad("fight f-s0-12 is over");
  });

  it("allows the grid's squares only in the grid", () => {
    ok("MASK WARS #4 4/5\n🟧🟪🟧⬛🟪\n4 days straight", { grid: true });
    bad("🟧🟪🟧⬛🟪");
    bad("MASK WARS #4 🟧🟪🟧⬛🟪 🔥", { grid: true });
  });

  it("every template passes it with every example", () => {
    for (const e of Object.values(ex)) {
      const ev = parseEvent(e);
      const d = draftFor(ev);
      expect(lintPost(d.text, { grid: d.grid ?? false }), d.text).toEqual([]);
      expect(lintPost(d.reply, { role: "reply" }), d.reply).toEqual([]);
    }
    expect(fromFightEvent(ex.card_grid)).toHaveLength(1);
  });
});
