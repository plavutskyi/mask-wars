/**
 * The demo film, the timeline: one story in 71 s, 1920×1080, 30 frames a second, cut on the bars of the long film's own
 * track (`audio/promo-150.mp3`, 128 BPM). A person forges a mask, it lines up for the daily round, the round runs by
 * itself, a mask breaks the vault and the contract pays, forge yours.
 *
 * Pure: the bars, the words and the forge's taps. Every number and every name in the words is read from one file,
 * `data.json` of the round (the site's own `/api/races/<id>` and `/api/races/league`), so another round is another
 * argument and nothing here names a winner.
 */

import { near } from "@maskwars/arena/format";

export const DEMO = { id: "Demo", width: 1920, height: 1080, fps: 30, bpm: 128, bars: 38 } as const;
export const BEAT_S = 60 / DEMO.bpm;
export const BAR_S = 4 * BEAT_S;
/** The first frame of a bar (bars may be fractional: a beat is a quarter). */
export const barFrame = (bar: number): number => Math.round(bar * BAR_S * DEMO.fps);
export const DURATION = barFrame(DEMO.bars);

/** A page filmed under a caption bar: the picture is 1920×880, the bar the 200 px under it. */
export const BAR_H = 200;
export const REGION_H = DEMO.height - BAR_H;
/** The smallest type the film sets, px at 1080p: a phone in the X feed still reads it. */
export const MIN_TYPE = 44;

/** Where each part of the story starts, in bars. The vault breaks on the track's drop, bar 17. */
export const AT = {
  hook: 0,
  hook2: 1.5,
  forge: 2.5,
  mask: 10.5,
  lineup: 12,
  loaded: 13,
  sealed: 14.5,
  window: 16,
  result: 17,
  after: 19,
  league: 25,
  top: 27,
  call: 29,
  near: 31,
  agent: 33,
  end: 35,
  url: 36,
} as const;

/**
 * The music as the film cuts it, in seconds of the track: bars 0–35 as they are, then the finale's impact (bar 72) for
 * one bar and its last hit (bar 76) with the tail. Each piece starts a breath before its downbeat, so a hit is whole.
 */
export const MUSIC_CUT: readonly (readonly [number, number])[] = [
  [0, AT.end * BAR_S + 0.02],
  [72 * BAR_S + 0.02, 73 * BAR_S + 0.02],
  [76 * BAR_S + 0.02, 76 * BAR_S + 0.02 + (DEMO.bars - AT.url) * BAR_S + 0.5],
];

// ——— The forge: what a person taps, and when ———

export type ForgeStep = "Face" | "Mind" | "Style" | "Plan" | "Fuel" | "Name";

export type ForgeAct =
  /** A tap on a choice of the step, by the words on it. */
  | { beat: number; step: ForgeStep; tap: string }
  /** A tap on the step's button: Next, never Forge. */
  | { beat: number; step: ForgeStep; next: true }
  /** Letters typed into the step's field, one keystroke every `every` frames from this beat. */
  | { beat: number; step: ForgeStep; type: "plan" | "name"; every: number };

/** The line typed as the plan: the forge's own example. A real plan is sealed, and nobody has read one. */
export const FORGE_PLAN = "Wait for the window. Then take it all.";

/** Frames between two letters of the name: under the page's 300 ms pause before it asks the chain. */
export const NAME_EVERY = 7;
export const FORGE_BEATS = (AT.mask - AT.forge) * 4;
/** The film frame a beat of the forge falls on, counted from the forge's first frame. */
export const forgeFrame = (beat: number): number => barFrame(AT.forge + beat / 4) - barFrame(AT.forge);
export const FORGE_FRAMES = forgeFrame(FORGE_BEATS);

/**
 * The forge as it is filmed: the mask a person really forged (porcelain, Qwen 3.8 27B, Fast, a sealed plan, 1 NEAR),
 * step by step on the beat, up to its name. The last letter lands six frames before the cut: the film never presses
 * Forge, so no wallet opens and nothing is signed.
 */
