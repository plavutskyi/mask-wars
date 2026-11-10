"""The brand's fonts, cut to what the site and the share cards use.

Source: the variable Hubot Sans and Mona Sans of `@fontsource-variable/*` (Latin, upright), pinned in this package.
Out, next to the licences in `fonts/`:

  hubot-sans.woff2            words on the site: wght 800 only (every rule of the site, BRANDBOOK §4), wdth 85–125
  mona-sans.woff2             numbers and lines on the site: wght 400–800, wdth 85–125
  hubot-sans-800-wdth125.ttf  share cards (Satori reads no woff2 and no variations): words
  hubot-sans-800-wdth85.ttf   share cards: a long name narrows on the width axis, not in size (BRANDBOOK §4)
  mona-sans-800-wdth125.ttf   share cards: numbers
  mona-sans-600.ttf           share cards: the quiet line (wdth 100)

Every file keeps Basic Latin and the few signs the site prints (· × – — ‘ ’ “ ” • … −, no-break space and a handful
more), with kerning, ligatures and tabular figures. Before anything is written, `check()` draws every kept character
and shapes every pair of them with HarfBuzz at every location the site uses, against the source font drawn there.
TrueType keeps whole font units, so instancing may move a point or a pen by a unit or two of 1000 per em; more fails.

Licence: SIL OFL 1.1 with the Reserved Font Names "Hubot" and "Mona". These files are Modified Versions, so their
internal names are "MW Word" and "MW Num"; the copyright and the licence stay in the files and next to them.

Run from the repository root after `pnpm install`:
  pip install fonttools brotli uharfbuzz && python3 packages/brand/scripts/fonts.py
"""

import copy
import io
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

BRAND = Path(__file__).resolve().parent.parent
OUT = BRAND / "fonts"
SOURCE = BRAND / "node_modules" / "@fontsource-variable"

# Basic Latin, then the signs the site and the cards print. Accented letters and combining marks are left out: the
# site is English, names are a–z and 0–9, accounts add . - _ (and a character outside falls back to the system font).
UNICODES = list(range(0x20, 0x7F)) + [
    0x00A0,  # no-break space
    0x00A9,  # ©
    0x00AB, 0x00BB,  # « »
    0x00B0,  # °
    0x00B7,  # ·  the arena's separator
    0x00D7,  # ×  multipliers
    0x2013, 0x2014,  # – —
    0x2018, 0x2019, 0x201C, 0x201D,  # ‘ ’ “ ”
    0x2022,  # •
    0x2026,  # …
    0x2039, 0x203A,  # ‹ ›
    0x20AC,  # €
    0x2191, 0x2193,  # ↑ ↓
    0x2212,  # −  the race clock before the opening
]

# What the browser applies by default (kern, liga) and what the site asks for (tnum, `font-variant-numeric`).
FEATURES = ["kern", "liga", "tnum"]

FAMILY = {"hubot-sans": "MW Word", "mona-sans": "MW Num"}

# (source, file, axis limits): a number pins the axis, a pair keeps the range.
WEB = [
    ("hubot-sans", "hubot-sans.woff2", {"wght": 800, "wdth": (85, 125)}),
    ("mona-sans", "mona-sans.woff2", {"wght": (400, 800), "wdth": (85, 125)}),
]
STATIC = [
    ("hubot-sans", "hubot-sans-800-wdth125.ttf", {"wght": 800, "wdth": 125}),
    ("hubot-sans", "hubot-sans-800-wdth85.ttf", {"wght": 800, "wdth": 85}),
    ("mona-sans", "mona-sans-800-wdth125.ttf", {"wght": 800, "wdth": 125}),
    ("mona-sans", "mona-sans-600.ttf", {"wght": 600, "wdth": 100}),
]

# Where the site draws each family (computed styles of every page, desk and phone): the check covers these and the
# corners of the kept ranges.
CHECK = {
    "hubot-sans": [(800, w) for w in (85, 100, 110, 125)],
    "mona-sans": [(wg, wd) for wg in (400, 500, 600, 700, 800) for wd in (85, 100, 110, 125)],
}


