/**
 * Shared test vectors: the same inputs and answers the Rust contract checks (`packages/core/vectors/*.json`). Built
 * from a fixed seed, so regenerating gives the same bytes. Amounts are decimal strings (u128 in Rust).
 */

import type { Settlement } from "./book.ts";
import { addBack, openBook, settle } from "./book.ts";
import type { Coin, DuelMove } from "./market-duel.ts";
import { BASKET, effectivePrimaries, samePrimaryLoser, scoreBp } from "./market-duel.ts";
import { fightSeal, identitySeal, preimage, SEAL_DOMAIN, strategySeal } from "./seal.ts";
import { toHex } from "./sha256.ts";

export const VECTOR_SEED = 0x4d41534b57415253n; // "MASKWARS"

/** SplitMix64: a small deterministic generator for vectors and property tests. */
export function splitmix64(seed: bigint): () => bigint {
  let state = BigInt.asUintN(64, seed);
  return () => {
    state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n);
    let z = state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  };
}

/** An integer in `[0, n)` from the generator. */
export const below = (next: () => bigint, n: bigint): bigint => next() % n;

export type BookVectorBack = { op_id: string; account: string; outcome: number; amount: string };

export type BookVector = {
  name: string;
  outcomes: number;
  rake_bps: number;
  winner: number;
  backs: BookVectorBack[];
  expect:
    | {
        kind: "paid";
        T: string;
        W: string;
        rake: string;
        D: string;
        payouts: { op_id: string; amount: string }[];
        dust: string;
        house: string;
        mask_share: string;
      }
    | { kind: "void"; reason: string; T: string; refunds: { op_id: string; amount: string }[] };
};

type BackSpec = [outcome: number, amount: bigint];

function bookVector(name: string, outcomes: number, rakeBps: number, winner: number, specs: readonly BackSpec[]): BookVector {
  let book = openBook({ id: name, kind: outcomes === 6 ? "season" : "main", outcomes, rakeBps });
  const backs: BookVectorBack[] = specs.map(([outcome, amount], i) => {
    const back = { op_id: `op-${i}`, account: `acc-${i % 7}.near`, outcome, amount: amount.toString() };
    book = addBack(book, { opId: back.op_id, account: back.account, outcome, amount });
    return back;
  });
  return { name, outcomes, rake_bps: rakeBps, winner, backs, expect: expectOf(settle(book, winner)) };
}

function expectOf(s: Settlement): BookVector["expect"] {
  if (s.kind === "void") {
    return { kind: "void", reason: s.reason, T: s.T.toString(), refunds: s.refunds.map((r) => ({ op_id: r.opId, amount: r.amount.toString() })) };
  }
  return {
    kind: "paid",
    T: s.T.toString(),
    W: s.W.toString(),
    rake: s.rake.toString(),
    D: s.D.toString(),
    payouts: s.payouts.map((p) => ({ op_id: p.opId, amount: p.amount.toString() })),
    dust: s.dust.toString(),
    house: s.house.toString(),
    mask_share: s.maskShare.toString(),
  };
}

const USDC = 1_000_000n;