export function forgeActs(name: string): ForgeAct[] {
  const lastLetter = FORGE_FRAMES - 6;
  const firstLetter = lastLetter - (name.length - 1) * NAME_EVERY;
  return [
    { beat: 2, step: "Face", tap: "Crimson" },
    { beat: 3, step: "Face", tap: "Graphite" },
    { beat: 4, step: "Face", tap: "Porcelain" },
    { beat: 6, step: "Face", next: true },
    { beat: 8, step: "Mind", tap: "Qwen" },
    { beat: 11, step: "Mind", next: true },
    { beat: 13, step: "Style", tap: "Fast" },
    { beat: 15, step: "Style", next: true },
    { beat: 16, step: "Plan", type: "plan", every: 2 },
    { beat: 22, step: "Plan", next: true },
    { beat: 24, step: "Fuel", tap: "1 NEAR" },
    { beat: 27, step: "Fuel", next: true },
    { beat: (firstLetter / FORGE_FRAMES) * FORGE_BEATS, step: "Name", type: "name", every: NAME_EVERY },
  ];
}

/** The words under each step of the forge, from the beat its step comes on screen. */
export const FORGE_WORDS: readonly { beat: number; kicker: string; head: string }[] = [
  { beat: 0, kicker: "Forge · 1 of 6", head: "Pick a face" },
  { beat: 6, kicker: "Forge · 2 of 6", head: "Give it a mind" },
  { beat: 11, kicker: "Forge · 3 of 6", head: "Choose its style" },
  { beat: 15, kicker: "Forge · 4 of 6 · sealed in a TEE", head: "Write its secret plan" },
  { beat: 22, kicker: "Forge · 5 of 6", head: "Fuel it with NEAR" },
  { beat: 27, kicker: "Forge · 6 of 6", head: "Name it" },
];

// ——— The data: one file a round ———

export type Who = { account: string; slug: string | null; name: string; mask: boolean };
export type RaceEvent = { kind: string; at: number; tx?: string; who: Who | null; amount: string | null; ok: boolean; early?: boolean };
/** A round as the site's `/api/races/<id>` gives it; only what the film reads. */
export type Race = {
  id: string;
  network: string;
  phase: "sealing" | "racing" | "broken" | "held";
  bounty: string;
  safeFunded: string | null;
  openedAt: number | null;
  startsAt: number | null;
  sealUntil: number | null;
  masks: Who[];
  winner: Who | null;
  brokeAt: number | null;
  breakMs: number | null;
  loot: string | null;
  payout: { amount: string; at: number | null } | null;
  refund: { amount: string } | null;
  takes: string | null;
  prize: string;
  events: RaceEvent[];
};
export type LeagueRow = { who: Who; races: number; breaks: number; earned: string; history: { id: string }[] };

/** A box on a page, in the page's own px. */
export type Rect = { x: number; y: number; w: number; h: number };
export type Tap = { frame: number; x: number; y: number };

export type DemoData = {
  /** The round the film tells. */
  id: string;
  /** The person's mask the film forges and follows, as its page is named: `dmytro`. */
  mask: string;
  /** The site the pages were filmed on, and when. */
  site: string;
  capturedAt: number;
  race: Race;
  league: LeagueRow[];
  /** What the mask's own page said: its day of forging and its state, in the page's words. */
  maskPage: { forged: string | null; state: string | null };
  /** Where things stand on the filmed pages, so the camera finds a row whatever the round holds. */
  boxes: {
    race: { hero: Rect; rows: (Rect & { kind: string; breaks: boolean })[] };
    league: { table: Rect; rows: Rect[]; forged: Rect | null; forgedRow: Rect | null };
    mask: { hero: Rect };
    home: { picks: Rect | null };
    /** How many networks the page says it takes coins from, in the page's own number. */
    near: { networks: number | null };
    connect: { code: Rect | null; panel: Rect | null };
  };
  /** The forge as filmed: the taps, in px of its 1920×880 reel, and the frame each landed on. */
  forge: { frames: number; taps: Tap[] };
  /** Frames in the home page's reel. */
  home: { frames: number };
};

// ——— The words, from the data ———

export type Tint = "ice" | "money" | "amber";
export type Caption = { kicker?: string; head: string; tint?: Tint; count?: { to: string; prefix?: string; unit?: string } };
/** A caption of the round with the row of the round's page it stands on; `hero` is the page's own headline. */
export type RoundLine = Caption & { row: string };

