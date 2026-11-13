import { describe, expect, it } from "vitest";
import { LIST_PAGE, listMasks, type MaskView, TESTNET, type view } from "../src/chain.ts";

const mask = (i: number): MaskView =>
  ({ name: `m${i}`, account: `m${i}.${TESTNET.factory}`, look: "porcelain", brain: "680000000000000000000000", races: 0, born_ns: String(i), state: "ready" }) as MaskView;

/** A factory with `n` masks, answering `list_masks` as the contract does: from `from_index`, at most 50 a call. */
function factory(n: number) {
  const asked: { method: string; args: unknown; timeoutMs: number | undefined }[] = [];
  const read = (async (_net, method, args = {}, timeoutMs) => {
    asked.push({ method, args, timeoutMs });
    const { from_index: from = 0, limit = LIST_PAGE } = args as { from_index?: number; limit?: number };
    return Array.from({ length: Math.max(0, Math.min(n, from + Math.min(limit, LIST_PAGE)) - from) }, (_, i) => mask(from + i));
  }) as typeof view;
  return { asked, read };
}

describe("the masks the factory lists", () => {
  it("reads one page when the factory has fewer masks than a page", async () => {
    const f = factory(1);
    const masks = await listMasks(TESTNET, { read: f.read, timeoutMs: 2_500 });
    expect(masks.map((m) => m.name)).toEqual(["m0"]);
    expect(masks[0]).toMatchObject({ look: "porcelain", brain: "680000000000000000000000", races: 0, state: "ready" });
    expect(f.asked).toEqual([{ method: "list_masks", args: { from_index: 0, limit: 50 }, timeoutMs: 2_500 }]);
  });

  it("reads page after page, in forging order, until one comes short", async () => {
    const f = factory(120);
    const masks = await listMasks(TESTNET, { read: f.read });
    expect(masks).toHaveLength(120);
    expect(masks.map((m) => m.name)).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`));
    expect(f.asked.map((a) => a.args)).toEqual([
      { from_index: 0, limit: 50 },
      { from_index: 50, limit: 50 },
      { from_index: 100, limit: 50 },
    ]);
  });

  it("asks once more when the last page is full, and gets nothing", async () => {
    const f = factory(100);
    expect(await listMasks(TESTNET, { read: f.read })).toHaveLength(100);
    expect(f.asked.map((a) => a.args)).toEqual([
      { from_index: 0, limit: 50 },
      { from_index: 50, limit: 50 },
      { from_index: 100, limit: 50 },
    ]);
  });

  it("stops at `max`, asking for no more than it needs", async () => {
    const f = factory(500);
    expect(await listMasks(TESTNET, { read: f.read, max: 70 })).toHaveLength(70);
    expect(f.asked.map((a) => a.args)).toEqual([
      { from_index: 0, limit: 50 },
      { from_index: 50, limit: 20 },
    ]);
    expect(await listMasks(TESTNET, { read: f.read, max: 0 })).toEqual([]);
  });

  it("gives an empty list for a factory with no mask", async () => {
    expect(await listMasks(TESTNET, { read: factory(0).read })).toEqual([]);
  });

  it("fails when a page fails: half a list is not the list", async () => {
    const f = factory(120);
    const read = (async (net, method, args, timeoutMs) => {
      if ((args as { from_index: number }).from_index === 50) throw new Error("no RPC answered");
      return f.read(net, method, args, timeoutMs);
    }) as typeof view;
    await expect(listMasks(TESTNET, { read })).rejects.toThrow("no RPC answered");
  });
});
