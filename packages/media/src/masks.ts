/** Season 0 masks and the art frames cards and clips are built from (`brand/art/web`). */

export type Mask = {
  id: string;
  name: string;
  /** File in `brand/art/web`, without `.jpg`. */
  art: string;
  /** Eye light, for the clip's accent only; never a fill. */
  eyes: string;
};

export const SEASON_0: readonly Mask[] = [
  { id: "onyx", name: "ONYX", art: "onyx", eyes: "#ff8a3d" },
  { id: "nova", name: "NOVA", art: "nova", eyes: "#c9b5ff" },
  { id: "oracle", name: "ORACLE", art: "oracle", eyes: "#ffb23f" },
  { id: "wraith", name: "WRAITH", art: "wraith", eyes: "#bfe4ff" },
  { id: "ronin", name: "RONIN", art: "ronin", eyes: "#ff3b3b" },
  { id: "volt", name: "VOLT", art: "volt", eyes: "#c6ff3d" },
];

/** Frames that exist in `brand/art/web`. */
export const ART = ["arena", "faceoff", "nova", "obsidian", "onyx", "oracle", "ring", "ronin", "stand", "unmask", "volt", "wraith"] as const;
export type Art = (typeof ART)[number];

export const isArt = (x: string): x is Art => (ART as readonly string[]).includes(x);

export function mask(id: string): Mask {
  const m = SEASON_0.find((x) => x.id === id);
  if (!m) throw new Error(`unknown mask: ${id}`);
  return m;
}

export const isSeasonMask = (id: string): boolean => SEASON_0.some((x) => x.id === id);
