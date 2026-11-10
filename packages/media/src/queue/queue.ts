/**
 * The draft queue: pending → approved → posted | rejected. The owner approves from the phone one by one or with
 * Approve all; the stop cock halts everything; a daily cap and an hourly pace bound what goes out; the same moment or
 * the same text never goes twice. Every text passes lintPost on the way in, on approval and right before posting.
 */

import { randomUUID } from "node:crypto";
import type { MediaJob } from "../detector.ts";
import { lintPost } from "../lint.ts";
import type { DraftStore } from "./store.ts";
import type { Draft } from "./types.ts";
import type { XClient } from "./x.ts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** The same text is a duplicate for a week. */
export const DEDUP_WINDOW_MS = 7 * DAY;

export const SIMULATED_PROBLEM = "SIMULATED numbers: never posted";

export function problemsOf(d: Pick<Draft, "text" | "reply" | "grid" | "source">): string[] {
  const out = [...lintPost(d.text, { role: "post", grid: d.grid }), ...lintPost(d.reply, { role: "reply" }).map((p) => `reply: ${p}`)];
  if (d.source !== "LIVE") out.push(SIMULATED_PROBLEM);
  return out;
}

/** Puts a draft job in the queue. Null when the moment or the text is already there. */
export async function enqueue(store: DraftStore, job: Extract<MediaJob, { kind: "draft" }>, now: number): Promise<Draft | null> {
  const d: Draft = {
    id: randomUUID(),
    key: job.key,
    text: job.draft.text,
    reply: job.draft.reply,
    grid: job.draft.grid ?? false,
    media: job.media,
    source: job.source,
    status: "pending",
    problems: [],
    createdAt: now,
    decidedAt: null,
    postedAt: null,
    postId: null,
    replyId: null,
    tries: 0,
    lastError: null,
  };
  d.problems = problemsOf(d);
  return (await store.insert(d, DEDUP_WINDOW_MS)) ? d : null;
}

export type Decision = { ok: true; draft: Draft } | { ok: false; reason: string };

export async function approve(store: DraftStore, id: string, now: number): Promise<Decision> {
  const d = await store.get(id);
  if (!d) return { ok: false, reason: "no such draft" };
  const problems = problemsOf(d);
  if (problems.length) {
    await store.update(id, { problems }, ["pending"]);
    return { ok: false, reason: problems.join("; ") };
  }
  const r = await store.update(id, { status: "approved", decidedAt: now, problems: [] }, ["pending"]);
  return r ? { ok: true, draft: r } : { ok: false, reason: `not pending (${d.status})` };
}

/** Approves every clean pending draft; drafts with problems stay pending with the reasons on them. */
export async function approveAll(store: DraftStore, now: number): Promise<{ approved: string[]; held: string[] }> {
  const approved: string[] = [];
  const held: string[] = [];
  for (const d of await store.list("pending")) ((await approve(store, d.id, now)).ok ? approved : held).push(d.id);
  return { approved, held };
}

export async function reject(store: DraftStore, id: string, now: number, reason = "rejected by the owner"): Promise<Decision> {
  const r = await store.update(id, { status: "rejected", decidedAt: now, lastError: reason }, ["pending", "approved"]);
  return r ? { ok: true, draft: r } : { ok: false, reason: "only a pending or approved draft can be rejected" };
}

/** Owner edits: the text changes only while pending, and it is checked again. */
export async function edit(store: DraftStore, id: string, text: string): Promise<Decision> {
  const d = await store.get(id);
  if (!d) return { ok: false, reason: "no such draft" };
  const r = await store.update(id, { text, problems: problemsOf({ ...d, text }) }, ["pending"]);
  return r ? { ok: true, draft: r } : { ok: false, reason: "only a pending draft can be edited" };
}

export const stop = (store: DraftStore) => store.patchSettings({ stopped: true });
export const resume = (store: DraftStore) => store.patchSettings({ stopped: false });

const utcMidnight = (now: number) => now - (now % DAY);

export type TickResult = { posted: string[]; failed: string[]; held: "stopped" | "x_off" | "daily_cap" | "pace" | null };

/**
 * One run of the poster: approved drafts, oldest first, while the stop cock is open, X is on, and the day's cap and
 * the hour's pace allow. A failed post stays approved for the next run; a text that fails the last check is rejected.
 */
export async function tick(store: DraftStore, x: XClient, now: number): Promise<TickResult> {
  const res: TickResult = { posted: [], failed: [], held: null };
  if (!x.enabled) return { ...res, held: "x_off" };
  for (const d of await store.list("approved")) {
    const s = await store.settings();
    if (s.stopped) return { ...res, held: "stopped" };
    if ((await store.postedSince(utcMidnight(now))) >= s.dailyCap) return { ...res, held: "daily_cap" };
    if ((await store.postedSince(now - HOUR + 1)) >= s.perHour) return { ...res, held: "pace" };
    const problems = problemsOf(d);
    if (problems.length) {
      await store.update(d.id, { status: "rejected", problems, decidedAt: now, lastError: "failed the last check before posting" }, ["approved"]);
      res.failed.push(d.id);
      continue;
    }
    try {
      const post = await x.post({ text: d.text, media: d.media });
      const reply = await x.post({ text: d.reply, replyTo: post.id }).catch(() => null);
      await store.update(d.id, { status: "posted", postedAt: now, postId: post.id, replyId: reply?.id ?? null, tries: d.tries + 1, lastError: reply ? null : "reply failed" }, ["approved"]);
      res.posted.push(d.id);
    } catch (e) {
      await store.update(d.id, { tries: d.tries + 1, lastError: e instanceof Error ? e.message : String(e) }, ["approved"]);
      res.failed.push(d.id);
    }
  }
  return res;
}