def source(name: str) -> TTFont:
    path = SOURCE / name / "files" / f"{name}-latin-standard-normal.woff2"
    if not path.exists():
        sys.exit(f"{path} is missing: run `pnpm install` first")
    return TTFont(path)


def cut(font: TTFont) -> TTFont:
    opts = subset.Options()
    opts.layout_features = FEATURES
    opts.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14, 16, 17]
    opts.name_legacy = False
    opts.notdef_outline = True
    opts.glyph_names = False
    opts.hinting = True
    opts.recalc_bounds = True
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=UNICODES)
    sub.subset(font)
    return font


def rename(font: TTFont, family: str, style: str) -> None:
    """A Modified Version under the OFL does not carry the Reserved Font Name: the family takes our own name."""
    name = font["name"]
    full = f"{family} {style}".strip()
    ps = full.replace(" ", "")
    version = name.getDebugName(5) or "Version 2.000"
    for rec in list(name.names):
        if rec.nameID in (1, 3, 4, 6, 16, 17) or rec.nameID >= 256 and not referenced(font, rec.nameID):
            name.removeNames(nameID=rec.nameID)
    for nid, text in ((1, family), (2, "Regular"), (3, f"{version.split()[-1]};MASKWARS;{ps}"), (4, full), (5, version), (6, ps)):
        name.setName(text, nid, 3, 1, 0x409)


def referenced(font: TTFont, nid: int) -> bool:
    if "fvar" in font:
        fvar = font["fvar"]
        if any(a.axisNameID == nid for a in fvar.axes) or any(i.subfamilyNameID == nid or i.postscriptNameID == nid for i in fvar.instances):
            return True
    if "STAT" in font:
        stat = font["STAT"].table
        if stat.ElidedFallbackNameID == nid:
            return True
        if stat.DesignAxisRecord and any(a.AxisNameID == nid for a in stat.DesignAxisRecord.Axis):
            return True
        if stat.AxisValueArray and any(v.ValueNameID == nid for v in stat.AxisValueArray.AxisValue):
            return True
    return False


def pin(font: TTFont, wght: int, wdth: int) -> TTFont:
    f = copy.deepcopy(font)
    axes = {a.axisTag for a in f["fvar"].axes} if "fvar" in f else set()
    loc = {k: v for k, v in (("wght", wght), ("wdth", wdth)) if k in axes}
    return instancer.instantiateVariableFont(f, loc) if loc else f


def glyphs(font: TTFont) -> dict:
    """Per character: the advance and the outline, as drawn."""
    from fontTools.pens.recordingPen import DecomposingRecordingPen

    gs = font.getGlyphSet()
    out = {}
    for cp, gname in font.getBestCmap().items():
        if cp not in UNICODES:
            continue
        pen = DecomposingRecordingPen(gs)
        gs[gname].draw(pen)
        out[cp] = (font["hmtx"][gname][0], pen.value)
    return out


def shaper(font: TTFont):
    """HarfBuzz, the shaper of Chrome and Firefox, over this font: `run(text, wght, wdth)` → pen positions."""
    import uharfbuzz as hb

    f = copy.deepcopy(font)
    f.flavor = None
    buf = io.BytesIO()
    f.save(buf)
    hbfont = hb.Font(hb.Face(hb.Blob(buf.getvalue())))
    axes = {a.axisTag for a in f["fvar"].axes} if "fvar" in f else set()

    def run(text: str, wght: int, wdth: int) -> list:
        hbfont.set_variations({k: v for k, v in (("wght", wght), ("wdth", wdth)) if k in axes})
        b = hb.Buffer()
        b.add_str(text)
        b.guess_segment_properties()
        hb.shape(hbfont, b, {"kern": True, "liga": True})
        x, out = 0, []
        for p in b.glyph_positions:
            x += p.x_advance
            out.append(x)
        return out

    return run


