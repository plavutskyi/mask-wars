/**
 * The OutLayer payment key that pays for the runs of the people's minds (`OUTLAYER_PAYMENT_KEY`, `owner:nonce:secret`):
 * what is left on it, for the day's report. It is read from OutLayer's public balance by the key's owner and number,
 * never by the key itself, so nothing secret leaves the job. Nothing here tops the key up: the owner does that by hand
 * with the OutLayer CLI, and the report says when and how. The key's money is dollars of the stablecoin OutLayer takes
 * (USDC on NEAR mainnet), never NEAR: the top-up is `outlayer keys topup <number> --usd <amount>`, from the owner's USDC.
 */

/** OutLayer counts a key's money in the stablecoin's minimal units: 1 000 000 is $1. */
const MICRO = 1_000_000;
/** What the owner adds when the key runs low, in dollars: the same top-up the forge planned (scripts/mainnet/forge.mjs RUNS_TOPUP_USD). */
export const TOPUP_USD = 3;

/** A key's owner and number, from the key `owner:nonce:secret`; null when it does not read as one. */
export function keyRef(key: string): { owner: string; nonce: number } | null {
  const m = /^([a-z0-9][a-z0-9._-]*):(\d{1,9}):\S+$/.exec(key.trim());
  return m ? { owner: m[1]!, nonce: Number(m[2]) } : null;
}

/** What is left on a key, in dollars. */
export interface KeyBalance {
  readonly owner: string;
  readonly nonce: number;
  readonly initialUsd: number;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly availableUsd: number;
  readonly lastUsedAt: string | null;
}

const usd = (v: unknown): number => {
  const n = Number(typeof v === "string" || typeof v === "number" ? v : NaN);
  return Number.isFinite(n) ? n / MICRO : NaN;
};

/** The key's balance from OutLayer's public `GET /public/payment-keys/{owner}/{nonce}/balance`; null when it does not answer. */
export async function readKeyBalance(api: string, ref: { owner: string; nonce: number }, get: typeof fetch = fetch): Promise<KeyBalance | null> {
  const url = `${api.replace(/\/$/, "")}/public/payment-keys/${encodeURIComponent(ref.owner)}/${ref.nonce}/balance`;
  try {
    const res = await get(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const b = (await res.json()) as Record<string, unknown>;
    const out = {
      owner: ref.owner,
      nonce: ref.nonce,
      initialUsd: usd(b.initial_balance),
      spentUsd: usd(b.spent),
      reservedUsd: usd(b.reserved ?? "0"),
      availableUsd: usd(b.available),
      lastUsedAt: typeof b.last_used_at === "string" ? b.last_used_at : null,
    };
    return Number.isFinite(out.availableUsd) && Number.isFinite(out.initialUsd) ? out : null;
  } catch {
    return null;
  }
}

/** Low: nothing left, or less than a quarter of what the key was first funded with (OutLayer's `initial_balance` is the key's first top-up). */
export const keyLow = (b: KeyBalance): boolean => b.availableUsd <= 0 || b.availableUsd < b.initialUsd / 4;

const dollars = (n: number) => `$${n.toFixed(2)}`;

/**
 * The step the owner takes to top the key up: by hand, signed as the key's owner, in dollars of USDC the owner's
 * account already holds. Nothing does it on its own.
 */
export const topUpStep = (ref: { owner: string; nonce: number }): string =>
  `top it up by hand: \`outlayer login\` as ${ref.owner}, then \`outlayer keys topup ${ref.nonce} --usd ${TOPUP_USD}\` ($${TOPUP_USD} of USDC from ${ref.owner}, which holds them first; check with \`outlayer keys balance ${ref.nonce}\`)`;

/** The report's lines on the key: what is left, and the owner's step when it runs low or cannot be read. */
export function keyReport(ref: { owner: string; nonce: number } | null, b: KeyBalance | null): { lines: string[]; low: boolean } {
  if (!ref) return { lines: ["- people's minds: OUTLAYER_PAYMENT_KEY does not read as `owner:nonce:secret`: their runs on OutLayer cannot be paid"], low: true };
  const name = `${ref.owner}:${ref.nonce}`;
  if (!b) return { lines: [`- people's minds: the balance of payment key ${name} could not be read from OutLayer; if it ran dry, ${topUpStep(ref)}`], low: false };
  const low = keyLow(b);
  const left = `- people's minds: payment key ${name} holds ${dollars(b.availableUsd)} of ${dollars(b.initialUsd)} (spent ${dollars(b.spentUsd)}${b.reservedUsd > 0 ? `, ${dollars(b.reservedUsd)} held for runs on now` : ""})`;
  return { lines: low ? [`${left}. **Low**: ${topUpStep(ref)}`] : [left], low };
}
