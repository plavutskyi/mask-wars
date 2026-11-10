export const DRAFT_STATUSES = ["pending", "approved", "posted", "rejected"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/** Allowed moves: pending → approved → posted, and either of the first two → rejected. */
export const DRAFT_TRANSITIONS: Readonly<Record<DraftStatus, readonly DraftStatus[]>> = {
  pending: ["approved", "rejected"],
  approved: ["posted", "rejected"],
  posted: [],
  rejected: [],
};

export type Draft = {
  id: string;
  /** The moment's key: one moment, one draft. */
  key: string;
  text: string;
  /** Our own first reply under the post: the one place a link goes. */
  reply: string;
  grid: boolean;
  /** Media key (a card or clip job), or null for text only. */
  media: string | null;
  source: "LIVE" | "SIMULATED";
  status: DraftStatus;
  /** Why it may not go out; a draft with problems is never approved. */
  problems: string[];
  createdAt: number;
  decidedAt: number | null;
  postedAt: number | null;
  postId: string | null;
  replyId: string | null;
  tries: number;
  lastError: string | null;
};

export type QueueSettings = {
  /** The stop cock: nothing posts while it is on. */
  stopped: boolean;
  /** Posts per UTC day, at most. */
  dailyCap: number;
  /** Posts per rolling hour, at most. */
  perHour: number;
};

export const DEFAULT_SETTINGS: QueueSettings = { stopped: false, dailyCap: 12, perHour: 2 };
