// Slots. A model never writes a number: it writes `{E11.amount_near}`, the id of a fact it cites and one of that fact's
// data fields, and the site puts the value in. Every number on a page is therefore a value read on chain, put there by
// code. What is left to check is that the words around a slot do not give it another meaning than its field has: a
// payout is not written where the sentence says "locked", a count of masks is not written next to "moves".

import type { Evidence } from "./types.ts";

export const SLOT = /\{(E\d{1,3})\.([a-z_]{1,40})\}/g;

export type SlotKind = "amount" | "time" | "duration" | "count" | "other";

export interface SlotMeaning {
  readonly kind: SlotKind;
  /** amount: lock, pay, take, total, fund, back; time and duration: the moment; count: the noun it counts. */
  readonly role: string | null;
}

const TIME_FIELDS = new Set(["at", "date", "time"]);

/** What a fact's field means, from its name and the fact's kind: never from the words a model put around it. */
export function meaningOf(e: Evidence, field: string): SlotMeaning {
  switch (field) {
    case "bounty_locked_near":
      return { kind: "amount", role: "lock" };
    case "bounty_paid_near":
      return { kind: "amount", role: "pay" };
    case "loot_near":
      return { kind: "amount", role: "take" };
    case "took_in_all_near":
      return { kind: "amount", role: "total" };
    case "bounty_back_near":
      return { kind: "amount", role: "back" };
    case "amount_near":
      return { kind: "amount", role: { open: "lock", fund: "fund", drain: "take", paid: "pay", refund: "back" }[e.kind as string] ?? null };
    case "opened":
    case "opened_date":
    case "opened_time":
      return { kind: "time", role: "open" };
    case "deadline":
    case "deadline_date":
    case "deadline_time":
      return { kind: "time", role: "deadline" };
    case "break_after_start":
      return { kind: "duration", role: "drain" };
    case "after_start":
      return { kind: "duration", role: e.kind };
    case "masks_count":
      return { kind: "count", role: "mask" };
    case "moves":
      return { kind: "count", role: "move" };
    case "races_on_this_account":
      return { kind: "count", role: "race" };
    case "seal_number":
      return { kind: "count", role: "seal" };
    case "level":
    case "levels":
      return { kind: "count", role: "level" };
  }
  if (TIME_FIELDS.has(field)) {
    const verdict = e.data["verdict"];
    const role = e.kind === "claim" ? (verdict === "paid" ? "claim_confirmed" : verdict === "no" ? "claim_refused" : "claim") : e.kind;
    return { kind: "time", role };
  }
  return { kind: "other", role: null };
}

/** The value a slot shows: the fact's own field, as a string. `null` when the fact has no such field to show. */
export function valueOf(e: Evidence, field: string): string | null {
  const v = e.data[field];
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
}

/** The text with every slot filled from the facts. */
export function render(text: string, evidence: readonly Evidence[]): string {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  return text.replace(SLOT, (whole, id: string, field: string) => {
    const e = byId.get(id);
    return (e && valueOf(e, field)) ?? whole;
  });
}

// What the words around a slot say it is ------------------------------------------------------------------------------
//
// The words are read on the sentence as the gate prepares it: every slot is `§` and every cited name with a dot in it
// (an account, a hash) or of the library (open-admin) is `§` too, so no dot inside a name ends a clause and no name
// reads as a verb.

type Cue = readonly [RegExp, readonly string[]];

const CLAIM_ANY = ["claim", "claim_confirmed", "claim_refused"];

