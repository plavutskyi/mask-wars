import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58, concat, fromBase58, utf8 } from "./codec.ts";

/**
 * Paying a Get NEAR deposit address from a Solana wallet in the browser (Wallet Standard,
 * `solana:signAndSendTransaction`): one legacy transaction, built here byte by byte, that the wallet signs and sends.
 * SOL is a System transfer. A token goes from the payer's associated token account to the deposit address's, which the
 * same transaction creates if it is not there yet (`CreateIdempotent`), then `TransferChecked` with the mint's decimals,
 * so a wrong amount scale cannot slip through. Classic SPL tokens and Token-2022 alike: the mint's owner names the
 * program.
 */

export const SYSTEM_PROGRAM = "11111111111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

/** A Solana address as its 32 bytes, or `null`. */
export function solanaKey(address: string): Uint8Array | null {
  const b = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) ? fromBase58(address) : null;
  return b?.length === 32 ? b : null;
}

function key(address: string): Uint8Array {
  const b = solanaKey(address);
  if (!b) throw new Error(`not a Solana address: ${address}`);
  return b;
}

function onCurve(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `address` is a Solana wallet: 32 bytes on the ed25519 curve, so a key can sign for it. A token account (an
 * associated token account is a program address, off the curve) or a program-derived vault is not one: a coin sent
 * "to" it would be sent to an account nobody's wallet opens.
 */
export function solanaWalletOk(address: string): boolean {
  const b = solanaKey(address.trim());
  return b !== null && onCurve(b);
}

/** `findProgramAddress`: the first bump from 255 down whose address is off the curve. */
export function programAddress(seeds: readonly Uint8Array[], program: string): string {
  const id = key(program);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat(...seeds, Uint8Array.of(bump), id, utf8("ProgramDerivedAddress")));
    if (!onCurve(h)) return base58(h);
  }
  throw new Error("no program address");
}

/** The associated token account of `owner` for `mint` under `tokenProgram`. */
export function associatedTokenAccount(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): string {
  return programAddress([key(owner), key(tokenProgram), key(mint)], ATA_PROGRAM);
}

/** Solana's compact-u16 length. */
function shortvec(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v) b |= 0x80;
    out.push(b);
    if (!v) return Uint8Array.from(out);
  }
}

const u64 = (n: bigint) => {
  if (n < 0n || n >= 2n ** 64n) throw new Error("amount out of range");
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};

interface Ix {
  readonly program: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
}

/**
 * A legacy transaction with one signer, `payer`, and an empty signature for the wallet to fill. `writable` lists the
 * other accounts the instructions write; everything else is read-only.
 */
function legacyTx(payer: string, writable: readonly string[], ixs: readonly Ix[], blockhash: string): Uint8Array {
  const rest: string[] = [];
  for (const ix of ixs) for (const a of [...ix.accounts, ix.program]) if (a !== payer && !writable.includes(a) && !rest.includes(a)) rest.push(a);
  const keys = [payer, ...writable, ...rest];
  const index = (a: string) => {
    const i = keys.indexOf(a);
    if (i < 0) throw new Error(`account not listed: ${a}`);
    return i;
  };
  const message = concat(
    Uint8Array.of(1, 0, rest.length),
    shortvec(keys.length),
    ...keys.map(key),
    key(blockhash),
    shortvec(ixs.length),
    ...ixs.map((ix) => concat(Uint8Array.of(index(ix.program)), shortvec(ix.accounts.length), Uint8Array.from(ix.accounts.map(index)), shortvec(ix.data.length), ix.data)),
  );
  return concat(shortvec(1), new Uint8Array(64), message);
}

export type SolanaAsset = { readonly kind: "sol" } | { readonly kind: "token"; readonly mint: string; readonly decimals: number; readonly tokenProgram: string };

/** The one transaction that pays `amount` of the coin from `payer` to the deposit address. */
export function solanaPayment(o: { asset: SolanaAsset; payer: string; depositAddress: string; amount: bigint; blockhash: string }): Uint8Array {
  if (o.amount <= 0n) throw new Error("amount must be positive");
  if (o.payer === o.depositAddress) throw new Error("paying itself");
  key(o.payer);
  key(o.depositAddress);
  if (o.asset.kind === "sol") {
    const data = concat(Uint8Array.of(2, 0, 0, 0), u64(o.amount));
    return legacyTx(o.payer, [o.depositAddress], [{ program: SYSTEM_PROGRAM, accounts: [o.payer, o.depositAddress], data }], o.blockhash);
  }
  const { mint, decimals, tokenProgram } = o.asset;
  if (tokenProgram !== TOKEN_PROGRAM && tokenProgram !== TOKEN_2022_PROGRAM) throw new Error(`not a token program: ${tokenProgram}`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("decimals out of range");
  const source = associatedTokenAccount(o.payer, mint, tokenProgram);
  const dest = associatedTokenAccount(o.depositAddress, mint, tokenProgram);
  const create: Ix = { program: ATA_PROGRAM, accounts: [o.payer, dest, o.depositAddress, mint, SYSTEM_PROGRAM, tokenProgram], data: Uint8Array.of(1) };
  const transfer: Ix = { program: tokenProgram, accounts: [source, mint, dest, o.payer], data: concat(Uint8Array.of(12), u64(o.amount), Uint8Array.of(decimals)) };
  return legacyTx(o.payer, [source, dest], [create, transfer], o.blockhash);
}

/** A mint's decimals from its account data (base64): byte 44 of the SPL mint layout, the same in Token-2022. */
export function mintDecimals(dataBase64: string): number | null {
  try {
    const raw = Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0));
    return raw.length >= 82 ? raw[44]! : null;
  } catch {
    return null;
  }
}

/** A signature a wallet returned, as Solana's explorers name it. */
export function solanaSignature(sig: Uint8Array | string): string | null {
  if (typeof sig === "string") return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig) ? sig : null;
  return sig.length === 64 ? base58(sig) : null;
}
