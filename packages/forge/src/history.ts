/**
 * A mask's race history, open only to the accounts its owner chose (view keys, `contracts/masks/factory/src/view.rs`).
 *
 * - **A view key** is an X25519 key pair. The site makes it from the reader's own wallet: the wallet signs one fixed
 *   message (`VIEW_MESSAGE`), and the signature, which an ed25519 wallet makes the same way every time, is the seed. The
 *   secret half is never stored: the same wallet makes the same key on any device. The public half goes on the factory
 *   once (`set_view_key`).
 * - **A race key** opens one race's note. The keeper makes it from its own seed for that mask and that race
 *   (`raceKey`), so a revoked reader, who holds the keys of the races before, gets none after.
 * - **A note** is the race as the keeper saw it: attempts, verdicts, the calls of each plan, the transactions, the
 *   payout, what the mind spent. Never the model's text and never the strategy. Sealed with the race key:
 *
 *     v1. + base64url( nonce (12) | AES-256-GCM(race key, nonce, json | 0x80 | 0x00… to a multiple of 256,
 *                                               aad = "<mask account>|<race>") )
 *
 * - **A wrap** is a race key, or a page of them, sealed for one reader's view key:
 *
 *     v1. + base64url( eph_pub (32) | nonce (12) | AES-256-GCM(key, nonce, payload, aad = "<mask account>|<reader>") )
 *     key = HKDF-SHA256(ikm = X25519(eph, view), salt = eph_pub | view_pub, info = "maskwars:view:v1")
 *
 * Web Crypto only, in the browser and in Node alike.
 */
import { base64url, keyBytes } from "./seal.ts";

/** What the reader's wallet signs to make their view key. Changing it changes every view key. */
export const VIEW_MESSAGE = "MASK WARS view key v1: this signature opens the race histories shared with this account.";
/** The NEP-413 recipient and nonce of that signature: fixed, so the signature, and the key, come out the same. */
export const VIEW_RECIPIENT = "maskwars.xyz";
export const VIEW_NONCE = new Uint8Array(32).fill(7);

const enc = new TextEncoder();
const NOTE_INFO = enc.encode("maskwars:history:race:v1");
const WRAP_INFO = enc.encode("maskwars:view:v1");
const VIEW_INFO = enc.encode("maskwars:view-key:v1");
const PAD = 256;
const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);

/** A reader's view key: the public half as the factory keeps it, the private half only in this page. */
export interface ViewKey {
  readonly public: string;
  readonly private: CryptoKey;
}

/** One race of a mask, as its note tells it. Amounts are yoctoNEAR, times milliseconds. */
export interface RaceNote {
  readonly v: 1;
  readonly mask: string;
  readonly race: string;
  readonly at: number;
  /** The author whose sealed strategy this copy played (its mask's name), if the mask is a copy. */
  readonly copyOf: string | null;
  /** The mind's attempts before the seal: each plan's calls and the sandbox's verdict. */
  readonly attempts: readonly { readonly n: number; readonly plan: readonly string[]; readonly verdict: string }[];
  /** Where the attempts were thought: the mind's module on OutLayer and the model, or the keeper's own plan. */
  readonly mind: { readonly where: string; readonly model: string; readonly strategy: boolean } | null;
  /** The calls the mask sealed and then played on the safe. */
  readonly sealed: { readonly seq: number; readonly plan: readonly string[] } | null;
  readonly result: "won" | "held" | "beaten" | "missed";
  readonly prize: string;
  readonly loot: string;
  readonly spent: string;
  /** For a copy: the author's share counted on this race's winnings. */
  readonly authorShare: string | null;
  readonly txs: readonly { readonly what: string; readonly hash: string }[];
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function unbase64url(text: string): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const c of text) {
    const v = B64.indexOf(c);
    if (v < 0) throw new Error("not base64url");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hkdf(ikm: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length = 32): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

async function aes(raw: Uint8Array<ArrayBuffer>, use: KeyUsage): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, [use]);
}

/** A view key from 32 seed bytes. */
export async function viewKeyFromSeed(seed: Uint8Array<ArrayBuffer>): Promise<ViewKey> {
  if (seed.length !== 32) throw new Error("a view key's seed is 32 bytes");
  const privateKey = await crypto.subtle.importKey("pkcs8", concat(PKCS8_X25519, seed), { name: "X25519" }, true, ["deriveBits"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  return { public: `x25519:${hex(unbase64url(jwk.x!))}`, private: privateKey };
}

/** The view key of `account`, from its wallet's signature of `VIEW_MESSAGE` (the signature's bytes). */
export async function viewKeyFromSignature(signature: Uint8Array<ArrayBuffer>, account: string): Promise<ViewKey> {
  if (signature.length < 32) throw new Error("not a signature");
  return viewKeyFromSeed(await hkdf(signature, enc.encode("maskwars"), concat(VIEW_INFO, enc.encode(`|${account}`))));
}

/** The key of one race of one mask, from the keeper's history seed. */
export function raceKey(historySeed: Uint8Array<ArrayBuffer>, mask: string, race: string): Promise<Uint8Array<ArrayBuffer>> {
  return hkdf(historySeed, enc.encode("maskwars"), concat(NOTE_INFO, enc.encode(`|${mask}|${race}`)));
}

/** A race's note, sealed with its race key. */
export async function sealNote(key: Uint8Array<ArrayBuffer>, note: RaceNote): Promise<string> {
  const text = enc.encode(JSON.stringify(note));
  const padded = new Uint8Array(Math.ceil((text.length + 1) / PAD) * PAD);
  padded.set(text);
  padded[text.length] = 0x80;
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = enc.encode(`${note.mask}|${note.race}`);
  const box = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, await aes(key, "encrypt"), padded));
  return `v1.${base64url(concat(nonce, box))}`;
}

