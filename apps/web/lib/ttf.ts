// Advance widths and kerning straight from a TrueType file: enough to fit a line to a card before Satori draws it,
// and to set its words as far apart as a browser would.

export interface Metrics {
  readonly unitsPerEm: number;
  /** Advance of a character in font units; a character the font lacks takes the width of `.notdef`. */
  advance(char: string): number;
  /**
   * How far the font moves `right` towards `left` when they stand side by side, in font units (negative pulls them
   * together): the `kern` feature's pair positioning in GPOS, read the way the cards' renderer reads it.
   */
  kern(left: string, right: string): number;
}

function tables(view: DataView): Map<string, number> {
  const count = view.getUint16(4);
  const out = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(view.getUint8(rec), view.getUint8(rec + 1), view.getUint8(rec + 2), view.getUint8(rec + 3));
    out.set(tag, view.getUint32(rec + 8));
  }
  return out;
}

/** The glyph of each BMP character (cmap format 4, the table every font here carries). */
function charToGlyph(view: DataView, cmap: number): Map<number, number> {
  const n = view.getUint16(cmap + 2);
  let sub = -1;
  for (let i = 0; i < n; i++) {
    const platform = view.getUint16(cmap + 4 + i * 8);
    const encoding = view.getUint16(cmap + 6 + i * 8);
    const offset = view.getUint32(cmap + 8 + i * 8);
    if (view.getUint16(cmap + offset) === 4 && ((platform === 3 && encoding === 1) || platform === 0)) sub = cmap + offset;
  }
  if (sub < 0) throw new Error('no cmap format 4');
  const segs = view.getUint16(sub + 6) / 2;
  const ends = sub + 14;
  const starts = ends + segs * 2 + 2;
  const deltas = starts + segs * 2;
  const ranges = deltas + segs * 2;
  const out = new Map<number, number>();
  for (let s = 0; s < segs; s++) {
    const end = view.getUint16(ends + s * 2);
    const start = view.getUint16(starts + s * 2);
    const delta = view.getInt16(deltas + s * 2);
    const range = view.getUint16(ranges + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let g: number;
      if (range === 0) g = (c + delta) & 0xffff;
      else {
        const at = ranges + s * 2 + range + (c - start) * 2;
        g = view.getUint16(at);
        if (g !== 0) g = (g + delta) & 0xffff;
      }
      if (g !== 0) out.set(c, g);
    }
  }
  return out;
}

const tagAt = (view: DataView, at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));

/** Where a glyph stands in a coverage table, or -1. */
function coverageIndex(view: DataView, cov: number, glyph: number): number {
  const format = view.getUint16(cov);
  const count = view.getUint16(cov + 2);
  if (format === 1) {
    for (let i = 0; i < count; i++) if (view.getUint16(cov + 4 + i * 2) === glyph) return i;
    return -1;
  }
  if (format === 2) {
    for (let i = 0; i < count; i++) {
      const rec = cov + 4 + i * 6;
      const start = view.getUint16(rec);
      if (glyph >= start && glyph <= view.getUint16(rec + 2)) return view.getUint16(rec + 4) + glyph - start;
    }
  }
  return -1;
}

/** A glyph's class in a class definition table; 0 for a glyph it does not list. */
function classOf(view: DataView, def: number, glyph: number): number {
  const format = view.getUint16(def);
  if (format === 1) {
    const start = view.getUint16(def + 2);
    return glyph >= start && glyph < start + view.getUint16(def + 4) ? view.getUint16(def + 6 + (glyph - start) * 2) : 0;
  }
  if (format === 2) {
    const count = view.getUint16(def + 2);
    for (let i = 0; i < count; i++) {
      const rec = def + 4 + i * 6;
      if (glyph >= view.getUint16(rec) && glyph <= view.getUint16(rec + 2)) return view.getUint16(rec + 4);
    }
  }
  return 0;
}

const bits = (n: number) => {
  let count = 0;
  for (let v = n; v; v >>= 1) count += v & 1;
  return count;
};
/** A value record's size in bytes, and its XAdvance (the third field, when the format carries it). */
const valueSize = (format: number) => bits(format) * 2;
const xAdvance = (view: DataView, at: number, format: number) => (format & 0x4 ? view.getInt16(at + bits(format & 0x3) * 2) : 0);

/**
 * Kerning between two glyphs, as opentype.js gives it (the reader inside Satori, which draws the cards): the pair
 * positioning lookups of the `kern` feature in the default language of script DFLT, else latn, in the feature's own
 * order. The first subtable that covers the left glyph answers: a pair list only when it lists the pair, a class
 * table always.
 */