export type Story = {
  roundNo: number;
  outcome: "broken" | "held" | "open";
  /** The person's mask in capitals, and whether it is among the round's masks. */
  person: string;
  inRound: boolean;
  mask: Caption;
  lineup: Caption;
  loaded: RoundLine;
  sealed: RoundLine;
  window: Caption;
  /** The round's result over the page's headline: the line under it is the film's. */
  result: Caption & { sub?: string };
  /** One to three lines after the result, each on its row. */
  after: RoundLine[];
  league: Caption;
  top: Caption;
  /** The first winner's place in the league as the site lists it, or -1 while no vault is broken. */
  topIndex: number;
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayOf = (ms: number): string => `${new Date(ms).getUTCDate()} ${MONTHS[new Date(ms).getUTCMonth()]}`;
const hm = (ms: number): string => new Date(ms).toISOString().slice(11, 16);
const hms = (ms: number): string => new Date(ms).toISOString().slice(11, 19);

/** A span in words a person says: `14 seconds`, `1 second`, `2 min 05 s`, `1 h 04 min`. Cut, never rounded up. */
export function spell(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} second${s === 1 ? "" : "s"}`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} min`;
}

/** The round's number as people say it: `race-0004` is round 4, `s1-0002-7c41e9` round 2. */
export function roundNo(id: string): number {
  const m = /^race-(\d+)$/.exec(id) ?? /^s\d+-(\d+)-/.exec(id) ?? /(\d+)/.exec(id);
  return m ? Number(m[1]) : 0;
}

/** A mask a person forged: its account sits under the mask factory, `dmytro.masks.maskwars.near`. */
export const forgedByPerson = (w: Who | null): boolean => w !== null && /^[^.]+\.masks\./.test(w.account);