/** Opens a race's note with its race key; it must be the note of this mask and this race. */
export async function openNote(key: Uint8Array<ArrayBuffer>, mask: string, race: string, sealed: string): Promise<RaceNote> {
  if (!sealed.startsWith("v1.")) throw new Error("not a v1 note");
  const bytes = unbase64url(sealed.slice(3));
  const aad = enc.encode(`${mask}|${race}`);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad }, await aes(key, "decrypt"), bytes.slice(12)),
  );
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (end < 0 || padded[end] !== 0x80) throw new Error("bad padding");
  const note = JSON.parse(new TextDecoder().decode(padded.slice(0, end))) as RaceNote;
  if (note.mask !== mask || note.race !== race) throw new Error("this note is of another race");
  return note;
}

/** Seals `payload` (a race key, or a page of them) for one reader's view key, bound to the mask and the reader. */
export async function wrapFor(viewKey: string, mask: string, reader: string, payload: Uint8Array<ArrayBuffer>): Promise<string> {
  const viewRaw = keyBytes(viewKey);
  const view = await crypto.subtle.importKey("raw", viewRaw, { name: "X25519" }, false, []);
  const eph = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: view }, eph.privateKey, 256));
  const ephRaw = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const key = await hkdf(shared, concat(ephRaw, viewRaw), WRAP_INFO);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const box = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc.encode(`${mask}|${reader}`) }, await aes(key, "encrypt"), payload),
  );
  return `v1.${base64url(concat(ephRaw, nonce, box))}`;
}

/** Opens a wrap sealed for this reader's view key. */
export async function unwrap(view: ViewKey, mask: string, reader: string, sealed: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!sealed.startsWith("v1.")) throw new Error("not a v1 wrap");
  const bytes = unbase64url(sealed.slice(3));
  if (bytes.length < 32 + 12 + 16) throw new Error("a wrap is too short");
  const ephRaw = bytes.slice(0, 32);
  const eph = await crypto.subtle.importKey("raw", ephRaw, { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: eph }, view.private, 256));
  const key = await hkdf(shared, concat(ephRaw, keyBytes(view.public)), WRAP_INFO);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(32, 44), additionalData: enc.encode(`${mask}|${reader}`) },
      await aes(key, "decrypt"),
      bytes.slice(44),
    ),
  );
}

/** Race keys by race, as a share carries them for a reader granted after those races. */
export function sharePayload(keys: ReadonlyMap<string, Uint8Array>): Uint8Array<ArrayBuffer> {
  return enc.encode(JSON.stringify(Object.fromEntries([...keys].map(([race, k]) => [race, hex(k)]))));
}

export function readShare(payload: Uint8Array): Map<string, Uint8Array<ArrayBuffer>> {
  const raw = JSON.parse(new TextDecoder().decode(payload)) as Record<string, string>;
  return new Map(
    Object.entries(raw)
      .filter(([, h]) => /^[0-9a-f]{64}$/.test(h))
      .map(([race, h]) => [race, Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)))]),
  );
}

/** A note or a share as the factory's events carry them (`EVENT_JSON` of `note` and `share`). */
export type HistoryEvent =
  | { readonly kind: "note"; readonly mask: string; readonly race: string; readonly note: string; readonly keys: readonly { to: string; key: string }[]; readonly at: number; readonly tx: string }
  | { readonly kind: "share"; readonly mask: string; readonly to: string; readonly keys: string; readonly at: number; readonly tx: string };

/** One receipt of a transaction as the indexer gives it: who called, who ran it, what it logged (`@maskwars/arena`'s
 * `Receipt` fits). */
export interface LoggedReceipt {
  /** The predecessor: the account that made this call. */
  readonly from: string;
  /** The receiver: the account whose code ran and wrote these logs. */
  readonly to: string;
  readonly ok: boolean;
  readonly logs: readonly string[];
}

/**
 * The `note` and `share` events of `mask` in one transaction, out of the factory's own receipts only. Any contract can
 * log an `EVENT_JSON` line that looks like the factory's, in a transaction that also touches the factory, so a line
 * counts only when the factory ran the receipt that wrote it (`to`), the receipt went through, and the call came from
 * the factory's keeper (`from`), the one account its `note` and `share` take. A forged line from another receipt of
 * the same transaction neither adds a race nor hides one.
 */