/** Verbs around an amount, and the roles they allow. A verb wins over a noun. */
const AMOUNT_VERBS: readonly Cue[] = [
  // The safe or the sweep sends what the safe held, never the bounty (listed first: it wins a tie with `took`).
  [/(?<=\b(?:the\s+safe|SAFE-\d+|the\s+sweep|sweep\s+and)\s+)(?:sent|sends|gave|handed|moved|took|lost|paid|pays)\b/gi, ["take"]],
  [/\b(?:lock(?:ed|s|ing)?|put\s+up|staked|stakes)\b/gi, ["lock"]],
  [/\b(?:paid|pays|paying|released|cleared|handed\s+over|delivered|claimed|claims)\b/gi, ["pay"]],
  [/\b(?:reached|went\s+to)\b/gi, ["pay", "take", "total"]],
  [/\b(?:took|takes|taking|won|wins|earned|earns|got|gets|received|receives|collected|walked\s+off\s+with)\b(?!\s+(?:over|back)\b)/gi, ["take", "total", "pay"]],
  [/\b(?:ended\s+up\s+with|left\s+with|went\s+home\s+with|came\s+away\s+with|finished\s+with|make|makes|made\s+up|add\s+up\s+to|adds\s+up\s+to)\b/gi, ["total"]],
  // `came to` links: what came to § is whatever its subject is (`NOVA's haul came to §`, `the bounty came to §`).
  [/\b(?:came|comes|come)\s+to\b/gi, ["lock", "pay", "take", "total", "fund", "back"]],
  // The team that wins back its own bounty is paid it.
  [/\b(?:won|wins|earned)\s+back\b/gi, ["pay", "back"]],
  [/\b(?:pocketed|pockets|made\s+off\s+with|brought|brings|netted|nets|worth|banked|secured|bagged|landed|picked\s+up|scored|made)\b/gi, ["take", "total", "pay"]],
  [/\b(?:robbed|relieved|stripped|bled|coughed\s+up|looted|raided|cleaned\s+out)\b/gi, ["take"]],
  // What the safe held or had in it is what the team put in.
  [/(?<=\b(?:contract\s+(?:Acct\s+)?|bounty\s+(?:pool\s+)?))held\b/gi, ["lock"]],
  [/\b(?:held|holds|had|has|contained|contains)\b(?!\s+(?:the\s+line|out|firm|on)\b)/gi, ["fund"]],
  [/\bawarded\b/gi, ["pay"]],
  [/\b(?:cost|costs)\b/gi, ["take"]],
  // What a drain moved is what the safe sent: never the total, which adds the bounty.
  [/\b(?:drain(?:ed|s|ing)|swe(?:pt|eps)|called\s+sweep|stole|grabbed|pulled|emptied|lost|gave\s+up)\b/gi, ["take"]],
  [/\b(?:sent|sends|handed|gave|given|moved)\s+(?:it|[A-Z]{3,})\b/g, ["take", "pay"]],
  [/\b(?:sent|sends|transferred|gave|given|gives|handed)\b(?!\s+(?:it\s+)?back\b)/gi, ["take", "pay", "back", "fund"]],
  [/\b(?:put|puts|putting|load(?:ed|s|ing)?|fund(?:ed|s|ing)?|deposit(?:ed|s|ing)?|started\s+with|starts\s+with)\b/gi, ["fund"]],
  [/\boffered\b/gi, ["lock"]],
  [/\b(?:refund(?:ed|s)?|return(?:ed|s)?|(?:went|got|sent|came|goes|gets)\s+(?:it\s+)?back)\b/gi, ["back"]],
];
const AMOUNT_NOUNS: readonly Cue[] = [
  [/\b(?:total|all\s+told|overall)\b/gi, ["total"]],
  [/\bwinner['’]s\s+bounty\b/gi, ["pay"]],
  [/\b(?:reward|prize|winnings|winner['’]s\s+(?:share|cut|take|prize|reward)|share)\b/gi, ["pay", "total"]],
  // Listed before the bare bounty, so that `Bounty to NOVA:` wins the tie at the same word.
  [/\b(?:[Bb]ounty|[Pp]ayout|[Pp]rize)\s+to\s+[A-Z]{3,}/g, ["pay"]],
  [/(?<!winner['’]s\s)\bbounty\b(?!\s+contract)/gi, ["lock", "pay", "back"]],
  [/\b(?:sweep|drain|break)\b/gi, ["take"]],
  [/\btake\s+from\s+the\s+(?:safe|sweep|break)\b/gi, ["take"]],
  [/(?<!\btotal\s)\btake\b(?!\s+from\s+the\s+(?:safe|sweep|break)\b)/gi, ["take", "total"]],
  [/(?<!\btotal\s)\bpayout\b/gi, ["pay"]],
  [/(?<!\btotal\s)\bloot\b/gi, ["take"]],
  [/(?<!\btotal\s)\bhaul\b/gi, ["take", "total"]],
  [/\bin\s+the\s+safe\b|\bsafe\s+balance\b/gi, ["fund"]],
  [/\b(?:cut|earnings)\b/gi, ["pay", "total", "take"]],
];
/** Words right after an amount that say what it is. */
const AMOUNT_AFTER: readonly Cue[] = [
  [/^\s*nears?\s+(?:[\w-]+\s+){0,3}(?:in\s+all|in\s+total)\b|^\s*nears?\s+(?:together|combined|altogether)\b/i, ["total"]],
  [/^\s*nears?\s+back\s+as\s+(?:the|its|a)\s+payout\b/i, ["pay"]],
  [/^\s*nears?\s+(?:went|got|sent|came|goes|gets)\s+back\b|^\s*nears?\s+back\b/i, ["back"]],
  [/^\s*nears?\s+(?:(?:of\s+)?bounty\s+)?on\s+the\s+line\b|^\s*nears?\s+(?:behind|into|on|as)\s+(?:the\s+)?bounty\b|^\s*nears?\s+behind\s+(?:race-\d+|it)\b/i, ["lock"]],
  [/^\s*nears?\s+of\s+bounty\b/i, ["lock", "pay", "back"]],
  [/^\s*nears?\s+from\s+the\s+bounty\b/i, ["pay"]],
  [/^\s*(?:NEAR|near)s?\s+(?:over\s+)?to\s+[A-Z]{3,}\b/, ["take", "pay", "total"]],
  [/^\s*nears?\s+(?:(?:sat|stayed|lay|was|were)\s+)?in\s+(?:the\s+safe|it)\b/i, ["fund"]],
  [/^\s*nears?\s+for\s+(?:the|its)\s+claim\b/i, ["pay"]],
  // What went to the winner is what the winner got, never the bounty locked.
  [/^\s*nears?\s*[),]?\s+(?:\w+\s+)?went\s+to\b/i, ["pay", "total", "take"]],
  // Out of the safe, the sweep or the break: what the safe sent, never the total, which adds the bounty.
  [/^\s*nears?\s+(?:out\s+of|from)\s+(?:the\s+(?:safe|sweep|drain|break)\b|it\b|(?:the\s+)?safe-\d+\b)/i, ["take"]],
];

const TIME_VERBS: readonly Cue[] = [
  [/(?<=\bmoney\s)moved\b/gi, ["paid"]],
  [/\bcashed\s+in\b/gi, ["claim_confirmed", "claim", "paid"]],
  [/\bgave\s+\S+\s+the\s+win\b|\bsuccessful\s+claim\b/gi, ["claim_confirmed", "claim"]],
  [/\bwas\s+rewarded\b|\bwent\s+to\s+(?:the\s+team|[A-Z]{3,})\b/g, ["paid"]],
  [/\b(?:open(?:ed|s|ing)|to\s+open|lock(?:ed|s|ing)?|put\s+up|staked|stakes|put\s+§\s+nears?\s+behind|set\s+up)\b/gi, ["open"]],
  [/\b(?:put|puts|putting|load(?:ed|s|ing)?|fund(?:ed|s|ing)?)\b/gi, ["fund"]],
  [/\b(?:called\s+set_owner|set_owner|took\s+(?:the\s+safe\s+|SAFE-\d+\s+)?over)\b/gi, ["move"]],
  // A sweep is a move too.
  [/\bmoved\b/gi, ["move", "drain"]],
  [/\b(?:started|began|kicked\s+off)\b/gi, ["open"]],
  [/\bto\s+(?:break|crack|drain|empty|sweep)\b/gi, ["drain"]],
  [/\b(?:made\s+itself\s+(?:the\s+)?owner|became\s+(?:the\s+)?owner|owned|owner\s+taken|took\s+ownership|took\s+it\s+over)\b/gi, ["move"]],
  [/\b(?:lasted|lasts)\b/gi, ["drain", "deadline", "paid", "refund"]],
  [/(?<=\bpayout\s)cleared\b|\bmoney\s+moved\b|\blanded\s+in\b|\b(?:received|earned)\b(?!\s+(?:\S+\s+){0,3}back\b)/gi, ["paid"]],
  [/\b(?:received|got)\s+(?:\S+\s+){0,3}back\b|\bback\b(?=\s+(?:at|on|to)\b)/gi, ["refund"]],
  [/\bgot\s+§\s+nears?\b(?!\s+back\b)/gi, ["paid"]],
  [/\blost\s+§\s+nears?\b/gi, ["drain"]],
  [/\b(?:drain(?:ed|s|ing)|swe(?:pt|eps)|call(?:ed|s)\s+sweep|broke|broken|breaks(?!\s+in\b)|fell|falls|crack(?:ed|s)|empt(?:ied|ies))\b/gi, ["drain"]],
  [/\b(?:claim(?:ed|s|ing))\b/gi, CLAIM_ANY],
  [/(?<!(?:\bnot|\bnever|n['’]t|\bno|\bno\s+claims?)\s)\b(?:confirm(?:ed|s|ing)?|approv(?:ed|es|al)|accept(?:ed|s)?|upheld|cleared(?!\s+§)|verified|paid\s+off|backed|ruled\s+valid)\b/gi, ["claim_confirmed", "claim"]],
  // A step that went through: a claim the judge confirmed, or a call or payment that landed on chain.
  [/(?<!(?:\bnot|\bnever|n['’]t)\s)\bwent\s+through\b/gi, ["claim_confirmed", "claim", "drain", "move", "paid"]],
  [/\byes\b/gi, ["claim_confirmed", "claim"]],
  [/\bno\b(?=\s+(?:at|to)\b)|\b(?:bounced|knocked\s+back|came\s+to\s+nothing)\b/gi, ["claim_refused", "claim"]],
  [/\b(?:did\s+not|didn['’]t|never)\s+(?:refuse|reject|deny|turn\s+down)\b/gi, ["claim_confirmed", "claim"]],
  [/(?<!(?:\bnot|\bnever|n['’]t)\s)\b(?:refused|refusing|reject(?:ed|s|ing)?|denied|turned\s+down|threw\s+out|refuses|(?:did\s+not|didn['’]t|never|was\s+not|wasn['’]t)\s+(?:confirm(?:ed)?|approv(?:e|ed)|accept(?:ed)?|convinced))\b/gi, ["claim_refused", "claim"]],
  [/\b(?:won|awarded|collected)\b/gi, ["claim_confirmed", "paid"]],
  [/\b(?:decided|won(?=\s+(?:at|on)\b)|won\s+the\s+bounty|took\s+it|got\s+its\s+money|got\s+it|got\s+through|agreed|won(?=\s*[.;,]|\s+it\b)|was\s+(?:successful|valid)|waved\s+(?:\S+\s+){1,3}through|gave\s+\S+\s+the\s+bounty|ruled\s+in\s+\S+\s+favou?r|signed\s+off|succeeded|worked|sided\s+with|granted|said\s+yes|found\s+for|ruled\s+for|validated|won\s+it|collected\s+it)\b/gi, ["claim_confirmed", "claim"]],
  [/\b(?:(?:was\s+not|wasn['’]t)\s+upheld|(?:did\s+not|didn['’]t)\s+stand|declined|turned\s+(?:\S+\s+){1,3}down|knocked\s+(?:\S+\s+){1,3}back|failed|fell\s+through|said\s+no|dismissed|thrown\s+out|ruled\s+against|found\s+against|(?:did\s+not|didn['’]t)\s+go\s+through)\b/gi, ["claim_refused", "claim"]],
  [/\b(?:to\s+take\s+(?:the\s+safe\s+)?over|took\s+control|became\s+the\s+safe['’]s\s+owner)\b/gi, ["move"]],
  [/\b(?:received|got|collected)\s+(?:the\s+|its\s+)?(?:bounty|payout|reward|prize)\b|\b(?:bounty|payout)\s+reached\b/gi, ["paid"]],
  [/\b(?:ran\s+until|(?:set|due)\s+to\s+close|expired|timed\s+out|ran\s+out(?:\s+of\s+time)?)\b/gi, ["deadline"]],
  [/\b(?:closed|closes)\b/gi, ["deadline", "refund", "paid"]],
  [/\b(?:ended|ends|was\s+over|is\s+over|concluded|wrapped\s+up|came\s+to\s+a\s+close|settled)\b/gi, ["deadline", "drain", "paid", "refund"]],
  [/\b(?:paid|pays|paying)\b(?!\s+off\b)/gi, ["paid"]],
  [/\b(?:refund(?:ed|s)?|return(?:ed|s)?|(?:went|got|sent|came)\s+(?:it\s+)?back)\b/gi, ["refund"]],
  [/\bsealed\b/gi, ["seal"]],
  [/\b(?:showed|revealed)\b/gi, ["reveal"]],
  [/\b(?:sent|sends|transferred|released|handed)\b/gi, ["paid", "drain", "refund"]],
];
const TIME_NOUNS: readonly Cue[] = [
  [/\bdeadline\b/gi, ["deadline"]],
  [/\b(?:drain|break|sweep)\b/gi, ["drain"]],
  [/\bclaim\b/gi, CLAIM_ANY],
  [/\b(?:refusals?|rejections?|denials?)\b/gi, ["claim_refused", "claim"]],
  [/\b(?:confirmations?|approvals?)\b/gi, ["claim_confirmed", "claim"]],
  [/\b(?:payout|payment)\b/gi, ["paid"]],
  [/\brefund\b/gi, ["refund"]],
  [/\bopening\b/gi, ["open"]],
];

/** Nouns a count may sit next to, and the stem it then counts. */
const COUNTED = /\b(masks?|moves?|races?|claims?|seals?|steps?|calls?|transactions?|drains?|sweeps?|times|tries|attempts?|rivals?|opponents?|levels?|runs?|days?|hours?|minutes?|seconds?)\b/i;
const stem = (w: string) => w.toLowerCase().replace(/ies$/, "y").replace(/(?<=[a-z]{2}[^s])s$/, "");

const BOUNDARY = [/[;!?]/g, /\.(?!\d)/g, /\b(?:then|but|while|after\s+which)\b/gi, /,\s*(?:and|but|then|so)\b/gi];

/** The clause a slot sits in, up to it: back to the last sentence end, semicolon, `, and`, `then` or `but`. */
export function clauseBefore(before: string): string {
  const cut = Math.max(...BOUNDARY.map((re) => [...before.matchAll(re)].map((m) => m.index + m[0].length).pop() ?? 0));
  return before.slice(cut);
}

/** The clause a slot sits in, from it: up to the next sentence end, semicolon, `, and`, `then` or `but`. */
export function clauseAfter(after: string): string {
  // A colon ends what a slot's clause says after it (`lasted §: NOVA took the safe over`); before it, a colon only
  // labels (`NOVA's loot from the safe: §`).
  const cut = Math.min(...[...BOUNDARY, /:/g].map((re) => [...after.matchAll(re)].map((m) => m.index)[0] ?? after.length));
  return after.slice(0, cut);
}

type Hit = { readonly at: number; readonly roles: readonly string[] };

/** The cue nearest to the slot: the last one before it, or the first one after it. */
function nearest(words: string, cues: readonly Cue[], last: boolean): Hit | null {
  let best: Hit | null = null;
  for (const [re, roles] of cues) for (const m of words.matchAll(re)) if (!best || (last ? m.index > best.at : m.index < best.at)) best = { at: m.index, roles };
  return best;
}

/** The words right after a slot that are its own: up to a comma or a preposition. */
export const ownPhrase = (after: string) => after.split(/,|\b(?:until|till|before|after|from|since|by|to|for|with|when|while|as|once)\b/i)[0] ?? "";

/** The verb nearest a slot: the last in its clause before it, else the first after it up to the next slot. */
function verbAround(before: string, after: string, verbs: readonly Cue[]): readonly string[] | null {
  return (nearest(clauseBefore(before), verbs, true) ?? nearest(clauseAfter(after).split(/§|\band\b|,/i)[0] ?? "", verbs, false))?.roles ?? null;
}

/** A noun brought in after the verb by one of these (`with a deadline of §`) is what the slot is. */
const PREP = /\b(?:with|of|from|in|than|below|under|versus|against|before|after|until|by|and|its|their)\s+(?:the\s+|a\s+|an\s+|its\s+|[A-Za-z]+['’]s\s+)?$/i;

/**
 * The roles the words of a slot's clause allow. The verb nearest it, before or after, and the noun nearest it are read
 * together: the roles both allow when they share any (`the bounty … was paid`: pay), else the verb's. A noun that a
 * preposition brings in after the verb names the slot itself. Nouns are a slot's own: before it, only those since the
 * previous slot or comma; after it, only up to the next slot or a bare `and`. A verb may govern several slots.
 */
function cueAround(before: string, after: string, verbs: readonly Cue[], nouns: readonly Cue[]): readonly string[] | null {
  const b = clauseBefore(before);
  // Past the slot, a clause a subordinator opens (`, once the judge confirmed …`) is another moment's.
  const whole = clauseAfter(after).split(/§|\band\b|\b(?:once|when|while|after|before|until|as\s+soon\s+as)\b/i)[0] ?? "";
  // `Before the race opened, at §, the team put …`: the verb of a leading subordinate clause is that clause's.
  const sub = /^\s*(?:before|after|when|once|while|until|as\s+soon\s+as)\b[^,]*,/i.exec(b);
  const vbFound = nearest(b, verbs, true);
  const vbMain = sub ? nearest(b.slice(sub[0].length), verbs, true) : null;
  const vbAny = vbFound && sub && vbFound.at < sub[0].length ? (vbMain ? { at: vbMain.at + sub[0].length, roles: vbMain.roles } : null) : vbFound;
  // A verb before a colon belongs to the label (`race-0002 ended in a payout: § NEAR to the team at §`).
  // Only when a noun stands between the verb and the colon is the colon a label of its own (`ended in a payout: §`);
  // `The bounty contract paid out: §` keeps its verb.
  const colon = vbAny ? b.indexOf(":", vbAny.at) : -1;
  const label = vbAny && colon >= 0 ? nearest(b.slice(vbAny.at, colon), nouns, true) : null;
  // `NOVA won the bounty: §`: what the verb and the label's noun share still names the slot.
  const shared = vbAny && label ? vbAny.roles.filter((r) => label.roles.includes(r)) : [];
  const vb = vbAny && label ? (shared.length ? { at: vbAny.at, roles: shared } : null) : vbAny;
  // A noun belongs to the slot it stands with: before this one, only the words since the last slot count.
  // `at § and §`: an `and` right after a slot lists, and the phrase before it is this slot's too.
  const since = Math.max(b.lastIndexOf("§"), b.lastIndexOf(","), ...[...b.matchAll(/\band\b/gi)].filter((x) => !/§\s*$/.test(b.slice(0, x.index))).map((x) => x.index + 2)) + 1;
  const nOwn = nearest(b.slice(since), nouns, true);
  // A noun a preposition brings in before a later verb (`§ NEAR from the bounty and took §`) is the earlier phrase's.
  const pp = nOwn && vb && vb.at > nOwn.at + since && /\b(?:from|of|out\s+of|in|into|with|to|for)\s+(?:the\s+|its\s+|a\s+|an\s+)?$/i.test(b.slice(0, nOwn.at + since));
  // So is a noun in the earlier slot's own tail (`§ NEAR from the bounty on top of the §`).
  const tailOfEarlier = nOwn && b.lastIndexOf("§") >= 0 && /^\s*nears?\s+(?:from|of|out\s+of|in|into|for)\s+(?:the\s+|its\s+)?$/i.test(b.slice(b.lastIndexOf("§") + 1, nOwn.at + since));
  const nb = nOwn && !pp && !tailOfEarlier ? { at: nOwn.at + since, roles: nOwn.roles } : null;
  if (nb && vb && vb.at < since) return nb.roles;
  // `paid § NEAR, nearly the whole § NEAR bounty`: past a comma, the slot's own noun after it beats the verb before.
  const naEarly = nearest(ownPhrase(whole), nouns, false);
  if (!nb && naEarly && vb && b.lastIndexOf(",") > vb.at && /^\s*(?:nears?\s+)?$/i.test(ownPhrase(whole).slice(0, naEarly.at))) return naEarly.roles;
  if (nb && (!vb || nb.at > vb.at) && PREP.test(b.slice(0, nb.at)) && !/\band\s+(?:the\s+|a\s+|an\s+|its\s+)?$/i.test(b.slice(0, nb.at))) {
    // A noun that allows more than the verb (`wasn't convinced by NOVA's claim at §`) narrows nothing: the verb says it.
    const both = vb ? vb.roles.filter((r) => nb.roles.includes(r)) : [];
    // `confirmed its drain at §`: the judge's word is the moment, whatever it confirmed.
    if (!both.length && vb && vb.at >= since && vb.roles.includes("claim_confirmed") !== vb.roles.includes("claim_refused")) return vb.roles;
    return both.length ? both : nb.roles;
  }
  // A verb before the previous slot or comma is that phrase's: the slot's own noun names it (`set_owner at §, sweep at §`).
  if (nb && vb && vb.at < since) return nb.roles;
  // Between the previous slot and this one a preposition and no verb or `and` (`§ NEAR out of the safe's §`, `short of
  // the §`): this slot hangs off the earlier one, and the earlier verb is not about it.
  const between = b.lastIndexOf("§") >= 0 ? b.slice(b.lastIndexOf("§") + 1) : null;
  const lastPrep = between === null ? undefined : [...between.matchAll(/\b(out\s+of|of|from|in|into|with|than|below|under|versus|vs|against|compared\s+(?:with|to)|at|on|by|for|to|after|before|until)\b/gi)].at(-1)?.[1]?.toLowerCase().replace(/\s+/g, " ");
  const hangs = between !== null && lastPrep !== undefined && /^(?:out of|of|from|in|into|with|than|below|under|versus|vs|against|compared with|compared to)$/.test(lastPrep) && !/\band\b/i.test(between) && !nearest(between, verbs, true);
  // After the slot, its own phrase ends at a comma or a preposition (`the § NEAR bounty, NOVA was paid`, `from § until
  // its deadline`): a noun past that is another phrase's. Verbs past it are read only when the slot has no noun of its
  // own (`§ after the start, NOVA drained the safe`).
  const own = ownPhrase(whole);
  const na = nearest(own, nouns, false);
  // A slot a preposition brings in (`Of the § NEAR in the safe, NOVA swept`) takes no verb past its own phrase either.
  const a = nb || na || PREP.test(b) ? own : whole;
  const va = nearest(own, verbs, false);
  const postposed = vb !== null && b.lastIndexOf("§") >= 0 && vb.at > b.lastIndexOf("§") && !/^[\w\s]+?\s+(?:at|on|by)\s*$/.test(b.slice(vb.at)) && /^\s*(?:nears?\s+)?(?:(?:it|that|which|they|the\s+(?:team|safe|judge)|[A-Z]{3,})\s+)?$/.test(b.slice(b.lastIndexOf("§") + 1, vb.at).replace(/near/gi, "NEAR").replace(/^\s*NEARS?\s+/, ""));
  const stale = vb !== null && (postposed || (va !== null && vb.at < Math.max(b.lastIndexOf("§"), b.lastIndexOf(","))));
  const verb = (hangs || stale ? null : vb) ?? nearest(a, verbs, false) ?? va;
  const noun = nb ?? na;
  if (verb && noun) {
    const both = verb.roles.filter((r) => noun.roles.includes(r));
    if (both.length) return both;
    // `the § NEAR payout make §`: a verb past the slot's own noun has the slot for subject, and the noun says what it is.
    if (na && (hangs || stale || !vb)) return na.roles;
  }
  return (verb ?? noun)?.roles ?? null;
}

/**
 * A slot whose meaning the words around it contradict, with what those words say; `null` when nothing contradicts.
 * `before` and `after` are the sentence around the slot as the gate prepares it (see above).
 */
export function contradiction(meaning: SlotMeaning, before: string, after: string): string | null {
  const { kind, role } = meaning;
  if (/^\s*$/.test(clauseBefore(before)) && /^\s*:/.test(after)) after = after.replace(/^\s*:\s*/, " ");
  // A count, or a field that is no amount, is never an amount; a duration is never a time of day.
  if ((kind === "count" || kind === "other") && /^\s*nears?\b/i.test(after)) return "amount";
  if (kind === "duration" && /\bat\s*$/i.test(before)) return "time";
  if (!role) return null;
  // `a bounty of §`, `the deadline of §`, `the deadline of race-0001, §`: the noun the slot stands for names it.
  const of =
    /\b(bounty|payout|loot|haul|deadline)\s+of\s+(?:the\s+)?$/i.exec(before)?.[1] ??
    /\b(deadline)(?:\s+of\s+(?:the\s+)?[\w-]+)?\s*,\s*$/i.exec(before)?.[1] ??
    // `The payout, § NEAR, landed`: a noun that opens the clause and a comma.
    /^\s*(?:the\s+|[A-Za-z]+['’]s\s+)?(?:total\s+)?(payout|loot|haul|bounty|total|take)\s*,\s*$/i.exec(clauseBefore(before))?.[1];
  if (kind === "amount") {
    // What the words after the amount say happened to all of it (`§ NEAR, all of it swept by NOVA`, `§ NEAR, paid to
    // NOVA`, `§ NEAR … went to NOVA`, `…, and NOVA took it all`): money taken or paid, never money put in or locked.
    const fate = /^\s*nears?\b[^.;!?§]*?,\s*(?:(?:all|every\s+bit)\s+(?:of\s+)?(?:it\s+|them\s+)?|which\s+[A-Z]{3,}\s+|that\s+[A-Z]{3,}\s+)?(paid|swept|taken|took|drained|sent|won|collected|pocketed|went\s+to)\b/i.exec(after)?.[1]
      ?? /^[^.;!?§]*\b(?:(?:took|swept|drained|got|won|pocketed|collected)\s+it\s+all|went\s+(?:out\s+)?to\s+[A-Z]{3,}|(?:was|were)\s+(?:paid|sent)\s+(?:out\s+)?to\s+[A-Z]{3,})\b/.exec(after)?.[0];
    if (fate && (role === "fund" || role === "lock")) return "take";
    // `In all, NOVA took §`: a total, whatever the verb.
    // Words right after an amount (`in all`, `from the bounty`) say what it is, together with the verb; `§ NEAR back`
    // is money that went back, whatever brought it.
    const opening = clauseBefore(before);
    const front = /^\s*(?:of|from|out\s+of)\s+(?:the\s+|a\s+)?(?:§\s+nears?\s+)?bounty\b[^,]*,/i.test(opening)
      ? (["pay"] as const)
      : /^\s*(?:(?:of|from|out\s+of)\s+(?:the\s+|its\s+)?(?:§\s+nears?\s+in\s+the\s+safe|safe|safe-\d+|sweep|drain|break)|(?:in|with)\s+(?:the\s+|its\s+)?(?:sweep|drain|break))\b/i.test(opening)
        ? (["take"] as const)
        : null;
    const tail = AMOUNT_AFTER.find(([re]) => re.test(after))?.[1] ?? front;
    // `§ NEAR from the sweep and § NEAR payout came to §`: what two amounts came to is their total.
    if (/\b(?:came|comes|come|add(?:s|ed)?\s+up)\s+to\s*$/i.test(before) && (clauseBefore(before).match(/§/g) ?? []).length >= 2) return role === "total" ? null : "total";
    // `In all, NOVA took §`: a total, whatever the verb, unless the words right after it say what it is.
    if (!tail && /^\s*(?:in\s+all|in\s+total|overall|all\s+told)\b[^:]*$/i.test(clauseBefore(before))) return role === "total" ? null : "total";
    if (tail?.[0] === "back") return role === "back" ? null : "back";
    if (tail?.length === 1 && tail[0] === "lock") return role === "lock" ? null : "lock";
    // `§ NEAR in all from the safe`: what came from the safe, whatever else the words say.
    if (/^\s*nears?\s+in\s+(?:all|total)\s+(?:out\s+of|from)\s+(?:the\s+safe|it|(?:the\s+)?safe-\d+)\b/i.test(after)) return role === "take" ? null : "take";
    // `§ NEAR out of the safe`, `from the safe`: what the safe sent, whatever the verb.
    if (tail?.length === 1 && tail[0] === "take" && /^\s*nears?\s+(?:out\s+of|from)\s+(?:the\s+safe|it|(?:the\s+)?safe-\d+)\b/i.test(after)) return role === "take" ? null : "take";
    const nounRoles = (w: string) => AMOUNT_NOUNS.find(([re]) => new RegExp(re.source, "i").test(w))?.[1] ?? null;
    // `of the § NEAR bounty`: a noun right after the amount, the two brought in by a preposition, names it alone.
    const compound = /^\s*nears?\s+(bounty|payout|loot|haul|reward|prize|winnings|total)\b/i.exec(after)?.[1];
    // `the bounty of § NEAR was returned`: the noun the slot is of, and what the verb did with it.
    const ofHead = () => {
      const noun = nounRoles(of!);
      // `The bounty, § NEAR, was paid to NOVA`: past the closing comma of an apposition comes its verb.
      const appos = /,\s*$/.test(before) ? after.replace(/^\s*nears?\s*,/i, " ") : after.replace(/^\s*nears?\b/i, "");
      const verb = verbAround(before, appos, AMOUNT_VERBS);
      const both = noun && verb ? noun.filter((r) => verb.includes(r)) : [];
      // `the bounty of §` with no verb that pays it is the bounty locked (or what went back), never what was paid.
      if (of === "bounty" && /\b(?:from|of|out\s+of)\s+(?:a|the)\s+bounty\s+of\s+$/i.test(before)) return ["lock", "back"];
      return both.length ? both : of === "bounty" ? ["lock", "back"] : noun;
    };
    // `The team's § NEAR bounty`: the team's own bounty is what it locked (and what went back to it).
    const anyVerb = verbAround(before, after.replace(/^\s*nears?\s+bounty\b/i, ""), AMOUNT_VERBS);
    if (/^\s*nears?\s+bounty\b/i.test(after) && /\bteam['’]s\s*$/i.test(before) && (!anyVerb || anyVerb.some((r) => r === "lock" || r === "back"))) return role === "lock" || role === "back" ? null : "lock";
    // `put a § NEAR bounty on open-admin`: a noun the amount stands in front of names it when the verb says nothing
    // the noun allows.
    const verbHere = verbAround(before, after.replace(/^\s*nears?\b/i, ""), AMOUNT_VERBS);
    // `claimed the § NEAR bounty`: the bounty it claimed is the bounty locked.
    const article = compound && (/\b(?:a|an)\s*$/i.test(before) || (compound === "bounty" && /\bclaimed\s+(?:the|a|its)\s*$/i.test(before))) ? nounRoles(compound) : null;
    const articleHead = article && verbHere && (!article.some((r) => verbHere.includes(r)) || /\bclaimed\s+(?:the|a|its)\s*$/i.test(before)) ? article : null;
    const head = articleHead ?? (compound && PREP.test(before) && !/\band\s+(?:the\s+|a\s+|an\s+|its\s+)?$/i.test(before) ? nounRoles(compound) : of ? ofHead() : cueAround(before, after.replace(/^\s*nears?\b/i, ""), AMOUNT_VERBS, AMOUNT_NOUNS));
    // `NOVA was paid §, for § NEAR in all`: a verb before an earlier slot, with none since, gives way to the words
    // right after this one.
    const cb = clauseBefore(before);
    const stale = cb.includes("§") && !nearest(cb.slice(cb.lastIndexOf("§") + 1), AMOUNT_VERBS, true);
    const roles = tail && head && !stale ? tail.filter((r) => head.includes(r)) : (tail ?? head);
    if (roles && !roles.length) return [...(tail ?? []), ...(head ?? [])].find((r) => r !== role) ?? null;
    return roles && !roles.includes(role) ? roles[0]! : null;
  }
  if (kind === "duration") {
    // `§ after the start`, `§ after it opened`: the moment it is counted from, not what happened at its end.
    const fromStart = /^\s*after\s+(?:the\s+(?:start|opening)|(?:it|the\s+race|race-\d+)\s+(?:opened|began|started))\b/i;
    if (fromStart.test(after)) after = after.replace(fromStart, "");
    // A length counted from another moment (`§ later`, `§ after it called set_owner`) is no length from the start.
    else if (/^\s*(?:later|earlier|afterwards|after\b|before\s+(?:the|its)\s+deadline)\b/i.test(after) && !(/^\s*later\b/i.test(after) && /\b(?:opened|started|began|opening|start|raced\s+from)\b/i.test(before))) return "other";
  }
  if (kind === "time" || kind === "duration") {
    // `drained SAFE-0001 at the deadline, §`: the verb says the moment, and it is no deadline.
    if (role === "deadline" && /\bat\s+(?:the|its)\s+deadline(?:\s+of\s+[\w-]+)?\s*,\s*$/i.test(before)) {
      const v = verbAround(before, after, TIME_VERBS);
      if (v && !v.includes("deadline")) return v[0]!;
    }
    if (role === "open" && /\b(?:from|since)\s*$/i.test(before)) return null;
    if (role === "deadline") {
      // `before §`, `until §`, `by §` bound a time: the deadline fits there. A deadline named since the last slot, with
      // no verb after it (`set the deadline for §`, `until its deadline, §`), names the slot.
      if (/\b(?:before|until|by|to|through|till)\s*$/i.test(before)) return null;
      const seg = before.slice(before.lastIndexOf("§") + 1);
      const named = [...seg.matchAll(/\bdeadline\b/gi)].at(-1);
      if (named && !nearest(seg.slice(named.index), TIME_VERBS, true)) return null;
    }
    // `at § with sweep`, `at § with set_owner`: the call named right after the time is the step it is the time of.
    const method = /^\s*(?:with|by\s+calling|via)\s+(?:a\s+)?(sweep|set_owner)\b/i.exec(after)?.[1]?.toLowerCase();
    const roles = of === "deadline" ? ["deadline"] : method ? [method === "sweep" ? "drain" : "move"] : cueAround(before, after, TIME_VERBS, TIME_NOUNS);
    return roles && !roles.includes(role) ? roles[0]! : null;
  }
  if (kind === "count") {
    // `§ moves each` hands every mask the whole count.
    if (/^\s+[\p{L}]+\s+each\b/iu.test(after)) return "each";
    // `§ of them`, `§ of the § masks`: a part of something counted, which no count of the facts is unless it names it.
    const part = /^\s+of\s+(?:them\b|(?:the|its|their)\s+(?:§\s+)?([\p{L}]+))/iu.exec(after);
    if (part) return part[1] && stem(part[1]) === role ? null : "part";
    const next = COUNTED.exec(after.replace(/\brace-\d+\b/gi, " ").slice(0, 32).split(/[.;!?§]/)[0] ?? "");
    const label = /\b(masks?|moves?|races?|claims?|seals?|levels?)\b[^.;!?§]{0,30}?(?::|\b(?:was|were|is|are|came\s+to))\s*$/i.exec(before);
    const noun = next?.[1] ?? label?.[1];
    if (!noun) return null;
    // `§ times` counts steps, or races where the words say raced: never masks, levels or claims.
    if (stem(noun) === "time")
      return (role === "move" && /\b(?:mov(?:ed|es?)|call(?:ed|s)?|made|hit|struck|swept|set_owner|sweep|tried|stepped)\b/i.test(clauseBefore(before))) || role === "seal" || (role === "race" && /\b(?:raced|race[ds]?\s+on|targeted|in\s+the\s+arena)\b/i.test(clauseBefore(before))) ? null : "time";
    // A move is a call on the safe: a step, a call, a transaction.
    if (role === "move" && ["step", "call", "transaction"].includes(stem(noun))) return null;
    // `the other § masks` and `§ other masks` leave out a mask the count holds.
    if (role === "mask" && /\bother\s*$/i.test(before)) return "other";
    // `§ other masks` leaves out a mask the count holds.
    if (role === "mask" && /^\s+(?:other|more|rival)\b/i.test(after)) return "other";
    return stem(noun) !== role ? stem(noun) : null;
  }
  return null;
}
