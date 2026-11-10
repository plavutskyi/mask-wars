/**
 * Card pages for X: one format, 16:9, laid out at 1200×675 and shot at ×4/3, so the PNG is 1600×900 (BRANDBOOK §10). Built from the frames in `brand/art/web` and the
 * tokens in `brand/tokens.css`; fonts and pictures are inlined, the page loads nothing. One huge number or one huge
 * face, a cold line, the mark. No small print, no addresses, ids or hashes. In the feed the card shrinks to about a
 * fifth, so nothing on it is smaller than 30 px of the layout.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CardKind } from "../detector.ts";
import { winMultiple, WIN_CARD_MIN_MULTIPLE } from "../detector.ts";
import type { LoseCard, MaskBirth, MediaEvent, SealBroken, Unmask, WinCard } from "../event.ts";
import { mask } from "../masks.ts";
import { MARK } from "./mark.ts";
import { parseUsdc, times, usdCard } from "../money.ts";

export const CARD_W = 1200;
export const CARD_H = 675;
/** 1200×675 × 4/3 = 1600×900, the brandbook's card for X. */
export const CARD_SCALE = 4 / 3;

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = join(here, "../../../..");
export const BRAND = join(REPO, "brand");
const require = createRequire(import.meta.url);

const cache = new Map<string, string>();
function once(key: string, make: () => string): string {
  let v = cache.get(key);
  if (v === undefined) cache.set(key, (v = make()));
  return v;
}

export function fontFaces(): string {
  return once("fonts", () =>
    (
      [
        ["Hubot Sans", "@fontsource-variable/hubot-sans/files/hubot-sans-latin-standard-normal.woff2"],
        ["Mona Sans", "@fontsource-variable/mona-sans/files/mona-sans-latin-standard-normal.woff2"],
      ] as const
    )
      .map(([family, file]) => {
        const data = readFileSync(require.resolve(file)).toString("base64");
        return `@font-face{font-family:'${family}';font-weight:200 900;font-stretch:75% 125%;font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2')}`;
      })
      .join("\n"),
  );
}

export const tokens = (): string => once("tokens", () => readFileSync(join(BRAND, "tokens.css"), "utf8"));

export const artUrl = (art: string): string =>
  once(`art:${art}`, () => `data:image/jpeg;base64,${readFileSync(join(BRAND, "art/web", `${art}.jpg`)).toString("base64")}`);

