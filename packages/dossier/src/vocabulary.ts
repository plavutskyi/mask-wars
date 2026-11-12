// The words a page may write. A sentence tells what the facts it cites tell, in their words: every word it writes is a
// word of one of those facts, or one of the few below. Those only join facts (grammar), name the arena's own things, or
// tell a step or an outcome the gate itself reads against the chain (who drained it, who was paid, whether it held,
// what the judge said). Any other word (a kind of bug, a motive, a label, a party nobody named) is refused: a model
// cannot add a fact in words that no fact and no check stands behind.

import type { Evidence } from "./types.ts";

/** Words that join facts and say nothing of their own. */
const GRAMMAR = `
a an the this that these those it its itself they them their themselves there here
and or but nor neither either so then than also too both each every all any some
no not never nobody none nothing only just still yet already again once
is are was were be been being has have had having do does did done
isn't aren't wasn't weren't hasn't haven't hadn't doesn't didn't
of to in on at by for from into onto out over up down off with within without through past
after before during until till since between across about around under above below behind against per via toward towards
as like unlike when while whereas where which who whom whose what how
own same other another more less most much many few such whole full entire new last right together plus
one ones later earlier afterwards meanwhile instead even yes
`;

/**
 * The arena's own things, as the prompt names them, and the words for a step or an outcome the gate reads against the
 * chain (slots.ts and the outcome and judge checks of page.ts): the race, the safe, the masks, the bounty, the judge;
 * who opened, moved, drained, claimed and was paid; whether it held or fell; what the judge said.
 */
const ARENA = `
mask masks wars near utc ai agent agents arena chain mainnet testnet race races raced racing round rounds safe safes
vault target targets training purpose bounty bounties judge judges claim claims claimed claiming team teams contract
contracts code hash fingerprint wasm deadline deadlines start started began begin end ended ending close closed time
moment day date timeline step steps transaction account owner owners owned ownership control sandbox run runs ran
running line course distance clock window set sat sit need needed happened top way left leave draw drew
open opened opening kick kicked lock locked locks stake staked put puts funded fund funding loaded load
call calls called move moves moved moving make makes made making try tried
drain drains drained draining break breaks broke broken breaking sweep sweeps swept emptied empty cracked crack
breached compromised exploited stole steal robbed looted raided grabbed pulled cleared clear
take takes took taken taking get gets got gotten win wins won winner winning lose loses lost
hit hits beat beaten fell fall falls held hold holds survived withstood stood standing stand stands kept keep keeps
untouched intact unbroken repelled lasted last lasts expired concluded finished
pay pays paid paying payout payouts payment money amount total haul loot prize sum reward rewards rewarded award awarded
cut cost costs short
send sends sent give gives gave given hand handed return returned returns refund refunded back release released
come comes came go goes went gone bring brought reach reached
earn earned earns secured pocketed collected received receive netted banked bagged scored landed picked cashed
walked away home
confirm confirms confirmed confirming confirmation confirmations refuse refuses refused refusing refusal refusals
reject rejected rejection approve approved approval accept accepted deny denied denial decline declined dismiss
dismissed bounced upheld uphold sided side waved favor favour backed granted valid validated verified convinced succeeded
successful fail fails failed failure thrown threw found turned turn judged ruled ruling verdict say says said
sealed seal seals plan plans showed show shown revealed reveal
`;

const FIXED: ReadonlySet<string> = new Set(`${GRAMMAR} ${ARENA}`.split(/\s+/).filter(Boolean));

/**
 * A word's root, so that `raced` meets `race`, `owner` meets `owned` and `bounties` meets `bounty`: one suffix off, a
 * doubled last consonant halved, a final `e` dropped. Never a dictionary: two words meet only when they share a root.
 */
export function root(word: string): string {
  let s = word.toLowerCase().replace(/[’]/g, "'").replace(/'s$|'$/, "");
  if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else {
    for (const suffix of ["ing", "ed", "es", "er", "ly", "s"]) {
      if (suffix === "s" && s.endsWith("ss")) break;
      if (s.endsWith(suffix) && s.length - suffix.length >= 3) {
        s = s.slice(0, -suffix.length);
        break;
      }
    }
  }
  if (/([b-df-hj-np-tv-z])\1$/.test(s) && !/(?:ll|ss)$/.test(s)) s = s.slice(0, -1);
  return s.replace(/e$/, "");
}

const FIXED_ROOTS: ReadonlySet<string> = new Set([...FIXED].map(root));

/** Every word a fact writes, as it reads in its sentence and in its data. */
function wordsOf(e: Evidence): string[] {
  const strings = [e.fact, ...Object.values(e.data).flatMap((v) => (typeof v === "string" ? [v] : Array.isArray(v) ? v : []))];
  return strings.flatMap((s) => s.match(WORD) ?? []).flatMap((w) => w.split("-"));
}

const WORD = /[\p{L}_][\p{L}\p{N}_'’-]*/gu;

/**
 * The words of a sentence that neither the facts it cites nor the fixed words above write, in the order they stand.
 * `text` has its slots and the facts' account-shaped names set aside already; `isName` says which words are names of
 * those facts (NOVA, set_owner), which the names check reads instead.
 */
export function strangeWords(text: string, facts: readonly Evidence[], isName: (w: string) => boolean): string[] {
  const known = new Set<string>();
  for (const e of facts) for (const w of wordsOf(e)) known.add(root(w));
  const out: string[] = [];
  // A possessive is its name's: `race-0001's` with the name set aside leaves `'s`, no word.
  for (const token of text.replace(/['’]s\b/g, " ").match(WORD) ?? []) {
    if (isName(token)) continue;
    for (const part of token.split("-").filter((p) => /\p{L}/u.test(p))) {
      if (isName(part)) continue;
      const lower = part.toLowerCase().replace(/’/g, "'");
      if (FIXED.has(lower) || FIXED.has(lower.replace(/'s$/, ""))) continue;
      const r = root(lower);
      if (FIXED_ROOTS.has(r) || known.has(r)) continue;
      out.push(part);
    }
  }
  return [...new Set(out)];
}
