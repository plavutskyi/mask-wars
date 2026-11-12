// Guests of the house's daily round. The house opens one round a day on its vault with the arena's own masks; beside
// them it lets in guests: masks people forged (the factory) and agents from outside, each with its own NEAR account,
// who play the round themselves with their own keys. An outside agent enters a round by signing one message with a
// full-access key of its account (NEP-413, the way every NEAR wallet signs a message) and handing it to the site; the
// site only keeps it. The house checks every sign-up again itself, against the chain, before it lets anyone in: the
// signature, the key, the round. So the site is a mailbox, never the word that lets an account into a round.
//
// The message names the account, the round's slot and the network, so a sign-up is good for one round on one network
// and nothing else. Its nonce is the message's own sha256: nothing to keep, and a sign-up sent twice is the same one.
import { createHash, createPublicKey, verify } from "node:crypto";
import { type Network, slotAfter, slotAt } from "@maskwars/network";

/** Who a sign-up is addressed to (NEP-413 `recipient`): this arena, on any of its sites. */
export const GUEST_RECIPIENT = "maskwars.xyz";
/** NEP-413's tag, `2^31 + 413`, written before the payload so a signed message can never be a transaction. */
export const NEP413_TAG = 2 ** 31 + 413;
/** The least NEAR an agent's account holds to be let in: a round's calls cost it gas (seal, play, reveal, claim). */
export const AGENT_MIN_YOCTO = 5n * 10n ** 22n;

export type GuestNetwork = "mainnet" | "testnet";

/**
 * Why the house round on `net` takes no outside agent now, or null when it seats some (`guests.agents`). On mainnet it
 * seats none for now: agents come back there with an entry stake of their own. The masks people forge still race.
 */
export function agentsClosed(net: Pick<Network, "id" | "guests">): string | null {
  if (net.guests.agents > 0) return null;
  return `The house round on NEAR ${net.id} seats no outside agents yet: they come back with an entry stake of their own. On ${net.id} it races the arena's masks and the masks people forge; outside agents join the house round on NEAR testnet today.`;
}

/**
 * The round a sign-up made at `nowMs` is for: the next slot. Sign-ups for a slot close when it comes; the house reads
 * them for the slot it is opening (`openingSlot`).
 */
export function fillingSlot(net: Pick<Network, "round">, nowMs: number): number {
  return slotAfter(net.round, nowMs);
}

/** The slot the house is opening at `nowMs`: the last one that came, or null before the first. */
export function openingSlot(net: Pick<Network, "round">, nowMs: number): number | null {
  return slotAt(net.round, nowMs);
}

/**
 * An account that can never be a guest: the arena's own (its admin, contracts, house, vault, scheduler, its own masks)
 * and every account under the factory, whose masks come in as people's masks, not as agents.
 */
export function arenaAccount(net: Network, account: string): boolean {
  const own = [net.admin, net.bounty, ...net.older_bounty, net.season, net.scheduler, net.house, net.vault, net.factory, net.jobs, net.crews, ...Object.values(net.masks)];
  return own.includes(account) || account.endsWith(`.${net.factory}`) || account.endsWith(`.${net.house}`) || account.endsWith(`.${net.season}`);
}

/** `2026-11-12 18:00 UTC`, the slot as the message names it. */
export function slotText(slotMs: number): string {
  return new Date(slotMs).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

/** The one message an agent signs to enter the house's round of `slotMs` on `network`. */
export function signupMessage(network: GuestNetwork, slotMs: number, account: string): string {
  return `MASK WARS: ${account} enters the house round of ${slotText(slotMs)} on NEAR ${network}`;
}

/** The message's nonce: its own sha256, 32 bytes. */
export function signupNonce(message: string): Buffer {
  return createHash("sha256").update(message, "utf8").digest();
}

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const str = (s: string) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([u32(b.length), b]);
};

/**
 * What a NEP-413 signature signs: sha256 of the tag and the Borsh payload `{ message, nonce, recipient, callbackUrl }`,
 * `callbackUrl` none. Wallets, near-api-js `signMessage` and near-cli all sign exactly this.
 */
export function nep413Hash(message: string, nonce: Uint8Array, recipient: string = GUEST_RECIPIENT): Buffer {
  if (nonce.length !== 32) throw new Error("a NEP-413 nonce is 32 bytes");
  const payload = Buffer.concat([u32(NEP413_TAG), str(message), Buffer.from(nonce), str(recipient), Buffer.from([0])]);
  return createHash("sha256").update(payload).digest();
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Decode(text: string): Buffer {
  let n = 0n;
  for (const c of text) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("not base58");
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

/** `ed25519:<base58>` to its 32 bytes, or null. */
export function ed25519Bytes(key: string): Buffer | null {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,50})$/.exec(key.trim());
  if (!m) return null;
  try {
    const b = base58Decode(m[1]!);
    return b.length === 32 ? b : null;
  } catch {
    return null;
  }
}

/** A signature as wallets give it: base64 (64 bytes), or `ed25519:<base58>`. */
export function signatureBytes(sig: string): Buffer | null {
  const t = sig.trim();
  try {
    const b = t.startsWith("ed25519:") ? base58Decode(t.slice(8)) : Buffer.from(t, /[-_]/.test(t) ? "base64url" : "base64");
    return b.length === 64 ? b : null;
  } catch {
    return null;
  }
}

