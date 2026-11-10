/**
 * The race's cards for X, one per post, 1600×900 (BRANDBOOK §10). Each says one thing in the feed, where the card
 * shrinks to about a fifth: one big number or one big line, a face, the mark. Built from `brand/art/web` and the
 * brand tokens; fonts and pictures are inlined, the page loads nothing. Every number comes from the story, and a
 * sealed round's card says only what its record holds. A card drawn from a made-up record carries the SIMULATED band
 * across the whole picture.
 */

import { artUrl, esc, FIT_JS, fontFaces, MARK, simulatedMark, tokens } from "../cards/html.ts";
import { near, nearShort } from "./near.ts";
import type { RaceStory, StoryMask } from "./story.ts";
import { dayOf, SITE, timeOf } from "./story.ts";
import type { RaceCardKind } from "./thread.ts";

export const RACE_CARD = { width: 1600, height: 900 } as const;

const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1600px;height:900px;overflow:hidden;background:var(--ink);color:var(--ice)}
body{position:relative;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.w{font-family:var(--font-word);font-weight:800;font-stretch:125%;text-transform:uppercase;letter-spacing:.01em;line-height:.98}
.n{font-family:var(--font-num);font-weight:800;font-stretch:125%;font-variant-numeric:lining-nums;letter-spacing:-.01em;line-height:.92}
.s{font-family:var(--font-num);font-weight:500;font-stretch:100%;line-height:1.3}
.money{color:var(--money)}
.amber{color:var(--amber)}
.dim{color:var(--ice-60)}
.faint{color:var(--ice-38)}
.floor{position:absolute;inset:0;background:radial-gradient(46% 64% at 74% 52%,var(--ink-2) 0%,var(--ink) 74%)}
.art{position:absolute;mix-blend-mode:lighten;display:block}
.sign{position:absolute;left:96px;bottom:72px;display:flex;align-items:center;gap:18px;font-size:36px}
.sign svg{width:40px;height:47px;display:block}
.label{font-size:36px;letter-spacing:.06em}
[data-fit]{width:max-content}
`;

const sign = `<div class="sign w"><svg viewBox="0 0 240 280" aria-hidden="true"><path fill="var(--ice)" d="${MARK}"/></svg>MASK WARS</div>`;

/** After every `[data-fit]` is fitted, a `[data-same]` group takes its smallest size, so a scoreboard reads as one. */
const SAME_JS = `
document.fonts.ready.then(() => {
  const groups = {};
  for (const el of document.querySelectorAll('[data-same]')) (groups[el.dataset.same] ||= []).push(el);
  for (const els of Object.values(groups)) {
    const min = Math.min(...els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
    for (const el of els) el.style.fontSize = min + 'px';
  }
});`;

function page(s: RaceStory, body: string, extraCss = ""): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaces()}\n${tokens()}\n${CSS}${extraCss}</style></head>
<body>${body}${s.simulated ? simulatedMark(RACE_CARD.width) : ""}<script>${FIT_JS}${SAME_JS}</script></body></html>`;
}

/** A square mask portrait whose face fills `h` px of height, placed by its centre. */
const face = (m: StoryMask, cx: number, top: number, h: number, extra = ""): string =>
  `<img class="art" src="${artUrl(m.art)}" alt="" style="left:${cx - h / 2}px;top:${top}px;width:${h}px;height:${h}px;${extra}">`;

const COUNT = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX"];
/**
 * Words with figures in them. The word face draws a barred zero, which reads as a letter in `ROUND 10` or `18:00`, so
 * figures are set in the number face. A sealed round always sets them so; a race told by its sandbox board keeps its
 * line as it was drawn unless a zero is in it.
 */
const figures = (s: RaceStory, text: string): string =>
  s.kind === "round" || text.includes("0")
    ? text
        .split(/(\d[\d.:]*\d|\d)/)
        .map((part, i) => (i % 2 ? `<span style="font-family:var(--font-num)">${part}</span>` : esc(part)))
        .join("")
    : esc(text);

/** The line over a card. A long one (a season, a round and more) shrinks to its box, never under 30 px. */
const label = (s: RaceStory, text: string, max: number, style = ""): string =>
  `<div class="w label dim" data-fit="${max}" style="white-space:nowrap;${style}">${figures(s, text)}</div>`;

/** Post 1: the result. The drain huge in money, who did it, the bounty on top. */
function result(s: RaceStory): string {
  return page(
    s,
    `<div class="floor"></div>
${face(s.winner, 1170, 54, 792)}
<div style="position:absolute;left:96px;top:0;bottom:0;width:860px;display:flex;flex-direction:column;justify-content:center;gap:30px;padding-bottom:40px">
  ${label(s, s.kicker, 860)}
  <div class="n money" data-fit="820" style="font-size:210px;white-space:nowrap">${s.drained} NEAR</div>
  <div class="w" data-fit="860" style="font-size:64px;white-space:nowrap">DRAINED BY ${s.winner.name}</div>
  <div class="w label" style="white-space:nowrap"><span class="n money">+${s.paid} NEAR</span> <span class="dim">BOUNTY ON TOP</span></div>
</div>
${sign}`,
  );
}

/** Post 2: what MASK WARS is. The race's masks on the mirror floor, one line. */
function arena(s: RaceStory): string {
  const n = s.masks.length;
  // The winner stands in the middle and a step closer; the rest flank it in the order they entered.
  const order = [...s.rivals.slice(0, Math.ceil((n - 1) / 2)), s.winner, ...s.rivals.slice(Math.ceil((n - 1) / 2))];
  const span = Math.min(1180, 330 * n);
  const left = 800 - span / 2;
  const masks = order
    .map((m, i) => {
      const big = m.name === s.winner.name;
      const h = big ? 560 : 430;
      const cx = n === 1 ? 800 : left + (span * (i + 0.5)) / n;
      const top = big ? 250 : 330;
      const eyes = big ? "" : "filter:brightness(.72)";
      const shade = `<div style="position:absolute;left:${cx - h * 0.3}px;top:${top + h * 0.08}px;width:${h * 0.6}px;height:${h * 0.86}px;border-radius:50%;background:radial-gradient(closest-side,var(--ink) 62%,rgba(6,5,12,0) 100%)"></div>`;
      return `${shade}${face(m, cx, top, h, eyes)}<img class="art" src="${artUrl(m.art)}" alt="" style="left:${cx - h / 2}px;top:${top + h * 0.84}px;width:${h}px;height:${h}px;transform:scaleY(-1);opacity:.16;${eyes};-webkit-mask-image:linear-gradient(to top,#000 0%,transparent 34%);mask-image:linear-gradient(to top,#000 0%,transparent 34%)">`;
    })
    .join("\n");
  return page(
    s,
    `<img class="art" src="${artUrl("arena")}" alt="" style="inset:0;width:100%;height:100%;object-fit:cover;opacity:.9">
<div style="position:absolute;inset:0;background:linear-gradient(180deg,var(--ink) 0%,rgba(6,5,12,.55) 34%,rgba(6,5,12,0) 60%)"></div>
${masks}
<div style="position:absolute;left:0;right:0;top:80px;display:flex;flex-direction:column;align-items:center;gap:18px">
  <div class="w" data-fit="1400" style="font-size:84px;white-space:nowrap">${COUNT[n]} AI ${n === 1 ? "MASK" : "MASKS"}. ONE VAULT.</div>
  <div class="w" data-fit="1400" style="font-size:52px;white-space:nowrap">THE FIRST ONE IN <span class="money">GETS PAID.</span></div>
</div>
${sign}`,
  );
}

/**
 * Post 3: the race, step by step, each step with its real number. A sealed round is told by its steps on chain: the
 * vault opens, the winner seals its plan, the window runs out, the plan is played, the judge confirms and the
 * contract pays. What the masks did off chain is not on its card.
 */
function how(s: RaceStory): string {
  const masks = s.masks.length === 1 ? "ONE MASK ATTACKS" : `${COUNT[s.masks.length]} MASKS ATTACK`;
  const W = s.winner.name;
  const rows: [string, string][] =
    s.kind === "round"
      ? [
          s.opener === "season"
            ? ["THE TREASURY OPENS A VAULT", `<span class="n money">${s.safe}</span><span class="w unit">NEAR INSIDE</span>`]
            : ["THE VAULT OPENS", `<span class="n money">${s.bounty}</span><span class="w unit">NEAR BOUNTY</span>`],
          [`${W} SEALS ITS PLAN ON CHAIN`, `<span class="n">${s.sealed.short.n}</span><span class="w unit">${s.sealed.short.n === "1" ? s.sealed.short.unit.slice(0, -1) : s.sealed.short.unit} AFTER THE OPENING</span>`],
          ["THE VAULT STAYS LOCKED", `<span class="n">${s.sealMinutes}</span><span class="w unit">${s.sealMinutes === 1 ? "MINUTE" : "MINUTES"} TO SEAL A PLAN</span>`],
          [`${W} PLAYS ITS SEALED PLAN`, `<span class="n money">${s.drained}</span><span class="w unit">NEAR OUT</span>`],
          ["THE JUDGE CONFIRMS THE DRAIN", `<span class="n money">${s.paid}</span><span class="w unit">NEAR PAID TO ${W}</span>`],
        ]
      : [
          ["THE VAULT OPENS", `<span class="n money">${s.bounty}</span><span class="w unit">NEAR BOUNTY</span>`],
          [`${masks} A COPY`, `<span class="n">${s.breach.short.n}</span><span class="w unit">${s.breach.short.unit}, ${W} BREAKS IT</span>`],
          [`${W} HITS THE REAL VAULT`, `<span class="n money">${s.drained}</span><span class="w unit">NEAR OUT</span>`],
          ["THE CONTRACT PAYS", `<span class="n money">${s.paid}</span><span class="w unit">NEAR TO ${W}</span>`],
        ];
  // Four steps take the card as they always did; five sit a little closer, still at 36 px and up.
  const five = rows.length > 4;
  const pad = five ? "11px 0 13px" : "18px 0 20px";
  const value = five ? 50 : 58;
  const gap = five ? 6 : 10;
  return page(
    s,
    `<div class="floor" style="background:radial-gradient(40% 60% at 86% 46%,var(--ink-2) 0%,var(--ink) 72%)"></div>
${face(s.winner, 1330, 120, 660, "opacity:.9")}
${label(s, `${s.title}, STEP BY STEP`, 1000, "position:absolute;left:96px;top:84px")}
<div style="position:absolute;left:96px;top:${five ? 140 : 148}px;width:1000px">
${rows
  .map(
    ([what, value_], i) => `<div style="display:grid;grid-template-columns:76px 1fr;padding:${pad};${i ? "border-top:2px solid var(--line)" : ""}">
    <div class="n faint" style="font-size:36px;padding-top:2px">${String(i + 1).padStart(2, "0")}</div>
    <div><div class="w" data-fit="900" style="font-size:${five ? 38 : 40}px;white-space:nowrap">${what}</div>
    <div style="margin-top:${gap}px;font-size:${value}px;white-space:nowrap;line-height:1" data-fit="900">${value_}</div></div>
  </div>`,
  )
  .join("\n")}
</div>
${sign}`,
    `.unit{font-size:.62em;letter-spacing:.02em;color:var(--ice-60);margin-left:.3em}`,
  );
}

/** Post 4: the race in four numbers, a scoreboard: the numbers all one size, the unit in the line under. */
function numbers(s: RaceStory): string {
  const unit = (u: string) => `<span style="font-size:.36em;letter-spacing:.02em"> ${u}</span>`;
  const cells: [string, string, string][] = [
    [`${s.drained}${unit("NEAR")}`, "money", `DRAINED BY ${s.winner.name}`],
    [`${s.paid}${unit("NEAR")}`, "money", "BOUNTY FROM THE CONTRACT"],
    s.kind === "round"
      ? [s.sealed.short.n, "", `${s.sealed.short.unit} TO SEAL THE PLAN`]
      : [s.breach.short.n, "", `${s.breach.short.unit} TO BREAK IT, ${s.breach.tryWords.toUpperCase()}`],
    [s.judge.seconds, "", "SECONDS FOR THE JUDGE"],
  ];
  return page(
    s,
    `<div class="floor" style="background:radial-gradient(60% 70% at 50% 40%,var(--ink-2) 0%,var(--ink) 76%)"></div>
${label(s, `${s.title} · BY THE NUMBERS`, 1408, "position:absolute;left:96px;top:84px")}
<div style="position:absolute;left:96px;right:96px;top:150px;height:590px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr">
${cells
  .map(
    ([v, cls, what], i) => `<div style="display:flex;flex-direction:column;justify-content:center;gap:20px;padding:0 ${i % 2 ? "0 0 64px" : "48px 0 0"};${i % 2 ? "border-left:2px solid var(--line);" : ""}${i > 1 ? "border-top:2px solid var(--line);" : ""}">
    <div class="n ${cls}" data-fit="620" data-same="score" style="font-size:150px;white-space:nowrap">${v}</div>
    <div class="w dim" data-fit="620" style="font-size:36px;white-space:nowrap">${what}</div>
  </div>`,
  )
  .join("\n")}
</div>
${sign}`,
  );
}

/**
 * Post 5: what to do now. The next round only when the record holds it, and a sealed round's record holds it only as
 * the season treasury's own `next`, read from the chain with the round: its number, its vault, its hour. Without it
 * the card is the call to bring a contract, and no hour is drawn.
 */
function next(s: RaceStory): string {
  const stamp = (at: string): string => `${dayOf(at).toUpperCase()}, ${timeOf(at)} UTC`;
  const upcoming = (name: string, amount: string, under: string): string => `<div class="w label dim">NEXT</div>
  <div class="w" data-fit="760" style="font-size:96px;white-space:nowrap">${figures(s, name)}</div>
  <div class="n money" data-fit="760" style="font-size:120px;white-space:nowrap">${amount} NEAR</div>
  <div class="w label" data-fit="760" style="white-space:nowrap">${figures(s, under)}</div>`;
  const lead =
    s.kind === "round" && s.record.next
      ? upcoming(`${s.opener === "season" ? "ROUND" : "SEASON ROUND"} ${s.record.next.round}`, nearShort(s.record.next.safe), `IN THE VAULT · ${stamp(s.record.next.at)}`)
      : s.kind === "race" && s.record.next
        ? upcoming(`RACE ${Number(s.record.next.id.slice(5))}`, near(s.record.next.bounty), stamp(s.record.next.at))
        : `<div class="w" data-fit="760" style="font-size:96px;line-height:1.02">YOUR<br>CONTRACT<br>IS NEXT.</div>`;
  return page(
    s,
    `<div class="floor" style="background:radial-gradient(44% 64% at 72% 50%,var(--ink-2) 0%,var(--ink) 74%)"></div>
<img class="art" src="${artUrl("ring")}" alt="" style="left:${1210 - 659}px;top:80px;width:1318px;height:740px">
<div style="position:absolute;left:96px;top:0;bottom:0;width:780px;display:flex;flex-direction:column;justify-content:center;gap:34px;padding-bottom:30px">
  ${lead}
  <div class="n" style="font-size:56px;font-stretch:100%;font-weight:700">${SITE}</div>
</div>
${sign}`,
  );
}

export function raceCardHtml(kind: RaceCardKind, s: RaceStory): string {
  switch (kind) {
    case "result":
      return result(s);
    case "arena":
      return arena(s);
    case "how":
      return how(s);
    case "numbers":
      return numbers(s);
    case "next":
      return next(s);
  }
}
