// The card a race or a mask shows when its link is shared: 1200×630, the arena's look (BRANDBOOK §10), every number
// from the same reading of the chain as the page. The chain silent or the page unknown: the arena's own card, no numbers.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaskStats, Race, Who } from '@maskwars/arena';
import { duration, near, raceNo } from '@maskwars/arena/format';
import { color } from '@maskwars/brand';
import { ImageResponse } from 'next/og';
import type { CSSProperties, ReactNode } from 'react';
import { choiceName, HELD, outcomeOf, verdictOf } from '@/lib/pick';
import type { Claim } from '@/lib/share';
import { artOf, day, shortAccount, type Tone, toneOf } from '@/lib/show';
import { raceName } from '@/components/arena/names';
import { type Metrics, lineWidth, metrics } from '@/lib/ttf';

export const SIZE = { width: 1200, height: 630 } as const;
const W = SIZE.width;
const H = SIZE.height;

/** Edge cache: a race in motion changes by the minute; a settled race and a mask's record far less often. */
export const CACHE = {
  live: 'public, max-age=0, s-maxage=60, stale-while-revalidate=60',
  mask: 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600',
  settled: 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
  silent: 'public, max-age=0, s-maxage=60, stale-while-revalidate=60',
} as const;

// Files ---------------------------------------------------------------------------------------------------------------
// Satori reads neither woff2 nor font variations, nor webp: static TTF instances of the brand's fonts
// (packages/brand/scripts/fonts.py) and the JPEG frames the site's webp come from (brand/art/web). Every path is a
// literal, so the build traces exactly these files into the function.

const FONT_FILES = {
  word: () => readFile(join(process.cwd(), '../../packages/brand/fonts/hubot-sans-800-wdth125.ttf')),
  narrow: () => readFile(join(process.cwd(), '../../packages/brand/fonts/hubot-sans-800-wdth85.ttf')),
  num: () => readFile(join(process.cwd(), '../../packages/brand/fonts/mona-sans-800-wdth125.ttf')),
  line: () => readFile(join(process.cwd(), '../../packages/brand/fonts/mona-sans-600.ttf')),
};

const ART_FILES: Record<string, () => Promise<Buffer>> = {
  nova: () => readFile(join(process.cwd(), '../../brand/art/web/nova.jpg')),
  onyx: () => readFile(join(process.cwd(), '../../brand/art/web/onyx.jpg')),
  oracle: () => readFile(join(process.cwd(), '../../brand/art/web/oracle.jpg')),
  ronin: () => readFile(join(process.cwd(), '../../brand/art/web/ronin.jpg')),
  volt: () => readFile(join(process.cwd(), '../../brand/art/web/volt.jpg')),
  wraith: () => readFile(join(process.cwd(), '../../brand/art/web/wraith.jpg')),
  vault: () => readFile(join(process.cwd(), '../../brand/art/web/ring.jpg')),
};

type FontKey = keyof typeof FONT_FILES;
const FAMILY: Record<FontKey, string> = { word: 'Word', narrow: 'WordNarrow', num: 'Num', line: 'Line' };
const WEIGHT: Record<FontKey, 600 | 800> = { word: 800, narrow: 800, num: 800, line: 600 };

interface Assets {
  readonly fonts: { name: string; data: Buffer; weight: 600 | 800; style: 'normal' }[];
  readonly m: Record<FontKey, Metrics>;
}

