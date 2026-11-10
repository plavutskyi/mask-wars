import { beforeEach, describe, expect, it } from "vitest";
import type { Draft, MediaJob } from "../src/index.ts";
import {
  DAY, FakeXClient, HOUR, MemoryDraftStore, SIMULATED_PROBLEM, approve, approveAll, edit, enqueue, fromFightEvent, offXClient, reject,
  resume, stop, tick, xClientFromEnv,
} from "../src/index.ts";
import { examples, live } from "./helpers.ts";

const ex = examples();
const T0 = Date.UTC(2026, 10, 9, 15, 0, 0);
type DraftJob = Extract<MediaJob, { kind: "draft" }>;
const draftOf = (e: unknown): DraftJob => fromFightEvent(e).find((j): j is DraftJob => j.kind === "draft")!;
let n = 0;
/** A distinct LIVE draft each call. */
const fresh = (): DraftJob => draftOf(live({ ...ex.card_grid, day: 100 + ++n }));

let store: MemoryDraftStore;
let x: FakeXClient;
beforeEach(() => {
  store = new MemoryDraftStore({ dailyCap: 5, perHour: 2 });
  x = new FakeXClient();
});

async function queued(k = 1): Promise<Draft[]> {
  const out: Draft[] = [];
  for (let i = 0; i < k; i++) out.push((await enqueue(store, fresh(), T0 + i))!);
  return out;
}

describe("states", () => {
  it("pending → approved → posted, with the link in a reply", async () => {
    const [d] = await queued();
    expect(d!.status).toBe("pending");
    expect((await approve(store, d!.id, T0)).ok).toBe(true);
    const r = await tick(store, x, T0 + 1000);
    expect(r.posted).toEqual([d!.id]);
    const after = (await store.get(d!.id))!;
    expect(after).toMatchObject({ status: "posted", postedAt: T0 + 1000 });
    expect(x.sent).toHaveLength(2);
    expect(x.sent[1]!.replyTo).toBe(x.sent[0]!.id);
    expect(x.sent[0]!.text).not.toMatch(/maskwars\.xyz/);
    expect(x.sent[1]!.text).toMatch(/maskwars\.xyz/);
  });

  it("rejected from pending or approved, and nothing leaves posted or rejected", async () => {
    const [a, b] = await queued(2);
    expect((await reject(store, a!.id, T0)).ok).toBe(true);
    await approve(store, b!.id, T0);
    expect((await reject(store, b!.id, T0)).ok).toBe(true);
    expect((await approve(store, a!.id, T0)).ok).toBe(false);
    const [c] = await queued();
    await approve(store, c!.id, T0);
    await tick(store, x, T0);
    expect((await reject(store, c!.id, T0)).ok).toBe(false);
    expect((await approve(store, c!.id, T0)).ok).toBe(false);
  });

  it("Approve all takes every clean draft and holds the rest with reasons", async () => {
    const clean = await queued(3);
    const dirty = (await enqueue(store, { ...fresh(), draft: { text: "pure alpha!", reply: "maskwars.xyz" } }, T0))!;
    const r = await approveAll(store, T0);
    expect(r.approved.sort()).toEqual(clean.map((d) => d.id).sort());
    expect(r.held).toEqual([dirty.id]);
    expect((await store.get(dirty.id))!.problems.length).toBeGreaterThan(0);
  });

  it("an edit is checked again", async () => {
    const [d] = await queued();
    await edit(store, d!.id, "revolutionary fight tonight");
    expect((await approve(store, d!.id, T0)).ok).toBe(false);
  });

  it("SIMULATED numbers are never approved or posted", async () => {
    const d = (await enqueue(store, draftOf(ex.win_card), T0))!;
    expect(d.problems).toContain(SIMULATED_PROBLEM);
    expect((await approveAll(store, T0)).held).toEqual([d.id]);
    expect((await tick(store, x, T0)).posted).toEqual([]);
  });
});

describe("dedup", () => {
  it("one moment, one draft", async () => {
    const job = draftOf(live(ex.win_card));
    expect(await enqueue(store, job, T0)).not.toBeNull();
    expect(await enqueue(store, draftOf(live({ ...ex.win_card, at: "2026-11-09T15:21:00Z" })), T0 + 1)).toBeNull();
  });

  it("the same text within a week is a duplicate, after a week it is not", async () => {
    const a = fresh();
    expect(await enqueue(store, a, T0)).not.toBeNull();
    expect(await enqueue(store, { ...a, key: "other" }, T0 + DAY)).toBeNull();
    expect(await enqueue(store, { ...a, key: "later" }, T0 + 8 * DAY)).not.toBeNull();
  });
});

describe("limits", () => {
  it("the stop cock holds everything, resume lets it go", async () => {
    const ds = await queued(2);
    await approveAll(store, T0);
    await stop(store);
    expect(await tick(store, x, T0)).toMatchObject({ posted: [], held: "stopped" });
    expect(x.sent).toHaveLength(0);
    await resume(store);
    expect((await tick(store, x, T0)).posted).toEqual(ds.map((d) => d.id));
  });

  it("pace: no more than perHour in a rolling hour", async () => {
    await queued(3);
    await approveAll(store, T0);
    expect(await tick(store, x, T0)).toMatchObject({ held: "pace" });
    expect(await store.postedSince(T0 - HOUR)).toBe(2);
    expect((await tick(store, x, T0 + HOUR - 1)).posted).toEqual([]);
    expect((await tick(store, x, T0 + HOUR)).posted).toHaveLength(1);
  });

  it("the daily cap stops the day and opens again at UTC midnight", async () => {
    await store.patchSettings({ perHour: 20, dailyCap: 3 });
    await queued(5);
    await approveAll(store, T0);
    const r = await tick(store, x, T0);
    expect(r.posted).toHaveLength(3);
    expect(r.held).toBe("daily_cap");
    const midnight = T0 - (T0 % DAY) + DAY;
    expect((await tick(store, x, midnight - 1)).posted).toHaveLength(0);
    expect((await tick(store, x, midnight)).posted).toHaveLength(2);
  });

  it("a failed post stays approved and is tried again", async () => {
    const [d] = await queued();
    await approve(store, d!.id, T0);
    x.failNext = 1;
    expect((await tick(store, x, T0)).failed).toEqual([d!.id]);
    expect((await store.get(d!.id))!).toMatchObject({ status: "approved", tries: 1, lastError: "fake X: 503" });
    expect((await tick(store, x, T0 + 60_000)).posted).toEqual([d!.id]);
  });
});

describe("X flag", () => {
  it("is off by default and the queue then touches nothing", async () => {
    expect(xClientFromEnv({})).toBe(offXClient);
    const [d] = await queued();
    await approve(store, d!.id, T0);
    expect(await tick(store, offXClient, T0)).toMatchObject({ held: "x_off", posted: [] });
    expect((await store.get(d!.id))!.status).toBe("approved");
  });

  it("fake on request; nothing else exists", () => {
    expect(xClientFromEnv({ MEDIA_X: "fake" }).enabled).toBe(true);
    expect(() => xClientFromEnv({ MEDIA_X: "live" })).toThrow(/posts nowhere/);
  });
});