export function buildBookVectors(seed: bigint = VECTOR_SEED): BookVector[] {
  const fixed: BookVector[] = [
    bookVector("even-2", 2, 500, 0, [[0, 10n * USDC], [1, 10n * USDC]]),
    bookVector("house-40-10-underdog-wins", 2, 500, 1, [[0, 40n * USDC], [1, 10n * USDC]]),
    bookVector("rake-capped-by-losing-side", 2, 500, 0, [[0, 1000n * USDC], [1, 1n * USDC]]),
    bookVector("dust-three-winners", 2, 500, 0, [[0, 1n], [0, 1n], [0, 1n], [1, 2n]]),
    bookVector("one-sided-void", 2, 500, 0, [[0, 5n * USDC], [0, 7n * USDC]]),
    bookVector("no-winner-backs-void", 2, 500, 1, [[0, 5n * USDC], [0, 7n * USDC]]),
    bookVector("empty-void", 2, 500, 0, []),
    bookVector("zero-rake", 2, 0, 1, [[0, 3n * USDC], [1, 2n * USDC], [1, 1n]]),
    bookVector("season-6-unpopular", 6, 500, 4, [[0, 50n * USDC], [1, 40n * USDC], [2, 30n * USDC], [3, 20n * USDC], [4, 1n * USDC], [5, 10n * USDC]]),
    bookVector("u128-scale", 2, 500, 1, [[0, 2n ** 100n], [1, 2n ** 99n + 12345n], [1, 3n]]),
  ];
  const next = splitmix64(seed);
  const random: BookVector[] = [];
  for (let i = 0; i < 40; i++) {
    const outcomes = i % 5 === 4 ? 6 : 2;
    const count = 1 + Number(below(next, 12n));
    const specs: BackSpec[] = [];
    for (let j = 0; j < count; j++) specs.push([Number(below(next, BigInt(outcomes))), 1n + below(next, 100n * USDC)]);
    const rakeBps = [500, 500, 500, 0, 250, 1000][Number(below(next, 6n))]!;
    random.push(bookVector(`random-${i}`, outcomes, rakeBps, Number(below(next, BigInt(outcomes))), specs));
  }
  return [...fixed, ...random];
}

export type ScoreVector = { name: string; start_usdc: string; final_usdc: string; called_it: boolean; score_bp: string };

export function buildScoreVectors(seed: bigint = VECTOR_SEED): ScoreVector[] {
  const cases: [string, bigint, bigint, boolean][] = [
    ["flat", 10n * USDC, 10n * USDC, false],
    ["flat-called", 10n * USDC, 10n * USDC, true],
    ["up-one-bp", 10n * USDC, 10n * USDC + 1000n, false],
    ["up-just-under-one-bp", 10n * USDC, 10n * USDC + 999n, false],
    ["down-one-unit-floors-to-minus-one", 10n * USDC, 10n * USDC - 1n, false],
    ["down-one-bp", 10n * USDC, 10n * USDC - 1000n, false],
    ["down-just-over-one-bp", 10n * USDC, 10n * USDC - 1001n, true],
    ["wiped-out", 10n * USDC, 0n, false],
    ["doubled", 10n * USDC, 20n * USDC, true],
    ["odd-start", 7n, 5n, false],
  ];
  const next = splitmix64(seed ^ 0x5c0e5n);
  for (let i = 0; i < 20; i++) {
    const start = 1n + below(next, 1000n * USDC);
    const move = below(next, start / 5n + 1n);
    const final = below(next, 2n) === 0n ? start + move : start - move;
    cases.push([`random-${i}`, start, final, below(next, 4n) === 0n]);
  }
  return cases.map(([name, start, final, called]) => ({
    name,
    start_usdc: start.toString(),
    final_usdc: final.toString(),
    called_it: called,
    score_bp: scoreBp(start, final, called).toString(),
  }));
}

export type SealVector = {
  name: string;
  kind: "seal" | "identity" | "strategy";
  /** The fields after the domain, in order. */
  fields: string[];
  domain: string;
  /** The exact hashed bytes, hex. */
  preimage_hex: string;
  sha256: string;
};

const SALTS = [
  "00".repeat(32),
  "ff".repeat(32),
  "0123456789abcdef".repeat(4),
] as const;