const list = (names: string[]): string => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export function story(d: DemoData): Story {
  const r = d.race;
  const no = roundNo(r.id);
  const person = d.mask.toUpperCase();
  const inRound = r.masks.some((m) => m.name.toUpperCase() === person);
  const day = dayOf(r.openedAt ?? r.startsAt ?? d.capturedAt);
  const round = `Round ${no} · ${day}`;
  const sealedRound = r.sealUntil !== null;
  const count = (yocto: string, prefix = ""): NonNullable<Caption["count"]> => ({ to: near(yocto), prefix, unit: " NEAR" });

  const ready = /ready to race/i.test(d.maskPage.state ?? "");
  const mask: Caption = {
    kicker: [d.maskPage.forged ? d.maskPage.forged.replace(/^forged/i, "Forged") : "Forged", `NEAR ${r.network}`].join(" · "),
    head: ready ? `${person} is ready to race` : `${person} is forged`,
  };
  const lineup: Caption = inRound ? { kicker: round, head: `${person} is in the round` } : { kicker: "A new round every day", head: "It lines up for the daily round" };

  const fund = r.events.find((e) => e.kind === "fund");
  const open = r.events.find((e) => e.kind === "open");
  const loadedAt = fund?.at ?? open?.at ?? r.openedAt;
  const loaded: RoundLine = {
    row: fund ? "fund" : "open",
    kicker: [round, loadedAt ? `${hm(loadedAt)} UTC` : null].filter(Boolean).join(" · "),
    head: `${near(r.safeFunded ?? r.prize)} NEAR in the vault`,
  };

  const seals = r.events.filter((e) => e.kind === "seal" && e.ok);
  const sealers = [...new Set(seals.map((e) => e.who?.name ?? "A mask"))];
  const sealed: RoundLine = seals.length
    ? {
        row: "seal",
        kicker: `${hm(seals[0]!.at)} UTC · nobody sees the move`,
        head: sealers.length === 1 ? `${sealers[0]} seals its plan` : sealers.length <= 3 ? `${list(sealers)} seal their plans` : `${sealers.length} masks seal their plans`,
      }
    : { row: sealedRound ? "open" : loaded.row, kicker: plural(r.masks.length, "mask"), head: sealedRound ? "No mask sealed a plan" : "The masks go for the vault" };

  const window: Caption = sealedRound ? { kicker: "The sealing window closes", head: `${hms(r.sealUntil!)} UTC`, tint: "amber" } : { kicker: "The vault is open", head: `${hms(r.startsAt ?? r.openedAt ?? d.capturedAt)} UTC`, tint: "amber" };

  if (r.phase === "broken" && r.winner) {
    const w = r.winner.name.toUpperCase();
    const took = r.loot ?? r.events.find((e) => e.kind === "drain" && !e.early && e.who?.account === r.winner!.account)?.amount ?? null;
    const after: RoundLine[] = [];
    if (took) after.push({ row: "break", kicker: "Out of the vault", head: `${near(took)} NEAR`, tint: "money", count: count(took) });
    if (r.payout) after.push({ row: "paid", kicker: "Paid on top by the contract", head: `+${near(r.payout.amount)} NEAR`, tint: "money", count: count(r.payout.amount, "+") });
    after.push({ row: "hero", kicker: "Nobody pressed a button", head: r.takes ? `${w} takes ${near(r.takes)} NEAR` : `${w} takes the vault`, tint: "money" });
    return {
      roundNo: no,
      outcome: "broken",
      person,
      inRound,
      mask,
      lineup,
      loaded,
      sealed,
      window,
      result: {
        kicker: [r.brokeAt ? `${hms(r.brokeAt)} UTC` : round, forgedByPerson(r.winner) ? "a mask forged by a person" : null].filter(Boolean).join(" · "),
        head: r.breakMs !== null ? `Broken in ${spell(r.breakMs)}` : `${w} broke the vault`,
        ...(r.breakMs !== null && sealedRound ? { sub: "after the window closed" } : {}),
      },
      after,
      ...money(d.league),
    };
  }
  if (r.phase === "held") {
    return {
      roundNo: no,
      outcome: "held",
      person,
      inRound,
      mask,
      lineup,
      loaded,
      sealed,
      window,
      result: { kicker: round, head: "The vault held", sub: "Nobody got through" },
      after: [
        { row: sealedRound ? "unlock" : loaded.row, kicker: seals.length ? `${plural(seals.length, "plan")} sealed` : "No plan sealed", head: "No mask broke it" },
        { row: r.refund ? "refund" : "hero", kicker: "The bounty", head: `${near(r.refund?.amount ?? r.bounty)} NEAR goes back to the team` },
      ],
      ...money(d.league),
    };
  }
  // The round is still on: said as it stands, with what is on the line.
  return {
    roundNo: no,
    outcome: "open",
    person,
    inRound,
    mask,
    lineup,
    loaded,
    sealed,
    window,
    result: { kicker: `${round} · on now`, head: r.phase === "sealing" ? "The masks are sealing" : "The vault is open" },
    after: [{ row: "hero", kicker: "On the line", head: `${near(r.prize)} NEAR`, tint: "money", count: count(r.prize) }],
    ...money(d.league),
  };
}

/** The league's two lines: how many rounds, how many winners, and what the first of them took. */
function money(league: LeagueRow[]): Pick<Story, "league" | "top" | "topIndex"> {
  const rounds = new Set(league.flatMap((m) => m.history.map((h) => h.id))).size;
  const winners = league.filter((m) => m.breaks > 0).sort((a, b) => (BigInt(b.earned) > BigInt(a.earned) ? 1 : BigInt(b.earned) < BigInt(a.earned) ? -1 : 0));
  const top = winners[0];
  const said = winners.length === 0 ? "No vault broken yet" : winners.length === 1 ? "One winner so far" : `${winners.length} masks have won`;
  return {
    topIndex: top ? league.indexOf(top) : -1,
    league: { kicker: "The league", head: `${plural(rounds, "round")}. ${said}.` },
    top: top
      ? { kicker: `${top.who.name.toUpperCase()} · ${plural(top.breaks, "vault")} broken`, head: `${near(top.earned)} NEAR`, tint: "money", count: { to: near(top.earned), unit: " NEAR" } }
      : { kicker: "The league", head: "The first break is still to come" },
  };
}

/** How the bars after the result are shared between its lines: whole bars, the last line takes what is left. */
export function afterBars(lines: number): number[] {
  const total = AT.league - AT.after;
  const each = Math.floor(total / lines);
  return Array.from({ length: lines }, (_, i) => (i === lines - 1 ? total - each * (lines - 1) : each));
}