let loading: Promise<Assets> | null = null;
function assets(): Promise<Assets> {
  loading ??= (async () => {
    const keys = Object.keys(FONT_FILES) as FontKey[];
    const data = await Promise.all(keys.map((k) => FONT_FILES[k]()));
    const m = Object.fromEntries(keys.map((k, i) => [k, metrics(data[i]!)])) as Record<FontKey, Metrics>;
    return { fonts: keys.map((k, i) => ({ name: FAMILY[k], data: data[i]!, weight: WEIGHT[k], style: 'normal' as const })), m };
  })().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

const art = new Map<string, Promise<string | null>>();
/** A frame as a data URL, read once per server. A frame that cannot be read leaves its place to the mark, not an error. */
function picture(key: string): Promise<string | null> {
  const read = ART_FILES[key];
  if (!read) return Promise.resolve(null);
  let p = art.get(key);
  if (!p) {
    p = read().then(
      (b) => `data:image/jpeg;base64,${b.toString('base64')}`,
      () => {
        art.delete(key);
        return null;
      },
    );
    art.set(key, p);
  }
  return p;
}

/** The frame of a mask the arena has art for, exactly where the page shows one (`artOf`). */
function faceKey(who: Who | null | undefined): string | null {
  return who && artOf(who) ? who.slug : null;
}

// Type ----------------------------------------------------------------------------------------------------------------

const rgba = (hex: string, a: number) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const WORD_TRACK = 0.01;
const LABEL_TRACK = 0.06;
const NUM_TRACK = -0.01;
/** Space between the words of a mixed line, in em: a word space of the wide cut plus the line's letter spacing. */
const GAP = 0.3;
/** The text column: from the left margin to where the picture takes over. */
const COLUMN = 600;

interface Fit {
  font: FontKey;
  size: number;
  text: string;
}

/**
 * A headline in one line of `max` px: the wide cut down to 80% of `size`; then the narrow cut, since the width axis
 * 125→85 takes a long name before the size does (BRANDBOOK §4); then smaller to `floor`; past that the end gives way to «…».
 */
function fitWords(a: Assets, line: string, size: number, max: number, floor = size * 0.5): Fit {
  const wide = lineWidth(a.m.word, line, size, WORD_TRACK);
  if (wide <= max) return { font: 'word', size, text: line };
  if ((size * max) / wide >= size * 0.8) return { font: 'word', size: Math.floor((size * max) / wide), text: line };
  const narrow = lineWidth(a.m.narrow, line, size, WORD_TRACK);
  if (narrow <= max) return { font: 'narrow', size, text: line };
  const s = Math.floor((size * max) / narrow);
  if (s >= floor) return { font: 'narrow', size: s, text: line };
  let t = line;
  while (t.length > 1 && lineWidth(a.m.narrow, `${t}…`, floor, WORD_TRACK) > max) t = t.slice(0, -1);
  return { font: 'narrow', size: floor, text: `${t.trimEnd()}…` };
}

const text = (f: FontKey, size: number, fill: string, extra: CSSProperties = {}): CSSProperties => ({
  fontFamily: FAMILY[f],
  fontWeight: WEIGHT[f],
  fontSize: size,
  color: fill,
  lineHeight: 1,
  whiteSpace: 'pre',
  flexShrink: 0,
  letterSpacing: f === 'word' || f === 'narrow' ? size * WORD_TRACK : f === 'num' ? size * NUM_TRACK : 0,
  ...extra,
});

/** A word split into its figures (Mona) and the rest (Hubot): «#1» → «#», «1». */
const runs = (word: string) => word.split(/([0-9][0-9.,:]*)/).filter(Boolean);
const isNum = (run: string) => /^[0-9]/.test(run);

/** The width of a mixed line at `size`, as `Mixed` sets it. */
function mixedWidth(a: Assets, line: string, size: number, account?: string): number {
  const words = line.split(' ').filter(Boolean);
  let w = (words.length - 1) * size * GAP;
  for (const word of words) for (const r of runs(word)) w += isNum(r) ? lineWidth(a.m.num, r, size, NUM_TRACK) : lineWidth(a.m.word, r, size, LABEL_TRACK);
  if (account) w += size * GAP + lineWidth(a.m.line, account, size);
  return w;
}

function MixedLine({ line, size, fill, account }: { line: string; size: number; fill: string; account?: string | undefined }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: size * GAP }}>
      {line
        .split(' ')
        .filter(Boolean)
        .map((word, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'baseline', flexShrink: 0 }}>
            {runs(word).map((r, j) => (
              <span key={j} style={isNum(r) ? text('num', size, fill) : text('word', size, fill, { letterSpacing: size * LABEL_TRACK })}>
                {r}
              </span>
            ))}
          </div>
        ))}
      {account ? <span style={text('line', size, fill)}>{account}</span> : null}
    </div>
  );
}

/**
 * A line in the arena's two voices, fitted to `max` px: words in Hubot, numbers in Mona (Hubot's zero is slashed, so
 * no figure is set in it). Words are laid apart by a gap, not by spaces: Satori drops a space at the edge of a run.
 * An account closes the line in Mona's line cut, in its own lowercase. A line that would shrink below `floor` breaks
 * instead: at its « · » first, then between words, never into small type.
 */
