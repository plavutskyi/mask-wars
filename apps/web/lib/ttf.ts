// Advance widths straight from a TrueType file: enough to fit a line to a card before Satori draws it.

export interface Metrics {
  readonly unitsPerEm: number;
  /** Advance of a character in font units; a character the font lacks takes the width of `.notdef`. */
  advance(char: string): number;
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
  return {
    unitsPerEm,
    advance: (char) => width(glyphs.get(char.codePointAt(0) ?? 0) ?? 0),
  };
}

/** The width of a line in px at `size`, with `tracking` in em between letters (CSS letter-spacing). */
export function lineWidth(m: Metrics, text: string, size: number, tracking = 0): number {
  let units = 0;
  for (const ch of text) units += m.advance(ch);
  return (units / m.unitsPerEm) * size + [...text].length * tracking * size;
}
