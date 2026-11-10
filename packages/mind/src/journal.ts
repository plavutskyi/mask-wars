/**
 * One record per decision and per polished line: which model, the hashes of the exact request and response, the TEE
 * signature, what it cost, and whether the move came from the model or from the mask's default.
 */
import type { ResponseSignature } from "./provider.ts";

export interface JournalEntry {
  readonly at: number;
  readonly fightId: string;
  readonly mask: string;
  readonly kind: "seal" | "minute" | "line";
  readonly provider: string;
  readonly model: string;
  /** sha256 of the exact request bytes; null when no request left the box. */
  readonly requestHash: string | null;
  readonly responseHash: string | null;
  readonly signature: ResponseSignature | null;
  readonly signatureVerified: boolean;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** `model`: the proposal passed the rules. `default`: the mask's own move or line was used instead. */
  readonly source: "model" | "default";
  /** Why the default was used: timeout, schema, rule. Empty when the model's move stood. */
  readonly reason: string;
  /** The move or line that was played, as JSON. */
  readonly outcome: string;
}

export interface Journal {
  write(entry: JournalEntry): void | Promise<void>;
}

export class MemoryJournal implements Journal {
  readonly entries: JournalEntry[] = [];
  write(entry: JournalEntry): void {
    this.entries.push(entry);
  }
  get totalCostUsd(): number {
    return this.entries.reduce((s, e) => s + e.costUsd, 0);
  }
}