export function factoryHistoryEvents(
  receipts: readonly LoggedReceipt[],
  factory: string,
  keeper: string,
  mask: string,
  at: number,
  tx: string,
): HistoryEvent[] {
  return receipts.flatMap((r) => (r.ok && r.to === factory && r.from === keeper ? historyEvents(r.logs, mask, at, tx) : []));
}

/** The `note` and `share` events for `mask` (its account) in logs already known to be the factory's own: read them
 * from a transaction with `factoryHistoryEvents`, never from all of its logs. */
export function historyEvents(logs: readonly string[], mask: string, at: number, tx: string): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith("EVENT_JSON:")) continue;
    let e: { standard?: string; event?: string; data?: Record<string, unknown> };
    try {
      e = JSON.parse(line.slice(11));
    } catch {
      continue;
    }
    const d = e.data ?? {};
    if (e.standard !== "maskwars_masks" || d["account"] !== mask) continue;
    if (e.event === "note" && typeof d["race"] === "string" && typeof d["note"] === "string" && Array.isArray(d["keys"])) {
      const keys = (d["keys"] as unknown[]).flatMap((k) => {
        const o = k as { to?: unknown; key?: unknown };
        return typeof o.to === "string" && typeof o.key === "string" ? [{ to: o.to, key: o.key }] : [];
      });
      out.push({ kind: "note", mask, race: d["race"], note: d["note"], keys, at, tx });
    } else if (e.event === "share" && typeof d["to"] === "string" && typeof d["keys"] === "string") {
      out.push({ kind: "share", mask, to: d["to"], keys: d["keys"], at, tx });
    }
  }
  return out;
}

/** What one reader can open of a mask's history: every note whose race key reached it, by a note's own wrap or a share. */
export async function readHistory(view: ViewKey, reader: string, events: readonly HistoryEvent[]): Promise<RaceNote[]> {
  const keys = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const e of events) {
    try {
      if (e.kind === "share" && e.to === reader) {
        for (const [race, k] of readShare(await unwrap(view, e.mask, reader, e.keys))) keys.set(race, k);
      } else if (e.kind === "note") {
        const mine = e.keys.find((k) => k.to === reader);
        if (mine) keys.set(e.race, await unwrap(view, e.mask, reader, mine.key));
      }
    } catch {
      // A wrap sealed for an older view key of this reader: the keeper shares it again under the new one.
    }
  }
  // The keeper's latest note of a race stands: a note written again (a correction) replaces the one before it.
  const latest = new Map<string, Extract<HistoryEvent, { kind: "note" }>>();
  for (const e of events) {
    if (e.kind !== "note" || !keys.has(e.race)) continue;
    const seen = latest.get(e.race);
    if (!seen || e.at >= seen.at) latest.set(e.race, e);
  }
  const notes: RaceNote[] = [];
  for (const e of latest.values()) {
    try {
      notes.push(await openNote(keys.get(e.race)!, e.mask, e.race, e.note));
    } catch {
      // Not this race's note.
    }
  }
  return notes.sort((a, b) => b.at - a.at);
}

/** One account that may read a mask's history, as the factory's `viewers` lists it. */
export interface Viewer {
  readonly account: string;
  /** The view key it registered, `x25519:<hex>`; null until it registers one. */
  readonly key: string | null;
}

/** The storage a grant or a view key adds, attached with the call; what is not used comes back. */
export const VIEW_STORAGE_DEPOSIT = "10000000000000000000000";

/** The reader registers their view key on the factory, once for every mask that shares a history with them. */
export function setViewKeyAction(key: string) {
  return {
    type: "FunctionCall" as const,
    params: { methodName: "set_view_key", args: { key }, gas: "30000000000000", deposit: VIEW_STORAGE_DEPOSIT },
  };
}

/** The owner lets `viewer` read the mask's race history. */
export function grantViewAction(name: string, viewer: string) {
  return {
    type: "FunctionCall" as const,
    params: { methodName: "grant_view", args: { name, viewer }, gas: "30000000000000", deposit: VIEW_STORAGE_DEPOSIT },
  };
}

/** The owner takes a view back: no race after it is sealed for that account. Exactly 1 yoctoNEAR, as the factory asks. */
export function revokeViewAction(name: string, viewer: string) {
  return {
    type: "FunctionCall" as const,
    params: { methodName: "revoke_view", args: { name, viewer }, gas: "30000000000000", deposit: "1" },
  };
}

/** The NEP-413 payload a wallet signs for a view key: the message, the fixed nonce, the recipient, no callback. */
export function viewMessageBytes(): Uint8Array<ArrayBuffer> {
  const message = enc.encode(VIEW_MESSAGE);
  const recipient = enc.encode(VIEW_RECIPIENT);
  const out = new Uint8Array(4 + 4 + message.length + 32 + 4 + recipient.length + 1);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 2 ** 31 + 413, true);
  dv.setUint32(4, message.length, true);
  out.set(message, 8);
  out.set(VIEW_NONCE, 8 + message.length);
  dv.setUint32(8 + message.length + 32, recipient.length, true);
  out.set(recipient, 8 + message.length + 36);
  out[out.length - 1] = 0;
  return out;
}
