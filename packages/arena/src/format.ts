// Numbers as the arena shows them. NEAR is never rounded up: a screen never shows more than was paid.

const YOCTO = 10n ** 24n;

/** `1.087` from yoctoNEAR: 3 decimals from 1 NEAR, 4 significant digits below it, trailing zeros dropped. */
export function near(yocto: string | bigint | null | undefined): string {
  if (yocto === null || yocto === undefined || yocto === "") return "0";
  const n = typeof yocto === "bigint" ? yocto : BigInt(yocto);
  if (n <= 0n) return "0";
  const whole = n / YOCTO;
  let decimals = whole >= 100n ? 0 : whole >= 10n ? 1 : 3;
  if (whole === 0n) {
    // Below 1 NEAR: keep 3 significant digits after the leading zeros, at most 6 decimals.
    const frac = (n % YOCTO).toString().padStart(24, "0");
    const lead = frac.search(/[1-9]/);
    decimals = Math.min(6, Math.max(3, lead + 3));
  }
  const scale = 10n ** BigInt(24 - decimals);
  const cut = n / scale;
  const s = cut.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals) || "0";
  const dec = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec ? `${grouped}.${dec}` : grouped;
}

/** 8:13 for minutes, 1:04:09 past an hour, 3 d 4 h for days. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** A race number from its id: `race-0003` → `0003`. Any other id stays as it is. */
export function raceNo(id: string): string {
  const m = /^race-(\d+)$/.exec(id);
  if (m) return m[1]!;
  // A round with the people's masks, `human-0001`: H0001, short enough for a row.
  const h = /^human-(\d+)$/.exec(id);
  return h ? `H${h[1]!}` : id;
}
