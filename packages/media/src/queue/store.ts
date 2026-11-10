/**
 * Where drafts live. Every status change is conditional on the statuses it may start from, so two runs never take
 * the same draft: only one conditional write wins. MemoryDraftStore is one process's memory (dev and tests); the
 * database shape is `migrations/0001_media_queue.sql`.
 */

import type { Draft, DraftStatus, QueueSettings } from "./types.ts";
import { DEFAULT_SETTINGS } from "./types.ts";

export type DraftPatch = Partial<Omit<Draft, "id" | "key" | "createdAt">>;

export interface DraftStore {
  /** Adds the draft unless one with its key, or the same text within `dedupWindowMs`, is there. True when added. */
  insert(d: Draft, dedupWindowMs: number): Promise<boolean>;
  get(id: string): Promise<Draft | null>;
  list(status?: DraftStatus): Promise<Draft[]>;
  /** Applies the patch only while the draft is in one of `from`; the row after, or null. */
  update(id: string, patch: DraftPatch, from: readonly DraftStatus[]): Promise<Draft | null>;
  /** Posts that went out at or after `since`. */
  postedSince(since: number): Promise<number>;
  settings(): Promise<QueueSettings>;
  patchSettings(p: Partial<QueueSettings>): Promise<QueueSettings>;
}

export const normalText = (t: string): string => t.toLowerCase().replace(/\s+/g, " ").trim();

export class MemoryDraftStore implements DraftStore {
  private rows = new Map<string, Draft>();
  private conf: QueueSettings;

  constructor(settings: Partial<QueueSettings> = {}) {
    this.conf = { ...DEFAULT_SETTINGS, ...settings };
  }

  async insert(d: Draft, dedupWindowMs: number): Promise<boolean> {
    const text = normalText(d.text);
    for (const r of this.rows.values()) {
      if (r.key === d.key || r.id === d.id) return false;
      if (normalText(r.text) === text && d.createdAt - r.createdAt < dedupWindowMs) return false;
    }
    this.rows.set(d.id, structuredClone(d));
    return true;
  }

  async get(id: string): Promise<Draft | null> {
    const r = this.rows.get(id);
    return r ? structuredClone(r) : null;
  }

  async list(status?: DraftStatus): Promise<Draft[]> {
    return [...this.rows.values()]
      .filter((r) => !status || r.status === status)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((r) => structuredClone(r));
  }

  async update(id: string, patch: DraftPatch, from: readonly DraftStatus[]): Promise<Draft | null> {
    const r = this.rows.get(id);
    if (!r || !from.includes(r.status)) return null;
    const next = { ...r, ...patch };
    this.rows.set(id, next);
    return structuredClone(next);
  }

  async postedSince(since: number): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) if (r.status === "posted" && r.postedAt !== null && r.postedAt >= since) n++;
    return n;
  }

  async settings(): Promise<QueueSettings> {
    return { ...this.conf };
  }

  async patchSettings(p: Partial<QueueSettings>): Promise<QueueSettings> {
    this.conf = { ...this.conf, ...p };
    return { ...this.conf };
  }
}