function Mixed({ a, line, size, fill, max = COLUMN, account, floor = size * 0.86 }: { a: Assets; line: string; size: number; fill: string; max?: number; account?: string | undefined; floor?: number }) {
  const w = mixedWidth(a, line, size, account);
  const s = w <= max ? size : Math.floor((size * max) / w);
  if (s >= floor) return <MixedLine line={line} size={s} fill={fill} account={account} />;
  const rows: string[] = [];
  for (const part of line.split(' · ')) {
    const words = part.split(' ');
    if (mixedWidth(a, part, size) <= max || words.length < 2) {
      rows.push(part);
      continue;
    }
    // Two rows as even as they go, so no word is left alone on the second.
    let best = 1;
    let bestWidth = Infinity;
    for (let k = 1; k < words.length; k++) {
      const wide = Math.max(mixedWidth(a, words.slice(0, k).join(' '), size), mixedWidth(a, words.slice(k).join(' '), size));
      if (wide < bestWidth) [best, bestWidth] = [k, wide];
    }
    rows.push(words.slice(0, best).join(' '), words.slice(best).join(' '));
  }
  if (account && mixedWidth(a, rows.at(-1)!, size, account) > max) rows.push('');
  // Every row at one size, the size the widest row allows: nothing runs under the picture.
  const fit = Math.min(size, ...rows.map((r, i) => Math.floor((size * max) / Math.max(1, mixedWidth(a, r, size, i === rows.length - 1 ? account : undefined)))));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: fit * 0.34 }}>
      {rows.map((r, i) => (
        <MixedLine key={i} line={r} size={fit} fill={fill} account={i === rows.length - 1 ? account : undefined} />
      ))}
    </div>
  );
}

function Words({ fit, fill }: { fit: Fit; fill: string }) {
  return <div style={text(fit.font, fit.size, fill)}>{fit.text}</div>;
}

interface Head {
  font: FontKey;
  size: number;
  lines: string[];
}

/** Words laid greedily into lines of `max` px, or null when one word alone is wider. */
function wrap(m: Metrics, line: string, size: number, max: number): string[] | null {
  const lines: string[] = [];
  for (const word of line.split(' ')) {
    const last = lines.at(-1);
    if (last !== undefined && lineWidth(m, `${last} ${word}`, size, WORD_TRACK) <= max) lines[lines.length - 1] = `${last} ${word}`;
    else if (lineWidth(m, word, size, WORD_TRACK) <= max) lines.push(word);
    else return null;
  }
  return lines;
}

/**
 * A headline as the page sets it, in the wide cut: one line if it holds at 85% of `size`, else two lines; a name too
 * long for that takes `fitWords`.
 */
function fitHead(a: Assets, line: string, size: number, max: number, floor: number): Head {
  const one = lineWidth(a.m.word, line, size, WORD_TRACK);
  if (one <= max / 0.85) return { font: 'word', size: one <= max ? size : Math.floor((size * max) / one), lines: [line] };
  const wide = wrap(a.m.word, line, size, max);
  if (wide && wide.length <= 2) return { font: 'word', size, lines: wide };
  const f = fitWords(a, line, size, max, floor);
  return { font: f.font, size: f.size, lines: [f.text] };
}

function Headline({ head, fill }: { head: Head; fill: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: head.size * 0.06 }}>
      {head.lines.map((l, i) => (
        <div key={i} style={text(head.font, head.size, fill)}>
          {l}
        </div>
      ))}
    </div>
  );
}

/** NEAR as the page sets it: the figure big in Mona, the unit a third of it in Hubot, on one baseline. */
function Amount({ a, value, fill, size, max = COLUMN }: { a: Assets; value: string; fill: string; size: number; max?: number }) {
  const unit = 0.34;
  const width = (s: number) => lineWidth(a.m.num, value, s, NUM_TRACK) + s * 0.12 + lineWidth(a.m.word, 'NEAR', s * unit, WORD_TRACK);
  const s = width(size) <= max ? size : Math.floor((size * max) / width(size));
  return (
    <div style={{ display: 'flex', alignItems: 'baseline' }}>
      <span style={text('num', s, fill)}>{value}</span>
      <span style={text('word', s * unit, fill, { marginLeft: s * 0.12 })}>NEAR</span>
    </div>
  );
}

// Frame ---------------------------------------------------------------------------------------------------------------