function kerning(view: DataView, gpos: number | undefined): (left: number, right: number) => number {
  const none = () => 0;
  if (gpos === undefined) return none;
  const scripts = gpos + view.getUint16(gpos + 4);
  const features = gpos + view.getUint16(gpos + 6);
  const lookups = gpos + view.getUint16(gpos + 8);
  let script = -1;
  let latn = -1;
  for (let i = 0, n = view.getUint16(scripts); i < n; i++) {
    const rec = scripts + 2 + i * 6;
    const tag = tagAt(view, rec);
    if (tag === 'DFLT') {
      script = scripts + view.getUint16(rec + 4);
      break;
    }
    if (tag === 'latn') latn = scripts + view.getUint16(rec + 4);
  }
  if (script < 0) script = latn;
  if (script < 0 || view.getUint16(script) === 0) return none;
  const lang = script + view.getUint16(script);
  let feature = -1;
  for (let i = 0, n = view.getUint16(lang + 4); i < n && feature < 0; i++) {
    const rec = features + 2 + view.getUint16(lang + 6 + i * 2) * 6;
    if (tagAt(view, rec) === 'kern') feature = features + view.getUint16(rec + 4);
  }
  if (feature < 0) return none;
  const subtables: number[] = [];
  for (let i = 0, n = view.getUint16(feature + 2); i < n; i++) {
    const lookup = lookups + view.getUint16(lookups + 2 + view.getUint16(feature + 4 + i * 2) * 2);
    if (view.getUint16(lookup) !== 2) continue;
    for (let k = 0, subs = view.getUint16(lookup + 4); k < subs; k++) subtables.push(lookup + view.getUint16(lookup + 6 + k * 2));
  }
  if (!subtables.length) return none;
  return (left, right) => {
    for (const sub of subtables) {
      const at = coverageIndex(view, sub + view.getUint16(sub + 2), left);
      if (at < 0) continue;
      const format1 = view.getUint16(sub + 4);
      const format2 = view.getUint16(sub + 6);
      const format = view.getUint16(sub);
      if (format === 1) {
        const set = sub + view.getUint16(sub + 10 + at * 2);
        const size = 2 + valueSize(format1) + valueSize(format2);
        for (let k = 0, n = view.getUint16(set); k < n; k++) {
          const pair = set + 2 + k * size;
          if (view.getUint16(pair) === right) return xAdvance(view, pair + 2, format1);
        }
      } else if (format === 2) {
        const class1 = classOf(view, sub + view.getUint16(sub + 8), left);
        const class2 = classOf(view, sub + view.getUint16(sub + 10), right);
        const size = valueSize(format1) + valueSize(format2);
        return xAdvance(view, sub + 16 + (class1 * view.getUint16(sub + 14) + class2) * size, format1);
      }
    }
    return 0;
  };
}

export function metrics(data: ArrayBuffer | Uint8Array): Metrics {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const t = tables(view);
  const head = t.get('head');
  const hhea = t.get('hhea');
  const hmtx = t.get('hmtx');
  const cmap = t.get('cmap');
  if (head === undefined || hhea === undefined || hmtx === undefined || cmap === undefined) throw new Error('not a TrueType font');
  const unitsPerEm = view.getUint16(head + 18);
  const longs = view.getUint16(hhea + 34);
  const glyphs = charToGlyph(view, cmap);
  const width = (g: number) => view.getUint16(hmtx + Math.min(g, longs - 1) * 4);
  const glyph = (char: string) => glyphs.get(char.codePointAt(0) ?? 0) ?? 0;
  const pair = kerning(view, t.get('GPOS'));
  return {
    unitsPerEm,
    advance: (char) => width(glyph(char)),
    kern: (left, right) => pair(glyph(left), glyph(right)),
  };
}

/**
 * What kerning takes off a word's width, in px at `size` (negative when its letters pull together). Satori lays a word
 * out by its bare advances and draws it kerned, so a word with tight pairs («VAULT», «NOVA») ends short of its own
 * box: by this much the next word stands too far. A word may be broken after a hyphen or a slash, and Satori draws
 * what follows as a piece of its own, with no kerning across.
 */
export function wordKern(m: Metrics, word: string, size: number): number {
  const chars = [...word];
  let units = 0;
  for (let i = 0; i < chars.length - 1; i++) if (!/[-/\s]/.test(chars[i]!)) units += m.kern(chars[i]!, chars[i + 1]!);
  return (units / m.unitsPerEm) * size;
}

/** The width of a line in px at `size`, with `tracking` in em between letters (CSS letter-spacing). */
export function lineWidth(m: Metrics, text: string, size: number, tracking = 0): number {
  let units = 0;
  for (const ch of text) units += m.advance(ch);
  return (units / m.unitsPerEm) * size + [...text].length * tracking * size;
}
