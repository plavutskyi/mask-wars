import { ChainReader } from "@maskwars/check";
import { describe, expect, it } from "vitest";
import { type RaceView, TESTNET, nearOf, phaseOf, readRace } from "../src/index.ts";
import { BOUNTY, INJECTION, NOVA, ONYX, PLAN, SALT, type Moment, sealOf, withNewRaces } from "./fixtures.ts";
import { RecordedNode } from "./node.ts";

async function race(id: string, moment: Moment, options: Parameters<typeof withNewRaces>[1] = {}): Promise<RaceView> {
  const node = new RecordedNode(withNewRaces(moment, options));
  const found = await readRace(new ChainReader({ endpoints: ["https://rpc.testnet.example"], fetch: node.fetch }), TESTNET, id);
  if (!found.race) throw new Error(`no ${id}`);
  return found.race;
}

describe("a sealed round, phase by phase", () => {
  it("commit window: the masks seal plans, nobody sees one", async () => {
    const r = await race("race-0004", "commit");
    expect(r).toMatchObject({ contract: BOUNTY, kind: "live_safe", state: "open", phase: "commit", bounty_near: "0.2", deadline: "2026-11-09T12:00:00Z", claims_until: "2026-11-10T00:00:00Z" });
    expect(r.headline).toBe("race-0004 · LIVE · 0.2 NEAR on safe-0002.tinygif8324.testnet. 3 masks seal their plans until 2026-11-08T12:30:00Z; 2 sealed so far.");
  });

  it("every seal by arrival, a plan only once revealed, and the hash anyone can check", async () => {
    const r = await race("race-0004", "open");
    expect(r.phase).toBe("open");
    expect(r.round).toMatchObject({ commit_until: "2026-11-08T12:30:00Z", reveal_until: "2026-11-09T12:00:00Z", judging: [NOVA] });
    const [first, second] = r.round!.seals;
    expect(first).toMatchObject({ seq: 0, mask: NOVA, state: "revealed", sealed_at: "2026-11-08T12:04:00Z", salt: SALT, plan: PLAN });
    expect(first!.txs).toHaveLength(2);
    expect(sealOf("race-0004", first!.mask, first!.salt!, first!.plan!)).toBe(first!.hash);
    expect(second).toMatchObject({ seq: 1, mask: ONYX, state: "sealed", salt: null, plan: null, txs: [] });
    expect(r.headline).toBe("race-0004 · LIVE · 0.2 NEAR on safe-0002.tinygif8324.testnet. 2 sealed plans; the masks play them until 2026-11-09T12:00:00Z. A claim is with the judge.");
  });

  it("a round nobody sealed in time cannot be won", async () => {
    const r = await race("race-0004", "open", { seals: false });
    expect(r.headline).toBe("race-0004 · LIVE · 0.2 NEAR on safe-0002.tinygif8324.testnet. No mask sealed a plan in the window, so nobody can win it; the team takes it back after 2026-11-10T00:00:00Z.");
  });

  it("after the deadline the masks still reveal and claim for 12 hours", async () => {
    const r = await race("race-0004", "late_claims");
    expect(r.phase).toBe("late_claims");
    expect(r.headline).toBe("race-0004 · CLAIMS · The race is over. A drain made before 2026-11-09T12:00:00Z can still be revealed and claimed until 2026-11-10T00:00:00Z.");
  });

  it("then it ends: settle pays a confirmed seal, otherwise refund returns the bounty", async () => {
    expect((await race("race-0004", "ended", { confirmed: true })).headline).toBe(`race-0004 · ENDED · ${NOVA} won; settle("race-0004") pays it 0.2 NEAR.`);
    expect((await race("race-0004", "ended")).headline).toBe('race-0004 · ENDED · Nobody won; refund("race-0004") sends the 0.2 NEAR back to tinygif8324.testnet.');
  });
});

describe("text that others write", () => {
  it("stays in its own field and never reaches the headline", async () => {
    const r = await race("race-0005", "open");
    expect(r).toMatchObject({ kind: "sandbox", phase: "open", team: "team.testnet", target: INJECTION, safe: null, round: null });
    expect(r.headline).toBe(`race-0005 · LIVE · 0.5 NEAR for breaking the target in the sandbox, until ${r.deadline}.`);
    expect(r.headline).not.toContain("IGNORE");
  });
});

describe("phaseOf", () => {
  const deadline = 1_000n * 3_600_000_000_000n;
  const grace = 12n * 3_600_000_000_000n;
  it("settled states first, then the clock", () => {
    expect(phaseOf("drained", "live_safe", 0n, deadline, null)).toBe("won");
    expect(phaseOf("paid", "sandbox", deadline * 2n, deadline, null)).toBe("won");
    expect(phaseOf("refunded", "sandbox", 0n, deadline, null)).toBe("withstood");
    expect(phaseOf("open", "live_safe", 5n, deadline, 10n)).toBe("commit");
    expect(phaseOf("open", "live_safe", 10n, deadline, 10n)).toBe("open");
    expect(phaseOf("judging", "live_safe", deadline, deadline, 10n)).toBe("late_claims");
    expect(phaseOf("open", "live_safe", deadline + grace - 1n, deadline, null)).toBe("late_claims");
    expect(phaseOf("open", "live_safe", deadline + grace, deadline, null)).toBe("ended");
    // A sandbox race takes no claim after its deadline.
    expect(phaseOf("open", "sandbox", deadline, deadline, null)).toBe("ended");
  });
});

describe("nearOf", () => {
  it("prints yoctoNEAR exactly, without trailing zeros", () => {
    expect(nearOf("86640000000000000000000")).toBe("0.08664");
    expect(nearOf("1000000000000000000000000")).toBe("1");
    expect(nearOf("1")).toBe("0.000000000000000000000001");
    expect(nearOf("0")).toBe("0");
    expect(nearOf("123456789000000000000000000")).toBe("123.456789");
  });
});