const MARK = 'M47 0 L120 87 L193 0 L224 95 L138 155 L138 179 L214 126 L164 280 L120 228 L76 280 L26 126 L102 179 L102 155 L16 95Z';

function Mark({ height, opacity = 1 }: { height: number; opacity?: number }) {
  return (
    <svg width={(height * 240) / 280} height={height} viewBox="0 0 240 280" style={{ opacity }}>
      <path fill={color.ice} d={MARK} />
    </svg>
  );
}

function Sign() {
  return (
    <div style={{ position: 'absolute', left: 72, bottom: 56, display: 'flex', alignItems: 'center', gap: 16 }}>
      <Mark height={40} />
      <span style={text('word', 30, color.ice)}>MASK WARS</span>
    </div>
  );
}

/**
 * A frame let into the dark: its black sides fade out left and right. Satori has no blend modes, inverts radial masks
 * and keeps only the innermost of nested masks, so a frame's top and bottom either leave the card or sit on the stage
 * where it has already sunk to the frame's own black.
 */
function Soft({ src, left, top, width, height, edge }: { src: string; left: number; top: number; width: number; height: number; edge: number }) {
  return (
    <div style={{ position: 'absolute', left, top, width, height, display: 'flex', maskImage: `linear-gradient(to right, transparent 0%, white ${edge * 100}%, white ${100 - edge * 100}%, transparent 100%)` }}>
      <img src={src} width={width} height={height} alt="" />
    </div>
  );
}

/** A layer over the whole card (Satori knows no `inset`). */
const layer = (w: number, h: number): CSSProperties => ({ position: 'absolute', left: 0, top: 0, width: w, height: h, display: 'flex' });
const full = layer(W, H);

/**
 * The arena: ink, Ember from the left corner behind everything, Violet from the right corner over the picture's empty
 * edge (it stops short of the mask: a corner lights the edge, never the material, BRANDBOOK §3).
 */
function Arena({ children, w = W, h = H }: { children: ReactNode; w?: number; h?: number }) {
  const all = layer(w, h);
  return (
    <div style={{ width: w, height: h, display: 'flex', position: 'relative', background: color.ink, color: color.ice }}>
      <div style={{ ...all, backgroundImage: `radial-gradient(34% 60% at 0% 74%, ${rgba(color.ember, 0.22)}, ${rgba(color.ember, 0)})` }} />
      {/* The frames are shot on black: the stage under them sinks from ink to their black, so no edge shows. */}
      <div style={{ ...all, backgroundImage: 'linear-gradient(to right, rgba(0, 0, 0, 0) 36%, rgba(0, 0, 0, 0.85) 54%, rgba(0, 0, 0, 0.85) 100%)' }} />
      {children}
      <div style={{ ...all, backgroundImage: `radial-gradient(15% 52% at 100% 66%, ${rgba(color.violet, 0.3)}, ${rgba(color.violet, 0)})` }} />
      <Sign />
    </div>
  );
}

const TONE: Record<Tone, string> = { ember: color.ember, ice: color.ice, violet: color.violet };

/** Where the picture stands: the right of the card, its centre here. */
const STAGE = { x: 930, y: 300 } as const;

/** The right of the card: a mask's face, the mark for a mask with no frame yet (in its own light), or the vault. */
async function hero(pick: { face: string | null; vault?: boolean; tone?: Tone }): Promise<ReactNode> {
  const vault = pick.vault ? await picture('vault') : null;
  if (vault) {
    // ring.jpg: 2200×1235, the ring's centre at (1098, 585), 1130 across. Here 440 across, on the stage; the frame's
    // black runs off the card on the right and fades into the stage on the left, well before the ring.
    const k = 440 / 1130;
    return <Soft src={vault} left={Math.round(STAGE.x - 1098 * k)} top={Math.round(STAGE.y - 585 * k)} width={Math.round(2200 * k)} height={Math.round(1235 * k)} edge={0.17} />;
  }
  const face = pick.face ? await picture(pick.face) : null;
  // A 1:1 frame as high as the card: the mask stands 78% of it, its eyes on the centre line (BRANDBOOK §5).
  if (face) return <Soft src={face} left={STAGE.x - H / 2 + 10} top={0} width={H} height={H} edge={0.2} />;
  const light = TONE[pick.tone ?? 'ice'];
  return (
    <div style={{ position: 'absolute', left: STAGE.x - 260, top: STAGE.y - 260, width: 520, height: 520, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: 520, height: 520, display: 'flex', backgroundImage: `radial-gradient(50% 50% at 50% 50%, ${rgba(light, 0.24)} 0%, ${rgba(light, 0.08)} 50%, ${rgba(light, 0)} 100%)` }} />
      <Mark height={320} opacity={0.88} />
    </div>
  );
}

