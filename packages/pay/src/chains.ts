import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { equal, fromBase58, hex, utf8 } from "./codec.ts";

/**
 * Where people hold money and want it back: the networks a vault takes money from and pays out to. A coin is named by
 * its symbol and, for a token, by its contract on that network: the asset id itself always comes from 1Click's own
 * token list (never built by hand), and a coin whose contract does not match is not offered at all.
 */

export type ChainId = "sol" | "base" | "eth" | "arb" | "tron" | "btc";

export interface CoinSpec {
  readonly symbol: string;
  /** The token's contract on its network. None: the network's own coin. */
  readonly contract?: string;
}

export interface Chain {
  readonly id: ChainId;
  readonly name: string;
  readonly coins: readonly CoinSpec[];
  /** How long a deposit address waits for a transfer, in minutes: long enough for the network to confirm it. */
  readonly window: number;
  /** What an address on this network looks like, for the field a person types it into. */
  readonly example: string;
}

export const CHAINS: readonly Chain[] = [
  {
    id: "sol",
    name: "Solana",
    coins: [{ symbol: "USDC", contract: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, { symbol: "SOL" }],
    window: 30,
    example: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  },
  {
    id: "base",
    name: "Base",
    coins: [{ symbol: "USDC", contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" }, { symbol: "ETH" }],
    window: 30,
    example: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
  },
  {
    id: "eth",
    name: "Ethereum",
    coins: [{ symbol: "USDC", contract: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" }, { symbol: "ETH" }],
    window: 40,
    example: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
  },
  {
    id: "arb",
    name: "Arbitrum",
    coins: [{ symbol: "USDC", contract: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" }, { symbol: "ETH" }],
    window: 30,
    example: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
  },
  {
    id: "tron",
    name: "Tron",
    coins: [{ symbol: "USDT", contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" }, { symbol: "TRX" }],
    window: 30,
    example: "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7",
  },
  {
    id: "btc",
    name: "Bitcoin",
    coins: [{ symbol: "BTC" }],
    window: 120,
    example: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  },
];

export function chainOf(id: string): Chain | null {
  return CHAINS.find((c) => c.id === id) ?? null;
}

/** Whether `text` is an address money can be sent to on `chain`, checksum included wherever the network has one. */
export function addressOk(chain: ChainId, text: string): boolean {
  const a = text.trim();
  switch (chain) {
    case "base":
    case "eth":
    case "arb":
      return evmOk(a);
    case "sol": {
      const bytes = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) ? fromBase58(a) : null;
      return bytes?.length === 32;
    }
    case "tron":
      return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) && base58CheckOk(a, [0x41]);
    case "btc":
      return /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(a) ? base58CheckOk(a, [0x00, 0x05]) : segwitOk(a);
  }
}

/** EIP-55: an all-lowercase or all-uppercase address has no checksum; a mixed-case one must match it. */
function evmOk(a: string): boolean {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const hash = hex(keccak_256(utf8(body.toLowerCase())));
  for (let i = 0; i < 40; i++) {
    const c = body[i]!;
    if (/[a-f]/i.test(c) && (parseInt(hash[i]!, 16) >= 8 ? c !== c.toUpperCase() : c !== c.toLowerCase())) return false;
  }
  return true;
}

/** A 25-byte base58check address with one of `versions` as its first byte (Tron, legacy Bitcoin). */
function base58CheckOk(a: string, versions: readonly number[]): boolean {
  const bytes = fromBase58(a);
  if (!bytes || bytes.length !== 25 || !versions.includes(bytes[0]!)) return false;
  const check = sha256(sha256(bytes.subarray(0, 21))).subarray(0, 4);
  return equal(check, bytes.subarray(21));
}

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk >>> 0;
}

/** Native segwit on Bitcoin mainnet: v0 in bech32 (`bc1q…`), v1+ in bech32m (`bc1p…`), BIP-173 and BIP-350. */
function segwitOk(text: string): boolean {
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return false;
  const a = text.toLowerCase();
  if (!a.startsWith("bc1") || a.length < 14 || a.length > 74) return false;
  const data = [...a.slice(3)].map((c) => BECH32.indexOf(c));
  if (data.some((d) => d < 0)) return false;
  const hrp = [..."bc"].map((c) => c.charCodeAt(0));
  const check = polymod([...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data]);
  const version = data[0]!;
  if (version > 16) return false;
  if (check !== (version === 0 ? 1 : 0x2bc830a3)) return false;
  // The witness program, regrouped from 5-bit words to bytes: 20 or 32 bytes for v0, 2 to 40 for later versions.
  const words = data.slice(1, -6);
  const bits = words.length * 5;
  if (bits % 8 >= 5 || (words.length > 0 && (words.at(-1)! & ((1 << (bits % 8)) - 1)) !== 0)) return false;
  const bytes = Math.floor(bits / 8);
  if (version === 0) return bytes === 20 || bytes === 32;
  return bytes >= 2 && bytes <= 40;
}