const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** Whether `signature` is `publicKey`'s ed25519 signature of `hash`. */
export function verifyEd25519(publicKey: string, signature: string, hash: Uint8Array): boolean {
  const pk = ed25519Bytes(publicKey);
  const sig = signatureBytes(signature);
  if (!pk || !sig) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, pk]), format: "der", type: "spki" });
    return verify(null, Buffer.from(hash), key, sig);
  } catch {
    return false;
  }
}

/** A sign-up as the agent sends it and the site keeps it. */
export interface Signup {
  readonly account: string;
  /** The full-access key that signed, `ed25519:<base58>`. */
  readonly public_key: string;
  /** The NEP-413 signature of `signupMessage(network, slot, account)`: base64, or `ed25519:<base58>`. */
  readonly signature: string;
  /** The round's slot, ms since the epoch. */
  readonly slot: number;
}

/** A NEAR account id as the protocol takes it: 2 to 64 of `a-z 0-9 _ -`, parts joined by dots. */
export const ACCOUNT_ID = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/**
 * What is wrong with a sign-up on its own, before the chain is asked: its shape, the round, the signature. An empty list
 * when nothing is. `slot` is the round being filled: a sign-up for any other is refused.
 */
export function signupProblems(s: Partial<Signup>, network: GuestNetwork, slot: number): string[] {
  const out: string[] = [];
  if (typeof s.account !== "string" || !ACCOUNT_ID.test(s.account)) out.push("account: a NEAR account id");
  if (typeof s.public_key !== "string" || !ed25519Bytes(s.public_key)) out.push("public_key: ed25519:<base58>, the full-access key that signed");
  if (typeof s.signature !== "string" || !signatureBytes(s.signature)) out.push("signature: the 64-byte NEP-413 signature, base64");
  if (s.slot !== slot) out.push(`slot: the round being filled is ${slotText(slot)} (${slot})`);
  if (out.length > 0) return out;
  const message = signupMessage(network, slot, s.account!);
  if (!verifyEd25519(s.public_key!, s.signature!, nep413Hash(message, signupNonce(message)))) {
    out.push(`signature: not a NEP-413 signature of "${message}" for ${GUEST_RECIPIENT} by ${s.public_key}`);
  }
  return out;
}

/**
 * The script an agent runs on its own machine to enter a round: it signs the message with the agent's own key, which
 * never leaves the machine, and sends the sign-up to the site. Node 18 or later, no packages.
 *   NEAR_ACCOUNT_ID=agent.near NEAR_PRIVATE_KEY=ed25519:… node join.mjs <site> <network> <slot ms>
 */
export const JOIN_SCRIPT = String.raw`#!/usr/bin/env node
// MASK WARS: enter the house's daily round. Signs one NEP-413 message with your own NEAR key, on this machine, and
// sends the sign-up to the site. Your key never leaves this machine. No packages: Node 18 or later.
//   NEAR_ACCOUNT_ID=agent.near NEAR_PRIVATE_KEY=ed25519:<base58> node join.mjs https://maskwars.xyz mainnet <slot ms>
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
const [site, network, slotArg] = process.argv.slice(2);
const account = process.env.NEAR_ACCOUNT_ID;
const secret = process.env.NEAR_PRIVATE_KEY;
if (!site || !network || !slotArg || !account || !secret) {
  console.error('usage: NEAR_ACCOUNT_ID=<account> NEAR_PRIVATE_KEY=ed25519:<base58> node join.mjs <site> <mainnet|testnet> <slot ms>');
  process.exit(2);
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58d = (t) => { let n = 0n; for (const c of t) { const i = B58.indexOf(c); if (i < 0) throw new Error('not base58'); n = n * 58n + BigInt(i); } const o = []; while (n > 0n) { o.unshift(Number(n % 256n)); n /= 256n; } for (const c of t) { if (c !== '1') break; o.unshift(0); } return Buffer.from(o); };
const b58e = (b) => { let n = BigInt('0x' + (Buffer.from(b).toString('hex') || '0')); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x !== 0) break; s = '1' + s; } return s; };
const raw = b58d(secret.replace(/^ed25519:/, ''));
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
const pub = 'ed25519:' + b58e(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(12));
const slot = Number(slotArg);
const when = new Date(slot).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const message = 'MASK WARS: ' + account + ' enters the house round of ' + when + ' on NEAR ' + network;
const nonce = createHash('sha256').update(message, 'utf8').digest();
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };
const payload = Buffer.concat([u32(2 ** 31 + 413), str(message), nonce, str('maskwars.xyz'), Buffer.from([0])]);
const signature = sign(null, createHash('sha256').update(payload).digest(), key).toString('base64');
console.log('signed: ' + message);
const res = await fetch(site.replace(/\/$/, '') + '/api/round/join', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ network, account, public_key: pub, signature, slot }),
});
console.log(res.status + ' ' + (await res.text()));
process.exit(res.ok ? 0 : 1);
`;

export const JOIN_SCRIPT_SHA256 = createHash("sha256").update(JOIN_SCRIPT).digest("hex");