function Column({ children, gap = 22 }: { children: ReactNode; gap?: number }) {
  return (
    <div style={{ position: 'absolute', left: 72, top: 44, bottom: 132, width: COLUMN, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap }}>
      {children}
    </div>
  );
}

function Kicker({ a, line, live = false }: { a: Assets; line: string; live?: boolean }) {
  const size = 28;
  const liveWidth = live ? 16 + 10 + lineWidth(a.m.word, 'LIVE', size, LABEL_TRACK) + 22 : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {live ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 22, flexShrink: 0 }}>
          <div style={{ width: 16, height: 16, borderRadius: 8, background: color.live }} />
          <span style={text('word', size, color.live, { letterSpacing: size * LABEL_TRACK })}>LIVE</span>
        </div>
      ) : null}
      <Mixed a={a} line={line} size={size} fill={color.ice60} max={COLUMN - liveWidth} floor={0} />
    </div>
  );
}

async function draw(node: ReactNode, cache: string): Promise<ImageResponse> {
  const a = await assets();
  return new ImageResponse(<Arena>{node}</Arena>, { ...SIZE, fonts: a.fonts, headers: { 'Cache-Control': cache } });
}

// Cards ---------------------------------------------------------------------------------------------------------------

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** 18:34 UTC, with the day when it is not the day the race opened. */
function at(ms: number, opened: number | null): string {
  const d = new Date(ms);
  const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
  return opened && day(opened) === day(ms) ? time : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${time}`;
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A race's numbers are final once nothing moves on it and its bounty went to the winner or back to the team. */
export function settled(r: Race): boolean {
  return !r.live && (r.phase === 'broken' || r.phase === 'held') && r.state !== 'open' && r.state !== 'judging';
}

export interface RaceLines {
  readonly kicker: string;
  readonly amount: string;
  /** Money only for NEAR a mask took (BRANDBOOK §3); what is on the line or went back stays Ice. */
  readonly tone: 'money' | 'plain';
  readonly head: string;
  readonly sub: string;
  /** An account that closes the sub line, kept in its own lowercase. */
  readonly account?: string | undefined;
  readonly face: string | null;
  readonly vault: boolean;
}

/** What the card of a race says: the same reading as its page, in the card's few lines. */
export function raceLines(r: Race): RaceLines {
  const target = r.kind === 'safe' ? 'THE SAFE' : r.target.toUpperCase();
  const w = r.winner;
  // LIVE says when: a race in motion drops its day for it.
  const kicker = [`RACE ${raceNo(r.id)}`, r.live ? null : day(r.openedAt), r.network.toUpperCase()].filter(Boolean).join(' · ');
  if (r.phase === 'broken') {
    const amount = r.takes ?? r.loot ?? r.bounty;
    const rivals = r.masks.length > 1 ? `FIRST OF ${r.masks.length} MASKS` : null;
    const face = faceKey(w);
    if (w?.mask) {
      return {
        kicker,
        amount: near(amount),
        tone: 'money',
        head: `${w.name} BROKE ${target}`,
        sub: [r.breakMs !== null ? `IN ${duration(r.breakMs)}` : null, rivals].filter(Boolean).join(' · '),
        face,
        vault: !face,
      };
    }
    return {
      kicker,
      amount: near(amount),
      tone: 'money',
      head: `${target} IS BROKEN`,
      sub: w ? (w.account === r.team ? "PAID TO THE TEAM'S OWN ACCOUNT" : 'TO') : '',
      account: w && w.account !== r.team ? shortAccount(w.account, 26) : undefined,
      face: null,
      vault: true,
    };
  }
  if (r.phase === 'held') {
    return {
      kicker,
      amount: near(r.refund?.amount ?? r.bounty),
      tone: 'plain',
      head: r.kind === 'safe' ? 'THE SAFE HELD' : 'NOBODY GOT THROUGH',
      sub: 'BACK TO THE TEAM',
      face: null,
      vault: true,
    };
  }
  const masks = r.masks.length ? count(r.masks.length, 'MASK', 'MASKS') : null;
  if (r.phase === 'sealing') {
    return {
      kicker,
      amount: near(r.prize),
      tone: 'plain',
      head: 'MASKS ARE SEALING',
      sub: [masks ? `${masks} IN` : null, r.startsAt ? `STARTS ${at(r.startsAt, r.openedAt)}` : null].filter(Boolean).join(' · '),
      face: null,
      vault: true,
    };
  }
  return {
    kicker,
    amount: near(r.prize),
    tone: 'plain',
    head: `${target} IS OPEN`,
    sub: [masks ? `${masks} RACING` : null, `CLOSES ${at(r.deadline, r.openedAt)}`].filter(Boolean).join(' · '),
    face: null,
    vault: true,
  };
}

export async function raceCard(r: Race | null): Promise<ImageResponse> {
  if (!r) return arenaCard();
  const a = await assets();
  const l = raceLines(r);
  return draw(
    <>
      {await hero({ face: l.face, vault: l.vault })}
      <Column>
        <Kicker a={a} line={l.kicker} live={r.live} />
        <Amount a={a} value={l.amount} fill={l.tone === 'money' ? color.money : color.ice} size={176} />
        <Headline head={fitHead(a, l.head, 52, COLUMN, 34)} fill={color.ice} />
        {l.sub ? <Mixed a={a} line={l.sub} size={28} fill={color.ice60} account={l.account} /> : null}
      </Column>
    </>,
    settled(r) ? CACHE.settled : CACHE.live,
  );
}

/** A model's own name, without its maker: deepseek-ai/DeepSeek-V4.1-Flash-1017 → DeepSeek-V4.1-Flash-1017. */
export function modelName(model: string): string {
  return model.slice(model.lastIndexOf('/') + 1);
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginRight: 56 }}>
      <span style={text('word', 26, color.ice60, { letterSpacing: 26 * LABEL_TRACK })}>{label}</span>
      <span style={text('num', 50, color.ice)}>{value}</span>
    </div>
  );
}

/** A mask's card: its face, its name, what it took, how often and how fast it broke in, the model it thinks with. */
export async function maskCard(m: MaskStats, rank: number, network: string): Promise<ImageResponse> {
  const a = await assets();
  const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
  return draw(
    <>
      {await hero({ face: faceKey(m.who), tone: toneOf(m.who) })}
      <Column gap={18}>
        <Kicker a={a} line={`#${rank} IN THE LEAGUE · ${network.toUpperCase()}`} />
        <Words fit={fitWords(a, m.who.name.toUpperCase(), 112, COLUMN, 52)} fill={color.ice} />
        {m.breaks ? <Amount a={a} value={near(m.earned)} fill={color.money} size={92} /> : null}
        <div style={{ display: 'flex', marginTop: 4 }}>
          {m.breaks ? (
            <>
              <Stat value={String(m.breaks)} label={plural(m.breaks, 'BREAK', 'BREAKS')} />
              {m.fastestMs !== null ? <Stat value={duration(m.fastestMs)} label="FASTEST" /> : null}
            </>
          ) : (
            <>
              <Stat value={String(m.races)} label={plural(m.races, 'RACE', 'RACES')} />
              <Stat value="0" label="BREAKS" />
            </>
          )}
        </div>
        {m.who.model ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
            <span style={text('word', 26, color.ice60, { letterSpacing: 26 * LABEL_TRACK })}>MODEL</span>
            <span style={text('line', 28, color.ice)}>{modelName(m.who.model)}</span>
          </div>
        ) : null}
      </Column>
    </>,
    CACHE.mask,
  );
}