def shaped(src: TTFont, made: TTFont, locs, where: str) -> None:
    """Every pair of kept characters, shaped with kerning: each pen position against the source drawn there."""
    a, b = shaper(src), shaper(made)
    chars = [chr(c) for c in UNICODES if c in made.getBestCmap() and c != 0x20]
    for wght, wdth in locs:
        for c1 in chars:
            for c2 in chars:
                pa, pb = a(c1 + c2, wght, wdth), b(c1 + c2, wght, wdth)
                if len(pa) != len(pb):
                    sys.exit(f"{where} wght {wght} wdth {wdth}: {c1}{c2} shapes into other glyphs")
                d = max(abs(x - y) for x, y in zip(pa, pb))
                worst["pair"] = max(worst["pair"], d)
                if d > TOLERANCE["pair"]:
                    sys.exit(f"{where} wght {wght} wdth {wdth}: {c1}{c2} moved {d} units")


# Instancing stores outlines and deltas in whole font units (of 1000 per em), so a kept location can land a unit or
# two away from the source drawn there: 0.07 px a unit on a 72 px number. More than that is a defect.
TOLERANCE = {"outline": 2.5, "advance": 1, "pair": 3}
worst = {"outline": 0.0, "advance": 0, "pair": 0}


def same(a: TTFont, b: TTFont, where: str) -> None:
    ga, gb = glyphs(a), glyphs(b)
    missing = sorted(set(ga) - set(gb))
    if missing:
        sys.exit(f"{where}: lost {''.join(map(chr, missing))!r}")
    for cp in ga:
        (adv_a, pen_a), (adv_b, pen_b) = ga[cp], gb[cp]
        if [op for op, _ in pen_a] != [op for op, _ in pen_b]:
            sys.exit(f"{where}: {chr(cp)!r} outline has other contours")
        d = max((abs(p[i] - q[i]) for (_, pa), (_, pb) in zip(pen_a, pen_b) for p, q in zip(pa, pb) for i in (0, 1)), default=0)
        worst["outline"] = max(worst["outline"], d)
        worst["advance"] = max(worst["advance"], abs(adv_a - adv_b))
        if d > TOLERANCE["outline"] or abs(adv_a - adv_b) > TOLERANCE["advance"]:
            sys.exit(f"{where}: {chr(cp)!r} moved {d:.2f} units, advance {adv_a} → {adv_b}")


def check(name: str, src: TTFont, made: TTFont, locs) -> None:
    for wght, wdth in locs:
        same(pin(src, wght, wdth), pin(made, wght, wdth), f"{name} wght {wght} wdth {wdth}")
    shaped(src, made, locs, name)


def save(font: TTFont, path: Path, flavor) -> int:
    font.flavor = flavor
    buf = io.BytesIO()
    font.save(buf)
    path.write_bytes(buf.getvalue())
    return len(buf.getvalue())


def main() -> None:
    made = {}
    for name, file, limits in WEB:
        src = source(name)
        f = instancer.instantiateVariableFont(copy.deepcopy(src), limits, updateFontNames=False)
        cut(f)
        rename(f, FAMILY[name], "")
        check(name, src, f, CHECK[name])
        made[file] = (f, "woff2", (OUT / file).stat().st_size if (OUT / file).exists() else None)
    for name, file, loc in STATIC:
        src = source(name)
        f = instancer.instantiateVariableFont(copy.deepcopy(src), loc, updateFontNames=False)
        cut(f)
        style = {"hubot-sans-800-wdth125.ttf": "Wide", "hubot-sans-800-wdth85.ttf": "Narrow", "mona-sans-800-wdth125.ttf": "Wide", "mona-sans-600.ttf": "SemiBold"}[file]
        rename(f, FAMILY[name], style)
        check(file, src, f, [(loc["wght"], loc["wdth"])])
        made[file] = (f, None, None)
    print(
        f"every kept character at every location the site draws: outline within {worst['outline']:.2f}, "
        f"advance within {worst['advance']}, every kerned pair within {worst['pair']} units of 1000 per em"
    )
    for file, (f, flavor, before) in made.items():
        n = save(f, OUT / file, flavor)
        print(f"{file:30} {n / 1024:6.1f} KB" + (f"  (was {before / 1024:.1f} KB)" if before else ""))


if __name__ == "__main__":
    main()
