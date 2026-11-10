/**
 * The model proposes; this file disposes. A proposal is parsed with zod, then checked against the basket, the mask's
 * manner and the rules of Market Duel v1 (docs/spec/fight.md). Anything that does not pass becomes the mask's default
 * move, never a failed fight.
 */
import { z } from "zod";
import { BASKET, MANNERS, isCoin, type Coin, type MaskId } from "./masks.ts";
import { byDrawdown, byMomentum, type MarketSnapshot } from "./market.ts";

const coin = z.enum(BASKET);

/** Before the bell: own coin, backup, and a guess at the rival's coin. */
export const SealProposal = z
  .object({
    primary: coin,
    backup: coin,
    call: coin,
  })
  .strict();
export type SealProposal = z.infer<typeof SealProposal>;

/** Every minute of the fight: hold, or rotate once into another coin. */
export const MinuteProposal = z.discriminatedUnion("action", [
  z.object({ action: z.literal("HOLD") }).strict(),
  z.object({ action: z.literal("ROTATE"), coin }).strict(),
]);
export type MinuteProposal = z.infer<typeof MinuteProposal>;

export interface SealContext {
  readonly mask: MaskId;
  readonly rival: MaskId;
  readonly market: MarketSnapshot;
}

export interface MinuteContext {
  readonly mask: MaskId;
  readonly rival: MaskId;
  readonly market: MarketSnapshot;
  /** Coin the mask holds now. */
  readonly holding: Coin;
  /** Coin the rival holds now (public after the bell). */
  readonly rivalHolding: Coin;
  /** True once the mask has used its one ROTATE. */
  readonly rotated: boolean;
  /** Own live score minus the rival's, in points (basis points). */
  readonly lead: number;
  /** Minute of the fight, 1..4. */
  readonly minute: number;
}

/** The coin a mask with this open manner most likely opens with. Public manners make this a fair guess. */
export function likelyPrimary(mask: MaskId, market: MarketSnapshot): Coin {
  const allowed = MANNERS[mask].coins;
  switch (mask) {
    case "onyx":
      return byDrawdown(market, allowed)[0]!;
    case "wraith":
      // Against the crowd: the coin the tape likes least that is not in a free fall.
      return byMomentum(market, allowed).at(-1)!;
    default:
      return byMomentum(market, allowed)[0]!;
  }
}

/** The seal a mask plays when the model is silent, late or wrong. Pure function of manner and market. */
export function defaultSeal(ctx: SealContext): SealProposal {
  const allowed = MANNERS[ctx.mask].coins;
  const rivalGuess = likelyPrimary(ctx.rival, ctx.market);
  let order: Coin[];
  switch (ctx.mask) {
    case "onyx":
      order = byDrawdown(ctx.market, allowed);
      break;
    case "wraith": {
      // Never stand where the rival stands.
      const rest = byMomentum(ctx.market, allowed).reverse();
      order = [...rest.filter((c) => c !== rivalGuess), rivalGuess];
      break;
    }
    default:
      order = byMomentum(ctx.market, allowed);
  }
  return { primary: order[0]!, backup: order[1]!, call: rivalGuess };
}

/** The minute move a mask plays when the model is silent, late or wrong. */
export function defaultMinute(ctx: MinuteContext): MinuteProposal {
  if (ctx.rotated) return { action: "HOLD" };
  const allowed = MANNERS[ctx.mask].coins.filter((c) => c !== ctx.holding);
  const momentum = byMomentum(ctx.market, allowed);
  const own = ctx.market.coins[ctx.holding];
  switch (ctx.mask) {
    case "volt":
      return { action: "ROTATE", coin: momentum[0]! };
    case "nova": {
      const best = momentum[0]!;
      return ctx.market.coins[best].m5 - own.m5 >= 15 ? { action: "ROTATE", coin: best } : { action: "HOLD" };
    }
    case "wraith": {
      if (ctx.lead >= 0) return { action: "HOLD" };
      const away = momentum.find((c) => c !== ctx.rivalHolding);
      return away ? { action: "ROTATE", coin: away } : { action: "HOLD" };
    }
    case "onyx": {
      const dip = byDrawdown(ctx.market, allowed)[0]!;
      return ctx.market.coins[dip].m5 <= -40 && own.m5 >= 0 ? { action: "ROTATE", coin: dip } : { action: "HOLD" };
    }
    case "oracle":
    case "ronin": {
      const other = allowed[0]!;
      return ctx.market.coins[other].h1 - own.h1 >= 30 ? { action: "ROTATE", coin: other } : { action: "HOLD" };
    }
  }
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Rules a sealed move must obey, beyond its shape. */
export function checkSeal(mask: MaskId, proposal: SealProposal): Checked<SealProposal> {
  const allowed = MANNERS[mask].coins;
  if (!allowed.includes(proposal.primary)) return { ok: false, reason: `primary ${proposal.primary} outside manner` };
  if (!allowed.includes(proposal.backup)) return { ok: false, reason: `backup ${proposal.backup} outside manner` };
  if (proposal.backup === proposal.primary) return { ok: false, reason: "backup equals primary" };
  return { ok: true, value: proposal };
}

/** Rules a minute move must obey, beyond its shape. */
export function checkMinute(ctx: MinuteContext, proposal: MinuteProposal): Checked<MinuteProposal> {
  if (proposal.action === "HOLD") return { ok: true, value: proposal };
  if (ctx.rotated) return { ok: false, reason: "rotate already used" };
  if (!isCoin(proposal.coin)) return { ok: false, reason: "coin outside basket" };
  if (proposal.coin === ctx.holding) return { ok: false, reason: "rotate into the coin already held" };
  if (!MANNERS[ctx.mask].coins.includes(proposal.coin)) return { ok: false, reason: `${proposal.coin} outside manner` };
  return { ok: true, value: proposal };
}

/**
 * Pull the first JSON object out of a model's text. Models wrap JSON in prose or fences; we take the first balanced
 * object and nothing else.
 */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Model text to a checked seal, or the reason it was refused. Coins are upper-cased first; nothing else is forgiven. */
export function readSeal(mask: MaskId, text: string): Checked<SealProposal> {
  const parsed = SealProposal.safeParse(upperCoins(extractJson(text), ["primary", "backup", "call"]));
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  return checkSeal(mask, parsed.data);
}

/** Model text to a checked minute move, or the reason it was refused. */
export function readMinute(ctx: MinuteContext, text: string): Checked<MinuteProposal> {
  const raw = upperCoins(extractJson(text), ["action", "coin"]);
  const parsed = MinuteProposal.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  return checkMinute(ctx, parsed.data);
}

function upperCoins(value: unknown, keys: readonly string[]): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const k of keys) if (typeof out[k] === "string") out[k] = (out[k] as string).trim().toUpperCase();
  return out;
}