/** The chain silent, or nothing by that name: the arena itself, no numbers. */
export async function arenaCard(): Promise<ImageResponse> {
  return draw(
    <>
      {await hero({ face: null, vault: true })}
      <Column gap={28}>
        <div style={text('word', 54, color.ice, { whiteSpace: 'normal', lineHeight: 1.06, width: COLUMN - 40 })}>AI MASKS RACE TO BREAK A SAFE FULL OF NEAR.</div>
        <div style={text('word', 32, color.ice60, { whiteSpace: 'normal', lineHeight: 1.12, letterSpacing: 32 * 0.03, width: COLUMN - 40 })}>WHOEVER BREAKS IT KEEPS THE MONEY.</div>
      </Column>
    </>,
    CACHE.silent,
  );
}

// The call card ---------------------------------------------------------------------------------------------------------

/** A shared call is posted as a picture on X: 16:9, as BRANDBOOK §10 sets the win card. */
export const CALL_SIZE = { width: 1600, height: 900 } as const;

/** What the call card says, from the claim and the chain. */
export interface CallLines {
  readonly kicker: string;
  readonly verdict: string;
  readonly right: boolean;
  readonly head: string;
  /** NEAR the winner took; null when the vault held. */
  readonly amount: string | null;
  readonly sub: string;
  readonly streak: string | null;
  readonly face: string | null;
}

