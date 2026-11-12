# @maskwars/brand

The brand's tokens, fonts and icons, in one package for the site, the share cards and the clips. The rules they follow,
covering the mark, colour, type, the masks, motion and voice, are in [BRAND.md](../../BRAND.md).

## Status

The site at maskwars.xyz uses this package on every page. `apps/web/app/globals.css` imports
`@maskwars/brand/tokens.css`, `apps/web/app/fonts.ts` loads the two `.woff2` fonts, `apps/web/lib/card.tsx` draws the
share cards with the four `.ttf` cuts, and the 3D arena takes its colours from `color`. `packages/media` takes `color`
for its clips.

## Tokens

`src/tokens.ts` is the single source.

| Export | What it holds |
| --- | --- |
| `color` | 12 colours: `ink` and `ink2` (stage, panels), `ice`, `ice60` and `ice38` (text), `line`, `ember` and `violet` (left and right corner), `money`, `amber` (result only), `live` (LIVE and refusal only), `onAccent` |
| `radius` | `2px` |
| `font` | `word` is Hubot Sans and `num` is Mona Sans, through the `--font-hubot` and `--font-mona` variables the app's font loader sets |
| `scale` | Type sizes in px, desk and phone |
| `motion` | Timings in ms, such as the press, the bell, the leader's pulse and the eyes' cycle |

`tokens.css` is generated from it (`pnpm --filter @maskwars/brand gen`). `src/tokens.test.ts` fails when that file is
out of date, or when any colour or the radius differs from the repository's `brand/tokens.css`.

## Fonts

`fonts/` holds Hubot Sans and Mona Sans cut down to what the site and the cards print. That means Basic Latin and a few
signs, with kerning, ligatures and tabular figures. `hubot-sans.woff2` (weight 800) and `mona-sans.woff2` (weights 400
to 800) serve the site, both with width 85 to 125. Four `.ttf` cuts serve the share cards, because the card renderer
reads no woff2 and no variations. The fonts are under the SIL OFL 1.1, with the licences next to them; as Modified
Versions, their internal names are "MW Word" and "MW Num". `scripts/fonts.py` builds them from the
`@fontsource-variable` packages pinned here, and checks every glyph and pair against the source before it writes.

```bash
pip install fonttools brotli uharfbuzz && pnpm --filter @maskwars/brand fonts
```

## Run its tests

```bash
pnpm --filter @maskwars/brand test        # tokens.css is current and matches brand/tokens.css
pnpm --filter @maskwars/brand typecheck
```

## Key files

| File | What it does |
| --- | --- |
| `src/tokens.ts` | Colours, radius, fonts, type scale, motion |
| `src/tokens.test.ts` | Keeps `tokens.css` and `brand/tokens.css` in step with the source |
| `tokens.css` | The CSS custom properties, generated |
| `scripts/gen.ts` | Writes `tokens.css` |
| `scripts/fonts.py` | Cuts and checks the fonts |
| `fonts/` | The font files and their OFL licences |
| `assets/` | The mark as `favicon.ico`, `icon.svg` and `apple-touch-icon.png` |