export { MARK };

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const BASE_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${CARD_W}px;height:${CARD_H}px;overflow:hidden;background:var(--ink);color:var(--ice)}
body{position:relative;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.word{font-family:var(--font-word);font-weight:800;font-stretch:125%;text-transform:uppercase;letter-spacing:.01em;line-height:.98}
.num{font-family:var(--font-num);font-weight:800;font-stretch:125%;font-variant-numeric:lining-nums;letter-spacing:-.01em;line-height:1}
.say{font-family:var(--font-num);font-weight:500;font-stretch:100%;line-height:1.25}
.mask{position:absolute;right:-40px;top:6%;height:88%;aspect-ratio:1;mix-blend-mode:lighten}
.wide{position:absolute;top:0;left:80px;width:100%;height:100%;object-fit:cover;object-position:right center;mix-blend-mode:lighten}
.mask img{width:100%;height:100%;object-fit:cover;display:block;
  -webkit-mask-image:radial-gradient(closest-side,#000 78%,transparent 100%);mask-image:radial-gradient(closest-side,#000 78%,transparent 100%)}
.col{position:absolute;left:72px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:28px}
.foot{position:absolute;left:72px;bottom:52px;display:flex;align-items:center;gap:14px}
.foot svg{height:36px;width:auto;display:block}
.foot span{font-family:var(--font-word);font-weight:800;font-stretch:125%;font-size:30px;letter-spacing:.02em;line-height:1}
.sim{position:absolute;right:28px;top:22px;font-family:var(--font-num);font-weight:700;font-size:14px;letter-spacing:.18em;color:var(--ice-38)}
.muted{color:var(--ice-60)}
.money{color:var(--money)}
.amber{color:var(--amber)}
.btn{display:inline-flex;align-items:center;height:68px;padding:0 32px;border-radius:var(--radius);background:var(--ember);color:var(--on-accent);
  font-family:var(--font-word);font-weight:800;font-stretch:125%;font-size:30px;letter-spacing:.02em;align-self:flex-start}
`;

/** Shrinks every `[data-fit]` until it fits its box, then says the page is ready. */
export const FIT_JS = `
document.fonts.ready.then(() => {
  for (const el of document.querySelectorAll('[data-fit]')) {
    const maxW = Number(el.dataset.fit), maxH = Number(el.dataset.fitH || 1e9);
    let size = parseFloat(getComputedStyle(el).fontSize);
    while ((el.scrollWidth > maxW || el.getBoundingClientRect().height > maxH) && size > 30) { size -= 2; el.style.fontSize = size + 'px'; }
    el.style.width = 'auto';
  }
  window.__cardReady = true;
});`;

function page(body: string, e: MediaEvent, extraCss = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces()}\n${tokens()}\n${BASE_CSS}${extraCss}</style></head>
<body>${body}${e.source === "SIMULATED" ? '<div class="sim">SIMULATED</div>' : ""}
<div class="foot"><svg viewBox="0 0 240 280" aria-hidden="true"><path fill="var(--ice)" d="${MARK}"/></svg><span>MASK WARS</span></div>
<script>${FIT_JS}</script></body></html>`;
}

/** 16:9 frames fill the card with the object on the right; square mask portraits sit in the right slot. */
const WIDE = new Set(["arena", "faceoff", "obsidian", "ring", "unmask"]);
const maskImg = (art: string) =>
  WIDE.has(art) ? `<img class="wide" src="${artUrl(art)}" alt="">` : `<div class="mask"><img src="${artUrl(art)}" alt=""></div>`;

const HOW_LINE: Record<WinCard["how"], string> = {
  underdog: "ON THE UNDERDOG",
  comeback: "ON THE COMEBACK",
  last_call: "ON LAST CALL",
  called_it: "CALLED IT",
  streak: "ON A STREAK",
};

export function winCard(e: WinCard): string {
  const m = winMultiple(e);
  if (m < WIN_CARD_MIN_MULTIPLE) throw new Error(`a win card starts at ×${WIN_CARD_MIN_MULTIPLE}: this one is ${times(m)}`);
  return page(
    `${maskImg(mask(e.mask).art)}
<div class="col" style="padding-bottom:40px">
  <div class="num" data-fit="740" style="font-size:150px;white-space:nowrap"><span class="muted" style="color:rgba(238,241,255,.55)">${usdCard(parseUsdc(e.stake))}</span> <svg viewBox="0 0 100 60" style="height:.42em;width:auto;margin:0 .06em;vertical-align:.14em" aria-hidden="true"><path d="M4 30H88M64 6l26 24-26 24" fill="none" stroke="var(--ice-38)" stroke-width="9"/></svg> <span class="money">${usdCard(parseUsdc(e.payout))}</span></div>
  <div class="word" style="font-size:42px;white-space:nowrap"><span class="num amber" style="font-size:44px">${times(m)}</span> ${HOW_LINE[e.how]}</div>
</div>`,
    e,
  );
}

export function loseCard(e: LoseCard): string {
  const w = mask(e.winner);
  return page(
    `${maskImg(w.art)}
<div class="col" style="padding-bottom:64px;width:620px">
  <div class="word muted" style="font-size:32px">${w.name}</div>
  <div class="word" data-fit="600" data-fit-h="300" style="font-size:64px;width:600px;line-height:1.02">“${esc(e.line)}”</div>
  <div class="btn">RUN IT BACK</div>
</div>`,
    e,
  );
}

export function unmaskCard(e: Unmask): string {
  const m = mask(e.mask);
  return page(
    `<img src="${artUrl("unmask")}" alt="" style="position:absolute;top:0;left:250px;height:100%;width:auto;mix-blend-mode:lighten">
<div class="col" style="padding-bottom:56px;width:560px">
  <div class="word" data-fit="560" style="font-size:104px;white-space:nowrap">${m.name}</div>
  <div class="word" data-fit="560" style="font-size:104px;white-space:nowrap">WAS <span class="amber">${esc(e.was)}</span></div>
  <div class="say muted" data-fit="540" data-fit-h="140" style="font-size:34px;width:540px">“${esc(e.thought)}”</div>
</div>`,
    e,
  );
}

export function birthCard(e: MaskBirth): string {
  return page(
    `${maskImg(e.art)}
<div class="col" style="padding-bottom:56px;width:600px">
  <div class="word" data-fit="640" style="font-size:132px;white-space:nowrap">${esc(e.name)}</div>
  <div class="say" data-fit="560" data-fit-h="200" style="font-size:40px;width:560px;font-weight:600">“${esc(e.phrase)}”</div>
</div>`,
    e,
  );
}

export function sealCard(e: SealBroken): string {
  const m = mask(e.mask);
  return page(
    `${maskImg(m.art)}
<div class="col" style="padding-bottom:40px">
  <div class="num money" data-fit="700" style="font-size:200px;white-space:nowrap">${usdCard(parseUsdc(e.bank))}</div>
  <div class="word" style="font-size:42px;white-space:nowrap">${m.name} CRACKED</div>
</div>`,
    e,
  );
}

export function cardHtml(kind: CardKind, e: MediaEvent): string {
  if (kind === "win" && e.type === "win_card") return winCard(e);
  if (kind === "lose" && e.type === "lose_card") return loseCard(e);
  if (kind === "unmask" && e.type === "unmask") return unmaskCard(e);
  if (kind === "birth" && e.type === "mask_birth") return birthCard(e);
  if (kind === "seal" && e.type === "seal_broken") return sealCard(e);
  throw new Error(`no ${kind} card for a ${e.type} event`);
}