export function callLines(r: Race, claim: Claim): CallLines {
  const outcome = outcomeOf(r) ?? HELD;
  const right = verdictOf(claim.choice, outcome) === 'right';
  const held = outcome === HELD;
  // The card's words follow the race card's: the safe held. (Satori sets «VAULT HELD» with a gap the browser does not.)
  const said = claim.choice === HELD ? 'THE SAFE TO HOLD' : choiceName(claim.choice, r.masks).toUpperCase();
  const who = r.winner?.mask ? r.winner.name.toUpperCase() : 'A MASK';
  const time = r.breakMs !== null ? `IN ${duration(r.breakMs)}` : null;
  return {
    kicker: [raceName(r.id).toUpperCase(), day(r.openedAt), `NEAR ${r.network.toUpperCase()}`].filter(Boolean).join(' · '),
    verdict: right ? 'CALLED IT' : 'RUN IT BACK',
    right,
    head: right ? (held ? 'THE SAFE HELD' : `${who} BROKE IT`) : `PICKED ${said}`,
    amount: held ? null : near(r.takes ?? r.loot ?? r.bounty),
    sub: right ? (held ? 'NOBODY GOT THROUGH' : (time ?? 'BROKEN')) : held ? 'THE SAFE HELD' : [`${who} BROKE IT`, time].filter(Boolean).join(' '),
    streak: right && claim.streak !== null && claim.streak > 1 ? `${claim.streak} IN A ROW` : null,
    face: held ? null : faceKey(r.winner),
  };
}

export async function callCard(r: Race, claim: Claim): Promise<ImageResponse> {
  const a = await assets();
  const l = callLines(r, claim);
  const { width: CW, height: CH } = CALL_SIZE;
  const column = 800;
  /** Where the picture stands: right of the column, clear of every word. */
  const x = 1250;
  let shown: ReactNode = null;
  const face = l.face ? await picture(l.face) : null;
  if (face) shown = <Soft src={face} left={x - CH / 2} top={0} width={CH} height={CH} edge={0.2} />;
  else {
    const vault = await picture('vault');
    // ring.jpg: 2200×1235, the ring's centre at (1098, 585), 1130 across. Here 540 across, its left edge past the column.
    const k = 540 / 1130;
    if (vault) shown = <Soft src={vault} left={Math.round(x + 30 - 1098 * k)} top={Math.round(CH / 2 - 40 - 585 * k)} width={Math.round(2200 * k)} height={Math.round(1235 * k)} edge={0.17} />;
  }
  const node = (
    <Arena w={CW} h={CH}>
      {shown}
      <div style={{ position: 'absolute', left: 96, top: 64, bottom: 170, width: column, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 26 }}>
        <Mixed a={a} line={l.kicker} size={34} fill={color.ice60} max={column} floor={0} />
        <Words fit={fitWords(a, l.verdict, l.right ? 132 : 108, column, 80)} fill={l.right ? color.amber : color.ice} />
        <Headline head={fitHead(a, l.head, 54, column, 36)} fill={color.ice} />
        {l.amount ? <Amount a={a} value={l.amount} fill={color.money} size={150} max={column} /> : null}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 28 }}>
          <Mixed a={a} line={l.sub} size={34} fill={color.ice60} max={l.streak ? column / 2 : column} floor={0} />
          {l.streak ? <Mixed a={a} line={l.streak} size={34} fill={color.amber} max={column / 2} floor={0} /> : null}
        </div>
      </div>
    </Arena>
  );
  return new ImageResponse(node, { ...CALL_SIZE, fonts: a.fonts, headers: { 'Cache-Control': CACHE.settled } });
}

