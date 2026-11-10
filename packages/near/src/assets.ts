// Ідентифікатори активів. Символ не унікальний: лише assetId.

/** Нативний USDC на NEAR (Circle). */
export const USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
/** BTC усередині Intents, маршрут із ліквідністю (дослідження 01, §2.2). */
export const BTC = "nep141:nbtc.bridge.near";
export const ETH = "nep141:eth.omft.near";
export const SOL = "nep141:sol.omft.near";
export const WNEAR = "nep141:wrap.near";
export const ZEC = "nep141:zec.omft.near";

export const INTENTS_CONTRACT = "intents.near";

export const DECIMALS: Readonly<Record<string, number>> = {
  [USDC]: 6,
  [BTC]: 8,
  [ETH]: 18,
  [SOL]: 9,
  [WNEAR]: 24,
  [ZEC]: 8,
};

/** Сума в мінімальних одиницях з десяткового рядка, без float. */
export function toAtomic(amount: string, decimals: number): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new Error(`not a decimal amount: ${amount}`);
  const whole = match[1] ?? "0";
  const frac = (match[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || "0")).toString();
}

export function fromAtomic(raw: string, decimals: number): string {
  const value = BigInt(raw);
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${sign}${abs / base}${frac ? `.${frac}` : ""}`;
}
