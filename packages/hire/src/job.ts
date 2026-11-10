import { parseDollars, sha256Hex, vaultAccountOk } from "@maskwars/pay";

/**
 * A job a team hires the swarm for: what the masks should do, the contract they do it to, and the team's own NEAR
 * account, where the money waits for the job and where every refund goes. One shape, checked the same way on the host
 * page, in the checkout and on the server.
 */
export interface Job {
  /** What the masks should do, one line in the team's words: "Attack my vault before launch". */
  readonly text: string;
  /** The contract the job is about: a NEAR account on mainnet or testnet. */
  readonly target: string;
  /** The team's NEAR mainnet account: its vault in NEAR Intents holds the job's money and takes every refund. */
  readonly team: string;
}

export const TEXT_MIN = 8;
export const TEXT_MAX = 280;

/** Control characters and the bidirectional overrides that make a line read differently from what it says. */
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

/** The job in one clean line: whitespace collapsed, 8 to 280 characters, nothing hidden in it. `null` otherwise. */
export function jobText(input: string): string | null {
  if (HIDDEN.test(input.replace(/[\t\n\r]/g, " "))) return null;
  const t = input.replace(/\s+/g, " ").trim();
  return t.length >= TEXT_MIN && t.length <= TEXT_MAX ? t : null;
}

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** A NEAR account id as NEAR itself spells it: 2 to 64 characters, lowercase, on either network. */
export function accountOk(id: string): boolean {
  return id.length >= 2 && id.length <= 64 && ACCOUNT.test(id);
}

/** Whether a target lives on testnet (`*.testnet`) or mainnet (everything else, implicit accounts included). */
export function networkOf(target: string): "mainnet" | "testnet" {
  return target.endsWith(".testnet") ? "testnet" : "mainnet";
}

/** The team's account must be one NEAR Intents keeps money for: a mainnet account, named or implicit. */
export const teamOk = (id: string): boolean => vaultAccountOk(id);

/** What a team typed, cleaned: an account id is lowercase with no spaces around it. */
export const cleanAccount = (id: string): string => id.trim().toLowerCase();

/** A whole job from loose input (an element's attributes, a request body), or `null` with any field wrong. */
export function jobOf(input: { text?: unknown; target?: unknown; team?: unknown }): Job | null {
  if (typeof input.text !== "string" || typeof input.target !== "string" || typeof input.team !== "string") return null;
  const text = jobText(input.text);
  const target = cleanAccount(input.target);
  const team = cleanAccount(input.team);
  if (!text || !accountOk(target) || !teamOk(team)) return null;
  return { text, target, team };
}

/**
 * The job's mark: sha256 of its canonical JSON. It names exactly this text, target and team, so the bid that opens
 * from the team's vault later can carry it, and anyone can check the bid is the job the team paid for.
 */
export function jobHash(job: Job): string {
  return sha256Hex(JSON.stringify({ v: 1, text: job.text, target: job.target, team: job.team }));
}

const B32 = "0123456789abcdefghjkmnpqrstvwxyz";

/** A fresh job id: `job-` and 12 characters of Crockford base32, 60 random bits. */
export function newJobId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `job-${[...bytes].map((b) => B32[b & 31]).join("")}`;
}

export const jobIdOk = (id: string): boolean => /^job-[0-9a-hjkmnp-tv-z]{12}$/.test(id);

/** How much a team puts on the job, as the host page or the team names it: dollars, or NEAR at the live price. */
export type Amount = { readonly usd: number } | { readonly near: number };

/** `100`, `2.5`, `1,000`: NEAR as a person types it, more than 0 and at most 1,000,000, up to four decimals. */
export function parseNear(text: string): number | null {
  const t = text.trim().replace(/[,\s]/g, "").replace(/\s*NEAR$/i, "");
  if (!/^\d{1,7}(?:\.\d{0,4})?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 && n <= 1_000_000 ? n : null;
}

/** An amount from an element's attributes: `usd` wins when both are there. `null` when neither reads. */
export function amountOf(a: { usd?: string | null | undefined; near?: string | null | undefined }): Amount | null {
  const usd = a.usd ? parseDollars(a.usd) : null;
  if (usd) return { usd };
  const near = a.near ? parseNear(a.near) : null;
  return near ? { near } : null;
}

/** The dollars a payer sends for `amount`: NEAR priced at `nearPrice`, rounded to cents. `null` outside $1–$9,999.99. */
export function dollarsOf(amount: Amount, nearPrice: number): number | null {
  const usd = "usd" in amount ? amount.usd : nearPrice > 0 ? Math.round(amount.near * nearPrice * 100) / 100 : 0;
  return usd >= 1 && usd < 10_000 ? usd : null;
}