export function buildSealVectors(seed: bigint = VECTOR_SEED): SealVector[] {
  const next = splitmix64(seed ^ 0x5ea1n);
  const randomSalt = (): string => {
    let hex = "";
    for (let i = 0; i < 4; i++) hex += next().toString(16).padStart(16, "0");
    return hex;
  };
  const salts = [...SALTS, randomSalt(), randomSalt()];
  const out: SealVector[] = [];
  const moves: [string, string, string, DuelMove][] = [
    ["f-0-1", "onyx", salts[0]!, { primary: "BTC", backup: "ETH", call: "SOL" }],
    ["f-0-1", "nova", salts[1]!, { primary: "SOL", backup: "NEAR", call: "BTC" }],
    ["f-0-17", "oracle", salts[2]!, { primary: "ETH", backup: "BTC", call: "ETH" }],
    ["f-12-180", "wraith", salts[3]!, { primary: "ZEC", backup: "NEAR", call: "ZEC" }],
    ["f-0-2", "my-own-mask", salts[4]!, { primary: "NEAR", backup: "ZEC", call: "NEAR" }],
  ];
  for (const [fightId, maskId, salt, m] of moves) {
    const fields = [fightId, maskId, m.primary, m.backup, m.call, salt];
    out.push({
      name: `seal-${fightId}-${maskId}`,
      kind: "seal",
      fields,
      domain: SEAL_DOMAIN.seal,
      preimage_hex: toHex(preimage([SEAL_DOMAIN.seal, ...fields])),
      sha256: fightSeal(fightId, maskId, [m.primary, m.backup, m.call], salt),
    });
  }
  const identities: [string, string, string][] = [
    ["ronin", "deepseek-v3", salts[0]!],
    ["volt", "human", salts[3]!],
    ["oracle", "Ілля — жива людина ✓", salts[4]!],
  ];
  for (const [maskId, identity, salt] of identities) {
    const fields = [maskId, identity, salt];
    out.push({
      name: `identity-${maskId}`,
      kind: "identity",
      fields,
      domain: SEAL_DOMAIN.identity,
      preimage_hex: toHex(preimage([SEAL_DOMAIN.identity, ...fields])),
      sha256: identitySeal(maskId, identity, salt),
    });
  }
  const strategies: [string, string, string][] = [
    ["onyx", "Wait for the drawdown.", salts[1]!],
    ["nova", "", salts[2]!],
    ["wraith", "Line one\nLine two\twith a tab", salts[3]!],
  ];
  for (const [maskId, text, salt] of strategies) {
    const fields = [maskId, text, salt];
    out.push({
      name: `strategy-${maskId}-${text.length}`,
      kind: "strategy",
      fields,
      domain: SEAL_DOMAIN.strategy,
      preimage_hex: toHex(preimage([SEAL_DOMAIN.strategy, ...fields])),
      sha256: strategySeal(maskId, text, salt),
    });
  }
  return out;
}

export type SamePrimaryVector = {
  fight_id: string;
  left: DuelMove;
  right: DuelMove;
  takes_backup: 0 | 1 | null;
  effective: [Coin, Coin];
};

export function buildSamePrimaryVectors(): SamePrimaryVector[] {
  const out: SamePrimaryVector[] = [];
  for (let n = 1; n <= 12; n++) {
    const fightId = `f-0-${n}`;
    const coin = BASKET[n % BASKET.length]!;
    const left: DuelMove = { primary: coin, backup: BASKET[(n + 1) % BASKET.length]!, call: coin };
    const right: DuelMove = n % 4 === 0
      ? { primary: BASKET[(n + 2) % BASKET.length]!, backup: coin, call: coin }
      : { primary: coin, backup: BASKET[(n + 3) % BASKET.length]!, call: left.backup };
    out.push({
      fight_id: fightId,
      left,
      right,
      takes_backup: left.primary === right.primary ? samePrimaryLoser(fightId) : null,
      effective: effectivePrimaries(fightId, [left, right]),
    });
  }
  return out;
}

/** Every vector file: name → content. */
export function buildAllVectors(): Record<string, unknown> {
  return {
    "books.json": { spec: "docs/spec/fight.md#книга-парімутюель", seed: VECTOR_SEED.toString(), vectors: buildBookVectors() },
    "score.json": { spec: "docs/spec/fight.md#рахунок", seed: VECTOR_SEED.toString(), vectors: buildScoreVectors() },
    "seals.json": { spec: "docs/spec/fight.md#печатка", seed: VECTOR_SEED.toString(), vectors: buildSealVectors() },
    "same-primary.json": { spec: "docs/spec/fight.md#market-duel-v1", vectors: buildSamePrimaryVectors() },
  };
}

export const serializeVectors = (content: unknown): string => `${JSON.stringify(content, null, 2)}\n`;
