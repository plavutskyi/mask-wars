// The page a model writes, and the code that decides whether it may be published. A page passes only when every
// sentence cites facts that exist, every number in it is a number those facts write, every account and hash it names
// belongs to those facts, every word in it is a word of those facts or one the gate reads against the chain itself
// (vocabulary.ts), and it carries no link, markup or promise. Anything else: the page is not published.

import { z } from "zod";
import { caseMatters, identifiersIn, numberWord, otherUnit, withoutNames } from "./numbers.ts";
import { libraryEntry } from "./library.ts";
import { SLOT, clauseAfter, clauseBefore, contradiction, meaningOf, ownPhrase, render, valueOf } from "./slots.ts";
import { strangeWords } from "./vocabulary.ts";

const MARK = "§";

/** A winner's fields: they go with the mask that won. A team's: they go with no mask at all. */
const WINNER_FIELDS: ReadonlySet<string> = new Set(["loot_near", "took_in_all_near", "bounty_paid_near", "break_after_start"]);
const TEAM_FIELDS: ReadonlySet<string> = new Set(["opened", "opened_date", "opened_time", "bounty_locked_near"]);

/** Words that say a race held, and words that say it fell. A race's outcome on chain decides which may be said of it. */
const HELD_WORDS = /\b(survived|withstood|unbroken|(?:did\s+not|didn['’]t|never)\s+fall|(?:nobody|no\s+(?:mask|one)|none\s+of\s+the\s+masks)\s+(?:has\s+|had\s+)?(?:drained|broke|broken|cracked|swept|emptied|beat(?:en)?|got\s+(?:in|through|past))|(?:not|never)\s+(?:been\s+)?(?:drained|broken|swept)|held\s+the\s+line|(?<!(?:nears?|§)\s+(?:the\s+safe|it)\s+)held(?!\s+off\b)(?!\s+(?:(?:for|out\s+for)\s+)?§(?!\s+(?:races?|masks?|rounds?|times)\b)|\s+(?:a|the)\b|\s+\w+\s+§\s+NEAR|\s+(?:out\s+)?(?:until|till)\s+(?!(?:the\s+|its\s+|their\s+)?(?:deadlines?|end)\b)))\b|n['’]t\s+(?:been\s+)?(?:drained|broken|swept)\b/i;
/** Words that say the money went back, the race ran its time out or no claim went through: only a race nobody broke. */
const BACK_WORDS = new RegExp(
  [
    String.raw`\b(?:went|came)\s+back\b|\bgot\s+(?!nothing\b)(?:[\w'’]+\s+){0,3}back\b(?!\s+(?:nothing|none)\b)|\bpaid\s+(?:nothing|no\s+one|nobody)\b|\b(?:was|were)\s+(?:refunded|returned)\b|\bsent\s+(?:it\s+)?back\b|\breturned\s+to\s+the\s+team\b|\b(?:with|in)\s+a\s+refund\b`,
    String.raw`\b(?:ran|lasted|held\s+out|went)\s+(?:(?:until|till)\s+(?:the|its|their)\s+(?:deadlines?|end)\b|the\s+distance\b)|\b(?:ran|went)\s+(?:from\s+§\s+)?to\s+(?:§|(?:its|their|the)\s+deadlines?)|\bran\s+out\s+the\s+clock\b|\bran\s+(?:its|their)\s+(?:full\s+)?course\b|\breached\s+(?:its|their|the)\s+deadlines?\b`,
    String.raw`\b(?:ended|closed)\s+(?:at|on)\s+(?:its|the|their)\s+deadlines?|\bmade\s+it\s+to\b|\bwithout\s+a\s+(?:confirmed\s+)?(?:drain|break)\b|\bintact\b|\bstood\s+through\b`,
    String.raw`\brefused\s+(?:every|all|each)(?:\s+of)?(?:\s+the)?(?:\s+team['’]s)?\s+claims?\b|\bevery\s+claim\b[^.;]*\bwas\s+refused\b|\bno\s+claim\s+(?:[\w-]+\s+){0,3}(?:went\s+through|was\s+confirmed)\b|\b(?:did\s+not|didn['’]t|never)\s+confirm(?:ed)?\s+(?:a|the|any)\s+(?:drain|break|claim)\b`,
    String.raw`\bcame\s+through\b|\bstood\s+firm\b|\bkept\s+its\s+bounty\b|\b(?:with\s+)?no\s+(?:drain|break|payout)\b|\bwithout\s+a\s+payout\b|\bstill\s+standing\b|\buntouched\b|\bstayed\s+shut\b|\bfull\s+window\b|\b(?:expired|timed\s+out)\b`,
    String.raw`\b(?:goes|comes)\s+back\b|\bgets\s+(?!nothing\b)(?:[\w'’]+\s+){0,3}back\b|\bis\s+(?:refunded|returned)\b|\bsends\s+(?:it\s+)?back\b|\b(?:runs|lasts|goes)\s+(?:until|till|to)\s+(?:the|its|their)\s+(?:deadlines?|end)\b|\bruns\s+out\s+the\s+clock\b|\b(?:ends|closes)\s+(?:at|on)\s+(?:the|its|their)\s+deadlines?\b|\brefuses\s+(?:every|all|each)\b`,
    String.raw`\b(?:survives|withstands|holds(?!\s+(?:§|a\b|the\b|off\b|for\b|out\s+for\b|\w+\s+§))|stands(?!\s+at\b)|(?:nobody|no\s+(?:mask|one)|none\s+of\s+the\s+masks)\s+(?:breaks|drains|cracks|sweeps|gets\s+(?:in|through|past))|(?:is\s+not|isn['’]t)\s+(?:drained|broken)|never\s+falls|repelled|kept\s+\S+\s+out|failed\s+to\s+(?:break|drain|crack))\b`,
    String.raw`\brefunded\b|\brefunds\b|\breturned\s+the\s+bounty\b|\bhanded\s+(?:the\s+|its\s+)?bounty\s+back\b|\bran\s+out\s+of\s+time\b|\bno\s+claim\s+confirmed\b|\bturned\s+down\s+(?:every|all|each)\s+claims?\b|\bclaims\b[^.;]*\bwere\s+(?:all\s+)?refused\b|\bno\s+confirmed\s+(?:drain|break)\b|\b(?:no|without\s+a)\s+winner\b|\bkept\s+(?:the|its)\s+bounty\b|\bbounty\s+stayed\b`,
  ].join("|"),
  "i",
);
const FELL_WORDS =
  /\b(?:falls|breaks(?!\s+in\b)|cracks|is\s+(?:drained|broken|swept|beaten)|breached|compromised|exploited|wins|loses|gives\s+way|goes\s+down|confirms\s+(?:a|the)\s+(?:drain|break)|pays\s+(?:out|to)|is\s+paid|(?:ended|closed)\s+(?:in|with)\s+a\s+(?:confirmed\s+)?(?:drain|break|payout)|(?:a|the)\s+(?:drain|break)\s+(?:was\s+)?confirmed|(?:drain|break)\s+confirmed|had\s+a\s+(?:confirmed\s+)?(?:drain|break|winner)|found\s+a\s+(?:drain|break)|as\s+a\s+payout|fell|broke|broken|cracked|drained|swept|won|lost|was\s+beaten|went\s+down|gave\s+way|did\s+not\s+hold|ended\s+(?:in|with)\s+a\s+payout|beat\s+(?:[a-z]+-[a-z-]+|SAFE-\d+|the\s+(?:safe|target|contract)|it)\b|confirm(?:ed|ing)\s+(?:the\s+)?(?:drains|breaks)|paid(?!\s+(?:back|for(?!\s+race-)|into|up|nothing|no\s+one|nobody)\b|\s+in\b(?!\s+race-))(?![^.;,§]*\bback\b)|confirm(?:ed|ing)\s+(?:a|the)\s+(?:drain|break)|(?:did\s+not|never)\s+survive|confirmed\s+(?:a\s+|the\s+|its\s+)?(?:team['’]s\s+|[A-Z]{3,}['’]s\s+)?(?:[a-z]+\s+)?claims?|claims?\s+(?:[\w-]+\s+){0,4}(?:was|were)\s+(?:confirmed|accepted|approved)|approved\s+(?:the\s+|its\s+)?(?:team['’]s\s+)?claims?|claims\s+went\s+through|claim\s+(?:[\w-]+\s+){0,3}went\s+through)\b|\bdidn['’]t\s+(?:hold|survive)\b/i;
/** The race fact's field for each role the words around an amount can give it. */
const ROLE_FIELD: Readonly<Record<string, string>> = { lock: "bounty_locked_near", pay: "bounty_paid_near", back: "bounty_back_near", take: "loot_near", total: "took_in_all_near" };
/** The judge's word on a claim: yes, or no. */
const YES = /(?<!(?:\bnot|\bnever|n['’]t)\s)\b(?:yes|won\s+the\s+bounty|took\s+it|cashed\s+in|got\s+its\s+money|got\s+it|got\s+through|agreed|won(?=\s*[.;,]|\s+it\b|\s+(?:at|on)\b)|got\s+the\s+bounty(?!\s+back)|gave\s+\S+\s+the\s+win|successful\s+claim|was\s+(?:successful|valid)|waved\s+(?:\S+\s+){1,3}through|gave\s+\S+\s+the\s+bounty|ruled\s+in\s+\S+\s+favou?r|signed\s+off|confirm(?:ed|s|ing|ations?)?|approved|approvals?|(?:was|got)\s+paid|paid\s+off|backed|ruled\s+valid|winning\s+claim|accepted|upheld|succeeded|sided\s+with|went\s+through|granted|said\s+yes|found\s+for|ruled\s+for|validated|won\s+it|collected\s+it)\b|\b(?:did\s+not|didn['’]t|never)\s+(?:refuse|reject|deny|dismiss)\b/i;
const NO = /(?<!(?:\bnot|\bnever|n['’]t)\s)\b(?:(?:judge['’]s|its)\s+no\b|(?:was\s+not|wasn['’]t)\s+upheld|(?:did\s+not|didn['’]t)\s+stand|declined|turned\s+(?:\S+\s+){1,3}down|knocked\s+(?:\S+\s+){1,3}back|bounced|knocked\s+back|came\s+to\s+nothing|refus(?:ed|es|ing|als?)|reject(?:ed|s|ing|ions?)?|denied|denying|denials?|turned\s+down|failed|said\s+no|dismissed|thrown\s+out|threw\s+out|ruled\s+against|found\s+against)\b|\b(?:did\s+not|didn['’]t|never|was\s+not|wasn['’]t)\s+(?:confirm(?:ed)?|approved?|accept(?:ed)?|go\s+through|grant(?:ed)?)\b/i;
/** A negation right before an outcome word, a word apart at most: `not`, `never`, `n't`, `nobody`, `none of the claims`. */
const NEGATED = /(?:\b(?:not|never|nobody|nothing|nor|no|none(?:\s+of(?:\s+(?:the|its|their))?)?|no\s+(?:masks?|one|claims?))|n['’]t)\s+(?:[\w'’]+\s+){0,2}$/i;
import type { Claim, Evidence, Page, SectionId } from "./types.ts";

export const SECTIONS: readonly SectionId[] = ["record", "money", "code"];

/** What each section is about, in the words of the prompt. */
export const SECTION_BRIEF: Record<SectionId, string> = {
  record: "who raced on it, what they did and how each race ended",
  money: "what was on the line, who took it or where it went back",
  code: "its code fingerprint and what kind of target it is",
};

export const LIMITS = { lede: 240, claim: 260, claims: 5, refs: 8 } as const;

/**
 * What the prompt asks for, inside what the gate accepts: a page a person reads in one look, and an answer the model
 * finishes well inside NEAR AI's thirty seconds for a signed (unstreamed) reply.
 */
export const ASK = { claims: 3, claim: 180 } as const;

const ref = z.string().regex(/^E\d{1,3}$/);
const claim = z.object({ text: z.string().regex(/\S/), refs: z.array(ref).min(1).max(LIMITS.refs) }).strict();
const schema = z
  .object({
    lede: claim,
    sections: z.array(z.object({ id: z.enum(["record", "money", "code"]), claims: z.array(claim).min(1).max(LIMITS.claims) }).strict()).min(1).max(3),
  })
  .strict();

/** Words a page never says: a page reports what happened and never promises what will. */
const BANNED: readonly [RegExp, string][] = [
  // "The safe" is a thing on the arena; "safe" as a verdict is never said.
  [/\b(is|are|was|were|be|been|being|stays?|stayed|remains?|remained|proves?|proved|proven|keeps?|kept|holds?|held|stands?|stood|looks?|looked|seems?|seemed|becomes?|became|deemed|considered|rated|called)\s+(now\s+|still\s+|no\s+longer\s+|not\s+)?(completely\s+|fully\s+|totally\s+|very\s+|perfectly\s+)?safe\b(?!-)/i, "calls it safe"],
  [/\bsafe\s+to\s+(use|pay|trust|call|send|interact|deposit|hold|integrate|rely)\b|\ba\s+safe\s+(contract|bet|choice|place|investment|code)\b|\bsafely\b/i, "calls it safe"],
  [/['’]s\s+(now\s+|still\s+)?(completely\s+|fully\s+|very\s+)?(safe|secure)\b(?=\s*(?:[.,;:!?]|$|now\b|still\b|against\b|from\b|for\b|and\b|to\b))|\bkept\s+(\w+\s+){0,2}safe\b(?!-)/i, "calls it safe"],
  [/\b(robust|airtight|watertight|ironclad|tamper-?proof|unbeaten|bug-?free|flawless|impregnable|resilient|unassailable|vulnerabilit(y|ies))\b|\bholds?\s+firm\b|\bno\s+\w+\s+(breaks?|gets?)\b|\bagainst\s+(every|all|any)\b|\bhole\s+(?:in\s+\S+\s+)?(is|was|has\s+been|is\s+now)\s+(?:now\s+)?closed\b|\bhas\s+no\s+holes?\b|\b(hard|tough|difficult)\s+to\s+(break|crack|drain|beat)\b|\b(solid|sturdy|resists?|resisted|resistant)\b/i, "promises"],
  [/\b(is|are|was|were|be|been|being|stays?|stayed|remains?|remained|looks?|seems?)\s+(now\s+|still\s+)?(fully\s+|completely\s+|very\s+)?secure(d)?\b|\bsecurely\b|\bsecure\s+(contract|vault|safe|code)\b/i, "calls it secure"],
  [/\bguarantee/i, "promises"],
  [/\baudit(ed|s)?\b/i, "calls it audited"],
  [/\bsafe(r|st)\b|\bsafe-to\b|\bsafety\b/i, "calls it safe"],
  [/\b(unhackable|unbreakable|uncrackable|unexploitable|unbeatable|untouchable|bulletproof|risk[\s-]?free|riskless|trustworthy|impenetrable|invulnerable|exploit-?proof|hack-?proof|impossible)\b/i, "promises"],
  [/\b(will|won't|wont|shall|cannot|can't|cant|going\s+to|gonna|forever)\b|\bcan\s+(not|never|ever)\b|\b(could|would)\s+(ever|never)\b|\bunable\s+to\b|\bnever\s+be\b|'ll\b|\bfrom\s+now\s+on\b|\b(no\s+\w+|nobody|nothing|none|no\s+one)\s+(can|could)\b|\b(should|ought\s+to|bound\s+to|expected\s+to|likely\s+to|sure\s+to)\b|(?<!\b(was|were|is|are|been)\s)\bset\s+to\b/i, "says what can or will happen"],
  [/\b(protected|protects?|immune|reliable|rely|relied|trust(ed|s)?|risks?|risky|fixed|patched|ready\s+for|guarded|invincible|foolproof|battle[\s-]?tested|hardened|certified|vetted)\b|\b(?:is|are|was|were|been|being)\s+(?:\w+\s+)?verified\b|\bverified\s+(?:contract|code|safe)\b/i, "promises"],
  [/\b(ever|always)\b|\bmay\s+(ever|never)\b|\bnever\s+(gets?|falls?|breaks?|holds?|gives?|loses?|fails?)\b|\b(no\s+\w+|nobody|nothing|none|no\s+one)\s+(is\s+able|are\s+able|gets?\s+(past|through|in)|may|might)\b/i, "says what can or will happen"],
  [/\b(revolutionary|seamless|unlock|alpha|fastest|slowest|biggest|largest|smallest|highest|first-ever|unmatched|unprecedented)\b/i, "is off voice"],
];

/** Plain English in the brand's own glyphs: nothing hidden, nothing that only looks like a letter. */
const PLAIN = /^[\x20-\x7E\u00B7\u00D7\u2013\u2014\u2018\u2019\u201C\u201D\u2026\u2212]*$/;

const MARKUP: readonly [RegExp, string][] = [
  [/https?:\/\/|www\./i, "a link"],
  [/[<>]/, "markup"],
  [/\]\(|```|`|\*\*|__|^#|\n#/, "markdown"],
  [/@[a-z0-9_]/i, "a handle"],
  [/[!]/, "an exclamation mark"],
];

export type Problem = string;

const SHAPE_CODE_LIST = ["invalid_type", "too_small", "too_big", "invalid_format", "unrecognized_keys", "invalid_value", "invalid_union", "invalid_key", "invalid_element", "not_multiple_of", "custom"];
const SHAPE_CODES: ReadonlySet<string> = new Set(SHAPE_CODE_LIST);
const WHERE = String.raw`(?:lede|(?:record|money|code) \d{1,2})`;
const TOKEN = String.raw`[A-Za-z0-9_.:#/×%$€£¥₿'?-]{1,40}`;
const REFS = String.raw`E\d{1,3}(?:, E\d{1,3}){0,7}`;
/** Every line `checkPage` writes, as a template: the only reasons a second try may carry. */
const REASONS: readonly RegExp[] = [
  String.raw`${WHERE}: longer than \d+ characters`,
  String.raw`${WHERE}: carries characters outside plain text \(hidden, accented or look-alike\)`,
  String.raw`${WHERE}: carries (?:a link|markup|markdown|a handle|an exclamation mark)`,
  String.raw`${WHERE}: (?:calls it safe|calls it secure|promises|calls it audited|says what can or will happen|is off voice)(?: \(${TOKEN}\))?`,
  String.raw`${WHERE}: writes the number "${TOKEN}" in words; every number goes in digits from a fact`,
  String.raw`${WHERE}: glues a number to a word or sign \(${TOKEN}\); write it as a fact writes it`,
  String.raw`${WHERE}: counts in ${TOKEN}; a page counts NEAR only`,
  String.raw`${WHERE}: cites ${REFS}, which is not a fact`,
  String.raw`${WHERE}: the number ${TOKEN} is in none of the facts it cites \(${REFS}\)`,
  String.raw`${WHERE}: ${TOKEN} NEAR is no amount the facts it cites \(${REFS}\) write`,
  String.raw`${WHERE}: names (?:race|safe) \d{1,8}, which none of the facts it cites \(${REFS}\) names`,
  String.raw`${WHERE}: names ${TOKEN}, which none of the facts it cites \(${REFS}\) names`,
  String.raw`section (?:record|money|code): (?:comes twice|out of order \(record, money, code\)|missing, and the facts support it)`,
  String.raw`${WHERE}: carries a fraction`,
  String.raw`${WHERE}: writes a number itself; every number goes in as a slot like \{E4\.loot_near\} from a fact it cites`,
  String.raw`${WHERE}: slot ${TOKEN} is no field of a fact it cites \(${REFS}\)`,
  String.raw`${WHERE}: puts ${TOKEN} where the words around it do not say [a-z_]{2,20}`,
  String.raw`${WHERE}: writes ${TOKEN} twice in one clause`,
  String.raw`${WHERE}: tells ${TOKEN} and ${TOKEN} as one event; split the sentence`,
  String.raw`${WHERE}: puts ${TOKEN} right after race or safe, where it reads as a name`,
  String.raw`${WHERE}: carries a broken slot`,
  String.raw`${WHERE}: writes UTC after a time, which carries it`,
  String.raw`${WHERE}: says ${TOKEN} (?:held|fell), which the chain says it did not`,
  String.raw`${WHERE}: names ${TOKEN} as the one who made step E\d{1,3}, which the fact says ${TOKEN} made`,
  String.raw`${WHERE}: puts ${TOKEN} in race-\d{1,8}, which the fact is not of`,
  String.raw`${WHERE}: glues a number to a word or sign \(slot\); write the unit after a space`,
  String.raw`${WHERE}: writes the number "${TOKEN}" in words; every number goes in as a slot from a fact`,
  String.raw`${WHERE}: carries a multiplier`,
  String.raw`${WHERE}: counts ${TOKEN} ${TOKEN}, which none of the facts it cites \(${REFS}\) count`,
  String.raw`${WHERE}: writes ${TOKEN} as [a-z]{2,10}, which the facts it cites \(${REFS}\) write as [a-z]{2,10}(?: or [a-z]{2,10}){0,7}`,
  String.raw`${WHERE}: names ${TOKEN} as the one who drained it, which none of the facts it cites \(${REFS}\) say`,
  String.raw`${WHERE}: names ${TOKEN} as the one who made that step, which none of the facts it cites \(${REFS}\) say`,
  String.raw`${WHERE}: writes a length of time in words \(${TOKEN}\); a duration goes as a fact writes it, like 8:13`,
  String.raw`${WHERE}: writes ${TOKEN}, a word none of the facts it cites \(${REFS}\) write`,
  String.raw`${WHERE}: says the judge said (?:yes|no), which the chain says it did not`,
  String.raw`shape: [A-Za-z0-9_.]{1,60} (?:${[...SHAPE_CODE_LIST, "invalid", "not_json"].join("|")})`,
].map((p) => new RegExp(`^${p}$`));

/** A line the gate itself wrote, field for field: nothing a caller could steer a model with. */
export function isGateReason(line: string): boolean {
  return REASONS.some((r) => r.test(line));
}

/** The reply as JSON: the first object in it, past any thinking or fences a model adds. */
export function parseReply(text: string): unknown {
  const body = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Words in capitals a page may write that are no names: the arena's own words and units. */
const CAPS: ReadonlySet<string> = new Set(["NEAR", "UTC", "MASK", "WARS", "CHECK", "SAFE", "TEE", "AI", "GPU", "OK", "ID"]);

/** A token from a reply, put into a reason only as the reason's template allows: no free text rides along. */
const tok = (t: string) => t.replace(/[^A-Za-z0-9_.:#/×%$€£¥₿'-]/g, "?").slice(0, 40) || "?";

function checkClaim(c: Claim, where: string, byId: ReadonlyMap<string, Evidence>, limit: number): Problem[] {
  const out: Problem[] = [];
  // Every check reads the text as it will be published: one space between words, so padding hides nothing.
  const text = c.text.trim().replace(/\s+/g, " ");
  if (!PLAIN.test(text)) out.push(`${where}: carries characters outside plain text (hidden, accented or look-alike)`);
  for (const [re, why] of MARKUP) if (re.test(text)) out.push(`${where}: carries ${why}`);

  const refs = [...new Set(c.refs)];
  const cited = refs.map((r) => byId.get(r));
  const unknown = refs.filter((_, i) => !cited[i]);
  if (unknown.length) out.push(`${where}: cites ${unknown.join(", ")}, which is not a fact`);
  const facts = cited.filter((e): e is Evidence => e !== undefined);
  const names = facts.flatMap((e) => e.names);
  const at = `(${refs.join(", ")})`;
  if (render(text, facts).length > limit) out.push(`${where}: longer than ${limit} characters`);
  // The masks the cited facts name: whoever a step's slot goes with must be one, and the right one.
  const maskNames = new Set(facts.flatMap((e) => [e.data["who_name"], e.data["winner_name"]]).filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()));
  for (const e of facts) for (const n of e.names) if (/^[A-Z][A-Z0-9]{2,}$/.test(n)) maskNames.add(n.toLowerCase());

  // Slots: every number on a page is a field of a fact the sentence cites, put in by the site. The words around a slot
  // must not give it another meaning than its field has, another race, or another mask than the one that made the step.
  // They are read with every slot and every cited dotted or library name set aside, so a name never reads as a word.
  // A mask named by its account reads as the mask: the checks of who did what see NOVA either way.
  const maskOf = new Map<string, string>();
  for (const e of facts) {
    for (const [acc, name] of [[e.data["who"], e.data["who_name"]], [e.data["winner"], e.data["winner_name"]]] as const) {
      if (typeof acc === "string" && typeof name === "string") maskOf.set(acc, name);
    }
    const ms = e.data["masks"];
    if (Array.isArray(ms)) for (const acc of ms) { const short = acc.split(".")[0]!.toUpperCase(); if (e.names.includes(short)) maskOf.set(acc, short); }
  }
  // The contract the page is about reads as `the safe` when the words around a slot are weighed: `from safe-0001.…`.
  const theSafe = [...byId.values()].flatMap((e) => [e.data["target"], e.data["safe"], e.data["account"]]).filter((x): x is string => typeof x === "string" && x.includes("."));
  for (const acc of theSafe) if (!maskOf.has(acc)) maskOf.set(acc, "the safe");
  const asMasks = (part: string) => [...maskOf].sort((a, b) => b[0].length - a[0].length).reduce((t, [acc, name]) => t.replaceAll(acc, name), part);
  const blank = names.filter((n) => /[.\d]/.test(n) && !/^(race|safe)-\d+$/i.test(n) || libraryEntry(n) !== null);
  // A name is set aside as a word of its own, never as the slot mark: `tinygif8324.testnet paid §` keeps its verb.
  const prepared = (part: string) => withoutNames(asMasks(part.replace(SLOT, MARK)), blank, "Acct");
  const slotsSoFar: { id: string; field: string; end: number }[] = [];
  const raceOutcome = (race: string) => [...byId.values()].find((x) => x.kind === "race" && x.race === race)?.data["outcome"];
  for (const m of text.matchAll(SLOT)) {
    const [whole, id, field] = m as unknown as [string, string, string];
    const e = refs.includes(id) ? byId.get(id) : undefined;
    if (!e || valueOf(e, field) === null) {
      out.push(`${where}: slot ${tok(`${id}.${field}`)} is no field of a fact it cites ${at}`);
      continue;
    }
    const before = prepared(text.slice(0, m.index));
    const rest = prepared(text.slice(m.index + whole.length));
    // `§: NOVA is paid.`: a slot that opens its clause with a colon after it is told by the words after the colon.
    const after = /^\s*$/.test(clauseBefore(before)) && /^\s*:/.test(rest) ? rest.replace(/^\s*:\s*/, " ") : rest;
    const meaning = meaningOf(e, field);
    // A reason names what the field means, never what the words seem to say: it asks for other words, and offers no
    // other field to swap in.
    const means = meaning.role ?? meaning.kind;
    // A slot set right after another with only a comma between (`at §, § after the start`) tells the same moment: it
    // must be of the same fact, and the words around the first one already speak for it. A list of the same kind of
    // moment (`at §, § and §`, three refused claims) is no apposition: each is read as usual.
    const prev = slotsSoFar.at(-1);
    // One value written twice in a sentence tells two things with one number (`moved at § with set_owner and at §
    // with sweep`).
    const again = [...slotsSoFar].reverse().find((x) => x.id === id && x.field === field);
    if (again && !/[;:!?]|\.(?!\d)/.test(text.slice(again.end, m.index).replace(SLOT, MARK))) out.push(`${where}: writes ${tok(`${id}.${field}`)} twice in one clause`);
    slotsSoFar.push({ id, field, end: m.index + whole.length });
    // A slot set right after another with only a comma, `and` or `or` between is apposed or listed with it.
    const apposed = prev !== undefined && /^\s*(?:,\s*)?(?:(?:and|or)\s*)?$/.test(text.slice(prev.end, m.index)) && /\S/.test(text.slice(prev.end, m.index));
    const pe = prev ? byId.get(prev.id) : undefined;
    const prevRole = pe && prev ? meaningOf(pe, prev.field).role : null;
    // Apposed by a comma alone, another fact must be the same moment; a list joined by `and` may hold several.
    const moments = pe !== undefined && prev !== undefined && ["time", "duration"].includes(meaningOf(pe, prev.field).kind) && ["time", "duration"].includes(meaning.kind);
    if (apposed && moments && /^\s*,\s*$/.test(text.slice(prev.end, m.index)) && prev.id !== id && prevRole !== meaning.role) out.push(`${where}: puts ${tok(`${id}.${field}`)} where the words around it do not say ${means}`);
    // A deadline is when a race that held ended; a race that fell ended at its break. So a broken race's deadline is
    // only ever named as its deadline (`a deadline of §`, `the deadline was §`, `due to close on §`, `before §`), never
    // with a word of running, lasting or ending (`ran § to §`, `race-0002 to §`, `ended on § and race-0002 on §`).
    if (meaning.role === "deadline" && e.race && raceOutcome(e.race) === "broken") {
      const clause = clauseBefore(before);
      const ends = /\b(?:ran|runs|lasted|lasts|ended|ends|closed|closes|held|holds|stood|went\s+on|continued|kept\s+(?:running|going)|expired|timed\s+out|finished|concluded|wrapped\s+up|came\s+to\s+(?:a\s+close|an\s+end)|settled|was\s+over|(?:was|stayed|remained|stays)\s+(?:open|live))\b/i.test(clause.replace(/\b(?:set|due)\s+to\s+close\b/gi, " "));
      const since = before.slice(before.lastIndexOf("§") + 1);
      const named = /\bdeadlines?\b/i.test(since) || /\b(?:before|by|ahead\s+of)\s*$/i.test(before) || /\b(?:set|due)\s+to\s+(?:close|end)\s+(?:on|at)\s*$/i.test(before) || /^\s*[,:]?\s*(?:as\s+)?(?:its|the|their)\s+deadline/i.test(after) || /\b(?:had|gave\s+\S+(?:\s+\S+)?)\s+until\s*$/i.test(before) || (prev !== undefined && prev.id === id && meaningOf(e, prev.field).role === "deadline" && /^\s*(?:on|at|,)?\s*$/.test(text.slice(prev.end, m.index)));
      if (ends || !named) out.push(`${where}: says ${tok(e.race)} held, which the chain says it did not`);
    }
    // A count, or a bare number, after `race` or `safe` reads as that race's or safe's own name: `safe 3`.
    const bare = meaning.kind === "count" || (meaning.kind === "other" && /^\d+$/.test(valueOf(e, field) ?? ""));
    const counted = /^\s+(?:[a-z]+\s+)?(?:masks?|moves?|races?|claims?|seals?|steps?|times|levels?|drains?)\b/i.test(after);
    if (bare && !counted && /\b(?:race|safe)\s*(?:no\.?\s*|number\s+)?#?\s*$/i.test(before)) out.push(`${where}: puts ${tok(`${id}.${field}`)} right after race or safe, where it reads as a name`);
    const sameKind = (a: string, b: string) => (a === "time" || a === "duration") === (b === "time" || b === "duration");
    // `the full bounty, §` with a payout that was less than the bounty locked.
    if (meaning.kind === "amount" && meaning.role === "pay" && /(?<!\b(?:nearly|almost|most\s+of|less\s+than|short\s+of)\s+(?:the\s+)?)\b(?:full|whole|entire|all\s+of\s+the)\s+(?:\{E\d+\.[a-z_]+\}\s+NEAR\s+)?bounty\b|\bbounty\b[^.;]*\bin\s+full\b|\bwhole\s+of\s+the\s+bounty\b|\ball\s+\{E\d+\.[a-z_]+\}\s+NEAR\s+of\s+it\b/i.test(text)) {
      const r = e.race ? [...byId.values()].find((x) => x.kind === "race" && x.race === e.race) : undefined;
      if (r && r.data["bounty_paid_near"] !== undefined && r.data["bounty_paid_near"] !== r.data["bounty_locked_near"]) out.push(`${where}: puts ${tok(`${id}.${field}`)} where the words around it do not say ${means}`);
    }
    // The words around the first of them speak for the rest: the same fact apposed, or a list of the same moment.
    // A time right after an amount of the same event, with no verb between (`a payout of § NEAR to the team at §`), is
    // that event's time: the words around the amount speak for it.
    const ofItsAmount = prev !== undefined && prev.id === id && e.kind !== "race" && /^\s*NEARS?\s+(?:to|from|for|back\s+to)\b[^{}]{0,40}?\b(?:at|on)\s*$/i.test(text.slice(prev.end, m.index));
    const span = /\bbetween\s*$/i.test(before) || /\bbetween\s+§\s+and\s*$/i.test(before);
    const listed = span || ofItsAmount || (apposed && pe !== undefined && sameKind(meaningOf(pe, prev.field).kind, meaning.kind) && (prev.id === id || prevRole === meaning.role));
    const says = listed ? null : contradiction(meaning, before, after);
    // A count of moves told of a mask (`ONYX made § moves`, `each mask made § moves`) holds only for the one mask that
    // made every move of the race.
    if (meaning.role === "move" && meaning.kind === "count") {
      const movers = new Set(
        [...byId.values()]
          .filter((x) => (x.kind === "move" || x.kind === "drain") && x.race === e.race)
          .map((x) => x.data["who_name"] ?? x.data["who"])
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.toUpperCase()),
      );
      const clause = clauseBefore(before);
      const told = [...clause.matchAll(/\b[A-Z][A-Z0-9]{2,}\b/g)].map((x) => x[0]).filter((x) => maskNames.has(x.toLowerCase())).at(-1);
      if (/\b(?:each|every|all)\s+(?:of\s+the\s+)?masks?\b/i.test(clause)) out.push(`${where}: puts ${tok(`${id}.${field}`)} where the words around it do not say ${means}`);
      else if (told && (movers.size !== 1 || !movers.has(told))) out.push(`${where}: names ${tok(told)} as the one who made step ${tok(id)}, which the fact says ${tok(movers.size === 1 ? [...movers][0]! : "several")} made`);
    }
    // Words that mean another field of the same fact holding the same value tell the truth: a bounty that came back in
    // full is the bounty locked.
    const twin = says ? ROLE_FIELD[says] : undefined;
    const same = twin !== undefined && twin !== field && valueOf(e, twin) !== null && valueOf(e, twin) === valueOf(e, field);
    // A date is a day: words that mean another event of the same day tell the truth (`drained it on §, the day it opened`).
    const isDate = (f: string) => f === "date" || f.endsWith("_date");
    const noDrain = typeof e.race === "string" && ![...byId.values()].some((x) => x.kind === "drain" && x.race === e.race);
    const dayRole = (x: Evidence, f: string) => {
      const r = meaningOf(x, f).role;
      return says === "drain" && noDrain && r === "claim_confirmed" ? "drain" : r;
    };
    const sameDay = says !== null && isDate(field) && [...byId.values()].some((x) => (!e.race || x.race === e.race) && Object.keys(x.data).some((f) => isDate(f) && dayRole(x, f) === says && valueOf(x, f) === valueOf(e, field)));
    // A race no mask drained on chain (the team's own sandbox run) fell when the judge confirmed the drain.
    const sandboxBreak = says === "drain" && meaning.role === "claim_confirmed" && typeof e.race === "string" && ![...byId.values()].some((x) => x.kind === "drain" && x.race === e.race);
    if (says && !same && !sameDay && !sandboxBreak) out.push(`${where}: puts ${tok(`${id}.${field}`)} where the words around it do not say ${means}`);
    // The race named nearest to it, in its clause first, else anywhere before it in the sentence, else after it.
    const races = (part: string) => [...part.matchAll(/\brace-\d+\b/gi)].map((x) => x[0]);
    // A race in the slot's own phrase right after it (`§ NEAR for race-0002`) comes first.
    const own = clauseAfter(after).split(/§|\band\b|,/i)[0] ?? "";
    // A race the slot's own words bring in after it (`§ NEAR locked and paid in race-0002`), up to a comma.
    const ppRace = /^\s*(?:[\w'’-]+\s+){0,5}?(?:in|on|for|of)\s+(race-\d+)\b/i.exec(clauseAfter(after).split(/§|,/)[0] ?? "")?.[1];
    // `Across race-0001 and race-0002 the team locked § NEAR each time`: a value said of every race named is no one race's.
    const several = races(clauseBefore(before)).length > 1 && /\b(?:each|every|both|all)\b/i.test(clauseAfter(after) + clauseBefore(before));
    const afterOwnClause = clauseAfter(after).split(/\band\s+(?=(?:[a-z]+ed|was|got|took|won|broke|swept|paid)\b|the\s+(?:team|judge|bounty|safe)\b|[A-Z]{3,})/)[0] ?? "";
    const race = several ? undefined : (races(own)[0] ?? ppRace ?? races(clauseBefore(before)).at(-1) ?? races(afterOwnClause)[0] ?? races(before).at(-1));
    if (race && e.race && race.toLowerCase() !== e.race) out.push(`${where}: puts ${tok(`${id}.${field}`)} in ${tok(race)}, which the fact is not of`);
    // A step's slot goes with whoever made the step, and a winner's field with the winner: the nearest mask named in its
    // clause must be that one. A team's step (an opening, a funding, a refund) goes with no mask at all: only a mask in
    // the slot's own phrase after it reads as its actor (`Of the § NEAR bounty, NOVA was paid`: NOVA is paid, not locks).
    const who =
      e.data["who"] !== undefined
        ? (e.data["who_name"] ?? e.data["who"])
        : WINNER_FIELDS.has(field)
          ? (e.data["winner_name"] ?? e.data["winner"])
          : TEAM_FIELDS.has(field)
            ? e.data["team"]
            : null;
    if (typeof who === "string") {
      const named = (part: string) => [...part.matchAll(/\b[A-Z][A-Z0-9]{2,}\b/g)].map((x) => x[0]).filter((x) => maskNames.has(x.toLowerCase()));
      // A step whose actor is no mask (the team's funding, opening, refund) is read in the slot's own phrase only.
      const team = !maskNames.has(who.toLowerCase());
      const near = clauseBefore(before);
      // The one who made it is the subject: the last mask right before a verb in its clause (`NOVA beat ONYX and ORACLE
      // … and took §`: NOVA), else the last mask named before it, else the first after it.
      const subject = (part: string) =>
        [...part.matchAll(/\b([A-Z][A-Z0-9]{2,})\b(?:['’]s)?\s+(?:(?:also|then|just|first|again|later|finally)\s+)?(?:[a-z]+ed|beat|left|took|swept|won|got|made|ran|broke|sent|paid|was|had|held|hit|struck|stole|drew|fell|came|went|called|tried|claimed)\b/g)]
          .map((x) => x[1]!)
          .filter((x) => maskNames.has(x.toLowerCase()))
          .at(-1);
      // A team's step is told of a mask only when a team's verb follows the mask (`ONYX opened race-0003 at §`), not
      // when masks are only named in the clause (`NOVA, ONYX and ORACLE raced on SAFE-0001 from §`).
      const teamActor = (part: string) =>
        [...part.matchAll(/\b([A-Z][A-Z0-9]{2,})\b\s+(?:[a-z]+\s+)?(?:opened|locked|put|funded|loaded|staked|refunded|got\s+back)\b/g)].map((x) => x[1]!).filter((x) => maskNames.has(x.toLowerCase())).at(-1);
      const mask = (team ? teamActor(near.slice(near.lastIndexOf("§") + 1)) : (subject(near) ?? named(near).at(-1))) ?? (team ? teamActor(ownPhrase(own)) : named(clauseAfter(after))[0]);
      if (mask && mask.toLowerCase() !== who.toLowerCase()) out.push(`${where}: names ${tok(mask)} as the one who made step ${tok(id)}, which the fact says ${tok(who)} made`);
      // A mask's step told of the team (`The bounty contract paid the team §`), in the words since the previous slot.
      const raw = text.slice(0, m.index);
      const since = raw.slice(Math.max(raw.lastIndexOf("}"), ...[",", ";", ":"].map((c) => raw.lastIndexOf(c)), raw.search(/\.\s[^.]*$/)) + 1);
      // The team's account is not read here: on testnet it is also the bounty contract's.
      if (!team && /\bthe\s+team\b(?!['’]s|\s+lost\b)/i.test(since)) {
        out.push(`${where}: names ${tok("team")} as the one who made step ${tok(id)}, which the fact says ${tok(who)} made`);
      }
    }
  }
  // An amount and a moment told in one part of a sentence are of one event: what the safe sent goes with the drain, a
  // payout with the payout or the judge's yes, the bounty locked with the opening or the deadline, what the team put
  // in with the funding, what went back with the refund. A total adds two events, so it goes with no one moment unless
  // the words say `in all`. Each amount is read with the moment nearest it; parts end at `;`, a full stop, `, and`, and
  // at words that move to another moment (`then`, `later`, `after`, `before`, `when`, `once`, `until`).
  {
    const PAIRS: Readonly<Record<string, readonly string[]>> = { take: ["drain", "move"], pay: ["paid", "claim_confirmed", "claim"], lock: ["open", "deadline", "claim", "claim_confirmed", "claim_refused"], fund: ["fund", "open"], back: ["refund", "deadline"], total: [] };
    const flat = text.replace(SLOT, (w) => MARK + " ".repeat(w.length - 1));
    const cuts = [0, ...[...flat.matchAll(/[;!?]|\.(?!\d)|,\s*(?:and|but|so)\b|\b(?:then|but|while|whereas|later|afterwards|before|when|once|until)\b|\bafter\b(?!\s+(?:the\s+)?(?:start|opening)\b)|\band\s+(?=(?:[a-z]+ed|was|got|took|won|broke|swept|paid)\b|the\s+(?:team|judge|bounty|safe)\b|[A-Z]{3,}\b)/g)].map((x) => x.index), flat.length];
    // A part that opens with `and` and a verb of the same subject (`drained it at § and took § NEAR`) goes on from the
    // moment of the part before, unless it says it is later.
    const soft = (at: number) => /^and\s+(?:[a-z]+ed|was|got|took|won|broke|swept|paid)\b/.test(flat.slice(at));
    const placed = [...text.matchAll(SLOT)].flatMap((m) => {
      const [, sid, sfield] = m as unknown as [string, string, string];
      const se = refs.includes(sid) ? byId.get(sid) : undefined;
      return se ? [{ at: m.index, end: m.index + m[0].length, id: sid, field: sfield, e: se, meaning: meaningOf(se, sfield) }] : [];
    });
    // A moment that opens a sentence (`At §, …`, `§: …`) covers every amount after it in that sentence.
    const leads = placed.filter((x) => (x.meaning.kind === "time" || x.meaning.kind === "duration") && /^(?:[^§]*[.!?;]\s+)?\s*(?:(?:at|on|by|in)\s+)?$/i.test(flat.slice(0, x.at)));
    for (let c = 0; c + 1 < cuts.length; c++) {
      const from = cuts[c]!;
      const to = cuts[c + 1]!;
      const here = placed.filter((x) => x.at >= from && x.at < to);
      const amounts = here.filter((x) => x.meaning.kind === "amount" && x.meaning.role !== null && PAIRS[x.meaning.role] !== undefined);
      const moments = here.filter((x) => (x.meaning.kind === "time" || x.meaning.kind === "duration") && x.meaning.role !== null);
      const lead = leads.filter((x) => x.at < from).at(-1);
      const sentenceEnd = (() => {
        const m = /[.!?](?!\d)/.exec(flat.slice(from));
        return m ? from + m.index : flat.length;
      })();
      const before = c > 0 && soft(from) && !/\b(?:later|then|afterwards|subsequently)\b/i.test(flat.slice(from, sentenceEnd)) ? placed.filter((x) => (x.meaning.kind === "time" || x.meaning.kind === "duration") && x.at >= cuts[c - 1]! && x.at < from).at(-1) : undefined;
      if (!amounts.length || (!moments.length && !lead && !before)) continue;
      const inAll = /\b(?:in\s+all|in\s+total|all\s+told|overall)\b/i.test(flat.slice(from, to));
      for (const a of amounts) {
        // Nearest, with a comma between counting as far: `§ NEAR swept at §, § NEAR paid at §` pairs each with its own.
        // Measured edge to edge: a long slot name does not push its own moment away.
        // An amount that hangs off another (`§ NEAR of the § NEAR in the safe`, `less than the § NEAR locked`) is told
        // as that one's context, not as an event of its own.
        const prevAmount = amounts.filter((b) => b.at < a.at).at(-1);
        if (prevAmount && /^\s*nears?\b[^§]{0,20}?\b(?:of|out\s+of|from|than|below|under|versus|against)\s+(?:the\s+|a\s+|its\s+)?$/i.test(flat.slice(prevAmount.end, a.at))) continue;
        // The moment an amount goes with: the first after it, before the next amount (`locked § NEAR at § and got §
        // NEAR back at §`), else the last before it (`At § NOVA swept § NEAR and was paid § NEAR`).
        const nextAmount = amounts.find((b) => b.at > a.at);
        // `… was paid § NEAR later, at §`: a moment past a `later` in the same sentence is the amount's own.
        const laterOwn = placed.find((q) => (q.meaning.kind === "time" || q.meaning.kind === "duration") && q.at > a.at && q.at < sentenceEnd && (!nextAmount || q.at < nextAmount.at) && /\b(?:later|then|afterwards)\b/i.test(flat.slice(a.end, q.at)));
        const near = laterOwn ?? moments.find((q) => q.at > a.at && (!nextAmount || q.at < nextAmount.at)) ?? moments.filter((q) => q.at < a.at).at(-1) ?? (lead && !/[.!?;]/.test(flat.slice(lead.end, a.at)) ? lead : undefined) ?? before;
        if (!near) continue;
        // A length carried over `and` (`broke SAFE-0001 in § and was paid § NEAR`) tells what came first, not the moment of
        // the payout; and a total `in all` adds up the race whatever moment the sentence began with.
        if (near === before && near !== laterOwn && !leads.includes(near) && ((near.meaning.kind === "duration" && a.meaning.role === "pay") || (a.meaning.role === "total" && inAll))) continue;
        // Two fields of one event's fact are the same event; a race's fact holds several.
        if (near.id === a.id && a.e.kind !== "race") continue;
        // `in all` adds the events up over a length of the race, never at one instant (`At § NOVA took § NEAR in all`).
        if (a.meaning.role === "total" && inAll && near.meaning.kind === "duration" && near.at < a.at && /\b(?:drained|broke|cracked|swept|emptied)\s+(?:\S+\s+){0,2}$/i.test(flat.slice(0, near.at))) continue;
        // Another field of the same fact with the same value may be the one the moment goes with (paid = locked).
        const fits = (role: string) => PAIRS[role]?.includes(near.meaning.role!) ?? false;
        const twinFits = Object.entries(ROLE_FIELD).some(([role, f]) => f !== a.field && valueOf(a.e, f) !== null && valueOf(a.e, f) === valueOf(a.e, a.field) && fits(role));
        // A date is a day: it goes with an amount whose own event, in the same race, fell on that day.
        const dayFits = (near.field === "date" || near.field.endsWith("_date")) && [...byId.values()].some((x) => x.race === a.e.race && Object.keys(x.data).some((f) => (f === "date" || f.endsWith("_date")) && PAIRS[a.meaning.role!]?.includes(meaningOf(x, f).role ?? "") && valueOf(x, f) === valueOf(near.e, near.field)));
        // A total is whole once the bounty is paid: `By § NOVA had § NEAR in all`, `paid § NEAR at §, for § NEAR in all`.
        const totalBy = a.meaning.role === "total" && ["paid", "claim_confirmed"].includes(near.meaning.role!) && (inAll || /\bby\s*$/i.test(flat.slice(0, near.at)));
        if (!fits(a.meaning.role!) && !twinFits && !dayFits && !totalBy) out.push(`${where}: tells ${tok(`${a.id}.${a.field}`)} and ${tok(`${near.id}.${near.field}`)} as one event; split the sentence`);
      }
    }
  }
  // A claim's time goes with the judge's word on that claim. A sentence that says only "confirmed" (or only "refused")
  // says it of every claim it times: "NOVA claimed at § and the judge confirmed it" holds only for a confirmed claim.
  {
    const slots = [...text.matchAll(SLOT)];
    const marked = text.replace(SLOT, "§");
    let k = 0;
    const ruling = (part: string) => ({ yes: YES.test(part), no: NO.test(part) });
    const everything = ruling(marked);
    const isClaimTime = (m: RegExpMatchArray) => {
      const e = refs.includes(m[1]!) ? byId.get(m[1]!) : undefined;
      const r = e ? meaningOf(e, m[2]!) : null;
      return r?.kind === "time" && (r.role === "claim_confirmed" || r.role === "claim_refused");
    };
    const totalClaims = slots.filter(isClaimTime).length;
    for (const sentence of marked.split(/(?<=[.!?])\s+/)) {
      const whole = ruling(sentence);
      const inSentence = slots.slice(k, k + (sentence.match(/§/g) ?? []).length).filter(isClaimTime).length;
      for (const clause of sentence.split(/(?<=[;:])\s*/)) {
        const here = slots.slice(k, (k += (clause.match(/§/g) ?? []).length));
        // The judge's word in the slot's own part of the sentence (between semicolons or after a colon), else in the
        // whole sentence when this part times the sentence's only claims.
        const own = ruling(clause);
        const alone = inSentence === 1 && here.filter(isClaimTime).length === 1;
        // `…; the judge confirmed both claims`, `… The judge confirmed it.` with one claim in the whole text: the word
        // is about every claim the text times.
        const all = (whole.yes || whole.no) && /\b(?:both|all|each|every|them)\b/i.test(sentence) ? whole : null;
        const textOnly = totalClaims === 1 && here.filter(isClaimTime).length === 1 ? everything : null;
        const said = (r: { yes: boolean; no: boolean } | null) => r !== null && (r.yes || r.no);
        // A text that tells of one claim (no `claims`, `both`, `again`, `later`, `first`…) gives the judge's one word to
        // every claim time in it, across semicolons, colons and sentences.
        const single = !/\b(?:claims|both|each|another|next|later|earlier|again|only|one|first|second|last|other|then)\b/i.test(marked);
        const { yes, no } = said(own)
          ? own
          : single && said(whole) && whole.yes !== whole.no
            ? whole
            : single && said(everything) && everything.yes !== everything.no
              ? everything
              : alone && said(whole)
                ? whole
                : said(all)
                  ? all!
                  : said(textOnly)
                    ? textOnly!
                    : { yes: false, no: false };
        // Several claim times in one part: each word of the judge goes to the claim time nearest it, and a claim time no
        // word is nearest to is told without one (`After a refused claim at §, NOVA claimed again at §`).
        const claimHere = here.filter(isClaimTime);
        if (claimHere.length > 1 && said(own)) {
          const words = [...clause.matchAll(new RegExp(`${YES.source}|${NO.source}`, "gi"))];
          const pos = (n: number) => {
            let seenSlots = -1;
            for (let i = 0; i < clause.length; i++) if (clause[i] === "§" && ++seenSlots === n) return i;
            return 0;
          };
          const claimIdx = here.map((m, n) => (isClaimTime(m) ? n : -1)).filter((n) => n >= 0);
          for (const [n, m] of here.entries()) {
            if (!isClaimTime(m)) continue;
            const at = pos(n);
            // The judge's word before the claim time, since the previous claim time; else one right after it that leads
            // to no other claim (`claim at § was confirmed`, not `§ and confirmed a claim at §`).
            const k = claimIdx.indexOf(n);
            const prevAt = k > 0 ? pos(claimIdx[k - 1]!) : -1;
            const nextAt = k + 1 < claimIdx.length ? pos(claimIdx[k + 1]!) : clause.length;
            const before = words.filter((w) => w.index > prevAt && w.index < at);
            const after = words.filter((w) => w.index > at && w.index < nextAt && !/\b(?:at|on|claim)\b/i.test(clause.slice(w.index + w[0].length, nextAt)));
            const mine = before.length ? [before.at(-1)!] : after.slice(0, 1);
            const sayYes = mine.some((w) => YES.test(w[0]));
            const sayNo = mine.some((w) => NO.test(w[0]));
            if (sayYes === sayNo) continue;
            const [, id, field] = m as unknown as [string, string, string];
            const e = byId.get(id)!;
            const { role } = meaningOf(e, field);
            const word = sayYes ? "claim_confirmed" : "claim_refused";
            if (role !== word) out.push(`${where}: puts ${tok(`${id}.${field}`)} where the words around it do not say ${role}`);
          }
          continue;
        }
        if (yes === no) continue;
        const word = yes ? "claim_confirmed" : "claim_refused";
        for (const m of here) {
          const [, id, field] = m as unknown as [string, string, string];
          const e = refs.includes(id) ? byId.get(id) : undefined;
          if (!e) continue;
          const { kind, role } = meaningOf(e, field);
          if (kind === "time" && (role === "claim_confirmed" || role === "claim_refused") && role !== word) out.push(`${where}: puts ${tok(`${id}.${field}`)} where the words around it do not say ${role}`);
        }
      }
    }
  }

  // How each race ended is what the chain says: a race that fell is not said to have held, nor the other way. A sentence
  // is read phrase by phrase (split at commas and `and`): a word of an outcome is about the race named in its phrase,
  // the nearest by the nearer edge of its name when there are several; with none named there, about the race named last
  // before it; with none at all, about the races of the facts the sentence cites, else every race of the page. A phrase
  // that names races and says nothing of them (`held race-0001 and race-0002`) takes the words of the phrase before. A
  // word negated right before it (`was not drained`, `nobody broke`) says the other side.
  const raceFact = (race: string) => [...byId.values()].find((e) => e.kind === "race" && e.race === race);
  const allRaces = [...byId.values()].filter((e) => e.kind === "race");
  const ofCited = [...new Set(facts.map((e) => e.race).filter((r): r is string => typeof r === "string"))].map(raceFact).filter((e): e is Evidence => e !== undefined);
  const OUTCOME: readonly (readonly [RegExp, readonly string[], "held" | "fell"])[] = [
    [HELD_WORDS, ["broken", "unconfirmed"], "held"],
    [BACK_WORDS, ["broken"], "held"],
    [FELL_WORDS, ["held", "called_off"], "fell"],
  ];
  const against = (e: Evidence, outcomes: readonly string[], side: "held" | "fell") => {
    if (outcomes.includes(String(e.data["outcome"]))) out.push(`${where}: says ${tok(e.race ?? "it")} ${side}, which the chain says it did not`);
  };
  // The slots of each phrase, in order: the separators the text is split at hold no slot.
  const slotFacts = [...text.matchAll(SLOT)].map((m) => (refs.includes(m[1]!) ? byId.get(m[1]!) : undefined));
  let seen = 0;
  for (const part of text.replace(SLOT, MARK).split(/[;!?]|\.(?!\d)/)) {
    let carry: Evidence[] | null = null;
    let said: (typeof OUTCOME)[number][] = [];
    let waiting: Evidence[] = [];
    for (const phrase of part.split(/,|\band\b|\bbut\b|\bwhile\b|\bwhereas\b/i)) {
      const named = [...phrase.matchAll(/\brace-\d+\b/gi)].map((x) => ({ at: x.index, race: x[0].toLowerCase() }));
      // With no race named, a phrase is about the races of its own slots (`got back § NEAR and was paid § NEAR`).
      const own = [...new Set(slotFacts.slice(seen, (seen += (phrase.match(/§/g) ?? []).length)).map((x) => x?.race).filter((r): r is string => typeof r === "string"))]
        .map(raceFact)
        .filter((x): x is Evidence => x !== undefined);
      const about = (at: number): Evidence[] => {
        if (!named.length) return own.length ? own : (carry ?? (ofCited.length ? ofCited : allRaces));
        const gap = (b: { at: number; race: string }) => (at > b.at ? Math.max(0, at - (b.at + b.race.length)) : b.at - at);
        const e = raceFact(named.reduce((a, b) => (gap(b) < gap(a) ? b : a)).race);
        return e ? [e] : [];
      };
      const here: (typeof OUTCOME)[number][] = [];
      for (const rule of OUTCOME) {
        for (const m of phrase.matchAll(new RegExp(rule[0].source, "gi"))) {
          if (NEGATED.test(phrase.slice(0, m.index)) || /^\s*neither\b/i.test(phrase)) {
            // `Nobody was paid in race-0002`, `Neither race held`: the negated word says the other side, except of a
            // race no mask ran when the words are about masks.
            const byMask = /\b(?:no\s+mask|none\s+of\s+the\s+masks|by\s+(?:a|any)\s+mask|masks?)\b/i.test(phrase);
            // Only a negation of everyone (`nobody`, `no one`, `neither race`) or of the race itself says the other side;
            // `Neither ONYX nor ORACLE drained it` says nothing of how the race ended.
            const everyone = /\b(?:nobody|no\s+one|none|neither\s+(?:race|of))\b/i.test(phrase) || !/\b[A-Z]{3,}\b/.test(phrase.slice(0, m.index));
            if (!everyone) continue;
            const other = rule[2] === "fell" ? (["broken", "unconfirmed"] as const) : (["held", "called_off"] as const);
            for (const e of about(m.index)) if (!(byMask && e.data["masks_count"] === 0)) against(e, other, rule[2] === "fell" ? "held" : "fell");
            continue;
          }
          here.push(rule);
          // `No mask broke open-admin` is true of a race no mask ran, however it ended.
          const noMask = /^(?:no\s+mask|none\s+of\s+the\s+masks)\b/i.test(m[0]);
          for (const e of about(m.index)) if (!(noMask && e.data["masks_count"] === 0)) against(e, rule[1], rule[2]);
        }
      }
      const these = named.map((n) => raceFact(n.race)).filter((e): e is Evidence => e !== undefined);
      const bare = !phrase.replace(/\brace-\d+\b/gi, " ").replace(/\b(?:in|on|too|also|both|as\s+well|the|then|like|as\s+did|as\s+in|as\s+with|just\s+like)\b/gi, " ").trim().replace(/[.:]/g, "");
      if (!here.length && bare) for (const rule of said) for (const e of these) against(e, rule[1], rule[2]);
      // Races named alone before the words of an outcome (`In race-0001 and race-0002 the judge confirmed a drain`)
      // take those words too.
      if (here.length) for (const rule of here) for (const e of waiting) against(e, rule[1], rule[2]);
      waiting = !here.length && bare ? [...waiting, ...these] : [];
      // A phrase that only compares or adds (`which came after race-0001`, `unlike race-0002`) is not what the next
      // phrase is about.
      const aside = /^\s*(?:which|who|that|unlike|like|as|than|after|before)\b/i.test(phrase);
      if (these.length && !aside) carry = [these.at(-1)!];
      if (here.length) said = here;
    }
  }
  const slotted = text.replace(SLOT, MARK);
  if (/[{}]/.test(slotted)) out.push(`${where}: carries a broken slot`);
  // Slots stand alone: two glued into a new number, a slot made into a name, or UTC written twice are refused.
  if (/§[.,:/-]?§|[\p{L}]-§|§-[\p{L}]/u.test(slotted)) out.push(`${where}: glues a number to a word or sign (slot); write the unit after a space`);
  if (/§\s*UTC\b/.test(slotted)) out.push(`${where}: writes UTC after a time, which carries it`);

  // Words are read without the cited facts' account-shaped names (a dot or a digit in them) and the library's own
  // targets (relay-trust): a name is not a claim, and a plain word from the chain, like a mask called GUARANTEED, is
  // still checked as a word.
  const plain = withoutNames(slotted, names.filter((n) => /[.\d]/.test(n) || libraryEntry(n) !== null), MARK);
  // The same words with every mask's account read as the mask: who drained, was paid or moved is checked either way.
  const masked = withoutNames(asMasks(slotted), names.filter((n) => /[.\d]/.test(n) || libraryEntry(n) !== null), MARK);
  // A model never writes a digit: what is left after the slots and the cited names is words.
  if (/\p{N}/u.test(plain.replace(/\b(?:race|safe)-\d+\b/gi, MARK))) out.push(`${where}: writes a number itself; every number goes in as a slot like {E4.loot_near} from a fact it cites`);
  // The reason names the word, so a second try knows what to drop.
  for (const [re, why] of BANNED) {
    const hit = re.exec(plain)?.[0].trim().split(/\s+/).at(-1);
    if (hit !== undefined) out.push(`${where}: ${why} (${tok(hit)})`);
  }
  const word = numberWord(plain);
  if (word) out.push(`${where}: writes the number "${tok(word)}" in words; every number goes in as a slot from a fact`);
  const asDigits = plain.replaceAll(MARK, "0");
  const unit = otherUnit(asDigits);
  if (unit) out.push(`${where}: counts in ${tok(unit)}; a page counts NEAR only`);
  if (/\d\s*\/\s*\d/.test(asDigits)) out.push(`${where}: carries a fraction`);
  if (/\d\s*[×x]\s|(^|\s)[×x]\s*\d|\d\s+times\s+(?:the|a|an|more|less|fewer|as|its|their|that|this|what|bigger|larger|higher|smaller|over|near)\b/i.test(asDigits)) out.push(`${where}: carries a multiplier`);
  if (/§[\p{L}%‰×]|[\p{L}×]§/u.test(plain)) out.push(`${where}: glues a number to a word or sign (slot); write the unit after a space`);
  if (!facts.length) return out;

  const lower = new Set(names.map((x) => x.toLowerCase()));
  const exact = new Set(names);
  const isName = (w: string) => (caseMatters(w) ? exact.has(w) : lower.has(w.toLowerCase()));
  // A mask or an account in capitals that the cited facts do not name: VIPER is no mask of this race.
  for (const caps of new Set(plain.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*\b/g) ?? [])) {
    if (caps.length >= 3 && !CAPS.has(caps) && !lower.has(caps.toLowerCase())) out.push(`${where}: names ${tok(caps)}, which none of the facts it cites ${at} names`);
  }
  // A mask the arena knows, written as a name, that the cited facts do not name: Nova did not race on open-admin.
  for (const m of plain.matchAll(/\b(Nova|Onyx|Oracle|Ronin|Volt|Wraith|Viper)\b/g)) {
    if (!lower.has(m[1]!.toLowerCase())) out.push(`${where}: names ${tok(m[1]!)}, which none of the facts it cites ${at} names`);
  }
  // Who broke it is who the cited facts say drained it: ONYX raced, NOVA drained.
  const drainers = new Set(
    facts
      .flatMap((e) => [e.data["winner"], e.data["winner_name"], ...(e.kind === "drain" ? [e.data["who"], e.data["who_name"]] : [])])
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.toLowerCase()),
  );
  const NAME = String.raw`([A-Z][A-Za-z0-9-]{2,})`;
  const VERB = String.raw`(?:drained|drains|broke(?!\s+in\b)|breaks(?!\s+in\b)|took(?!\s+(?:(?:the\s+safe\s+|it\s+|SAFE-\d+\s+)?over|control)\b)|takes(?!\s+(?:(?:the\s+safe\s+|it\s+|SAFE-\d+\s+)?over|control)\b)|won|wins|beat|swept|sweeps|cracked|emptied|came\s+out\s+on\s+top)`;
  const subjects = [
    ...[...masked.matchAll(new RegExp(String.raw`\b${NAME}(?:\s*\([^)]*\))?(?:\s*,\s*${NAME})?(?:\s+and\s+${NAME})?\s+(?:(?!and\b)[a-z]+\s+)?${VERB}\b`, "g"))]
      // `Neither ONYX nor ORACLE drained it`, `ONYX and ORACLE never broke it`: nobody is named as the one.
      .filter((m) => !/\b(?:never|not)\b/i.test(m[0]) && !/\b(?:neither|nor)\b[^.;]*$/i.test(masked.slice(0, m.index)))
      .flatMap((m) => [m[1], m[2], m[3]]),
    ...[
      ...masked.matchAll(
        new RegExp(
          String.raw`\b(?:drained|broken|swept|taken|won|beaten)\s+by\s+${NAME}|\bfell\s+to\s+${NAME}|\bwinner(?:\s+of\s+[\w§-]+)?\s+(?:was|is)\s+${NAME}|\b${NAME}\s+(?:was|is)\s+the\s+winner\b|\b(?:bounty|payout|prize|reward|loot)\s+went\s+to\s+${NAME}`,
          "g",
        ),
      ),
    ].flatMap((m) => m.slice(1)),
  ].filter((x): x is string => typeof x === "string");
  for (const who of new Set(subjects)) {
    if (lower.has(who.toLowerCase()) && !drainers.has(who.toLowerCase())) out.push(`${where}: names ${tok(who)} as the one who drained it, which none of the facts it cites ${at} say`);
  }
  // The network is the facts' own: a testnet page never says mainnet.
  if (/\bmainnet\b/i.test(plain) && !facts.some((e) => e.data["network"] === "mainnet")) out.push(`${where}: names ${tok("mainnet")}, which none of the facts it cites ${at} names`);
  // Where no mask raced (the team's own sandbox run), no mask raced, drained or broke it.
  const aboutRaces = (() => {
    const named = [...new Set([...plain.matchAll(/\brace-\d+\b/gi)].map((x) => x[0].toLowerCase()))].map(raceFact).filter((e): e is Evidence => e !== undefined);
    return named.length ? named : ofCited.length ? ofCited : allRaces;
  })();
  if (aboutRaces.length && aboutRaces.every((e) => e.data["masks_count"] === 0 || (Array.isArray(e.data["masks"]) && e.data["masks"].length === 0))) {
    if (/(?<!\b(?:neither|no|not|never|without)\b[^.;,]*)\b(?:a|the|one|some|its|team['’]s)\s+(?:[a-z]+\s+)?mask\b(?!\s+(?:wars|check)\b)|(?:[\w-]+|§)['’]s\s+(?:[a-z]+\s+)?mask\b|(?<!(?:\bno|§)\s)\bmasks\s+(?:raced|tried|moved|went|made|got|broke|drained|failed|in)\b/i.test(plain)) {
      out.push(`${where}: names ${tok("mask")}, which none of the facts it cites ${at} names`);
    }
  }
  // A step told without a slot is still told of whoever made it: the masks the page's facts show making it in the
  // races the sentence is about. The one paid is the winner, or whoever a payout the facts show went to.
  const racesOf = new Set(facts.map((e) => e.race).filter((r): r is string => typeof r === "string"));
  const makers = (kinds: readonly string[]) =>
    new Set(
      [...byId.values()]
        .filter((e) => kinds.includes(e.kind) && (!racesOf.size || (typeof e.race === "string" && racesOf.has(e.race))))
        .flatMap((e) => [e.data["who"], e.data["who_name"]])
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.toLowerCase()),
    );
  const STEPS: readonly (readonly [string, readonly string[]])[] = [
    [String.raw`called\s+set_owner|took\s+(?:the\s+safe\s+)?over|made\s+itself\s+(?:the\s+)?owner|owned`, ["move", "drain"]],
    [String.raw`called\s+sweep|swept|emptied|made\s+the\s+break`, ["drain"]],
    [String.raw`opened|locked|funded|loaded`, ["open", "fund"]],
    [String.raw`claimed|filed\s+(?:a|the)\s+claim`, ["claim"]],
    [String.raw`moved|made\s+a\s+move`, ["move", "drain"]],
  ];
  const payees = new Set([...drainers, ...makers(["paid"])]);
  for (const m of masked.matchAll(new RegExp(String.raw`\bpaid\s+${NAME}|\b${NAME}\s+(?:was|got)\s+paid\b|\b${NAME}\s+(?:received|earned|collected|pocketed|got|took\s+home|ended\s+up\s+with)\s+the\s+(?:bounty|payout)\b`, "g"))) {
    const who = (m[1] ?? m[2] ?? m[3])!;
    if (lower.has(who.toLowerCase()) && maskNames.has(who.toLowerCase()) && !payees.has(who.toLowerCase())) out.push(`${where}: names ${tok(who)} as the one who made that step, which none of the facts it cites ${at} say`);
  }
  for (const [verb, kinds] of STEPS) {
    const by = makers(kinds);
    for (const m of masked.matchAll(new RegExp(String.raw`\b${NAME}(?:\s+and\s+${NAME})?(?:['’]s)?,?\s+(?:(?!never\b|not\b|no\b)[a-z]+\s+)?(?:${verb})\b`, "g"))) {
      // `ORACLE never moved`, `Neither ONYX nor ORACLE made a move`: no step is told.
      const upTo = masked.slice(0, m.index + m[0].length - (m[0].match(new RegExp(String.raw`(?:${verb})$`))?.[0].length ?? 0));
      if (/\b(?:never|not|no|didn['’]t)\s+(?:[a-z]+\s+)?$/i.test(upTo) || /\bneither\b[^.;]*$/i.test(masked.slice(0, m.index))) continue;
      // `ONYX and NOVA called set_owner`: each one named.
      for (const who of [m[1], m[2]].filter((x): x is string => x !== undefined)) {
        if (lower.has(who.toLowerCase()) && maskNames.has(who.toLowerCase()) && !by.has(who.toLowerCase())) out.push(`${where}: names ${tok(who)} as the one who made that step, which none of the facts it cites ${at} say`);
      }
    }
  }
  for (const id of identifiersIn(slotted)) {
    if (!isName(id)) out.push(`${where}: names ${tok(id)}, which none of the facts it cites ${at} names`);
  }
  // Every word is a word of the facts the sentence cites, or one of the few the gate reads itself (vocabulary.ts): a
  // reentrancy bug, an overflow or a scam no fact tells is refused, whatever the numbers and names around it. A word in
  // capitals the names check refuses already (VIPER) is left to it.
  const ownCaps = (w: string) => /^[A-Z][A-Z0-9]{2,}$/.test(w) && !CAPS.has(w);
  for (const w of strangeWords(plain, facts, (w) => isName(w) || ownCaps(w))) out.push(`${where}: writes ${tok(w)}, a word none of the facts it cites ${at} write`);
  out.push(...judgeWords(slotted, where, byId, racesOf));
  return [...new Set(out)];
}

/** A word of the judge's, or of a claim: what makes a word of yes or no the judge's. */
const JUDGED = /\b(?:judge|judged|claims?|claimed|verdict|ruling)\b/i;
/** A negation earlier in the same phrase: `nobody's claim was confirmed`, `the judge never refused it`. */
const NEGATION = /\b(?:not|never|no|nobody|none|nothing|neither|nor)\b|n['’]t\b/i;

/**
 * The judge's word told without a slot is still the chain's: `the judge refused its claim` of a claim the judge
 * confirmed, or `the judge confirmed it` of a race nobody broke, is refused. A word of yes or no is the judge's in a
 * phrase that names the judge or a claim, or in a phrase with no subject of its own right after one (`ORACLE claimed
 * the bounty and got it`); `ONYX's call failed` or `the contract refused its plan` is no word of the judge. It is
 * checked against every claim and outcome of the races the sentence names, else of the races its facts are of, else of
 * every race of the page: a yes holds when the judge confirmed a claim or a drain there, a no when a claim there was
 * refused or is still waiting, or a race there ended any other way than broken.
 */
function judgeWords(slotted: string, where: string, byId: ReadonlyMap<string, Evidence>, racesOf: ReadonlySet<string>): Problem[] {
  const out: Problem[] = [];
  const allRaces = [...byId.values()].filter((e) => e.kind === "race" && typeof e.race === "string").map((e) => e.race!);
  for (const sentence of slotted.split(/[;!?]|\.(?!\d)/)) {
    if (!JUDGED.test(sentence)) continue;
    let yes = false;
    let no = false;
    let context = false;
    for (const phrase of sentence.split(/,|:|\band\b|\bbut\b|\bthen\b|\bwhile\b|\bwhereas\b/i)) {
      const own = JUDGED.test(phrase);
      // A phrase that opens with a verb or `it` goes on with the subject before it; one that opens with a name or a
      // noun of its own (`ONYX failed`, `the contract refused it`) is about that.
      const goesOn = /^\s*(?:it\s+|which\s+|that\s+)?(?!the\b|a\b|an\b|its\b|their\b|this\b)[a-z]/.test(phrase);
      context = own || (context && goesOn);
      if (!context) continue;
      for (const m of phrase.matchAll(new RegExp(YES.source, "gi"))) {
        const negated = NEGATION.test(phrase.slice(0, m.index)) || /^\s+(?:no|nothing|none)\b/i.test(phrase.slice(m.index + m[0].length));
        if (negated) no = true;
        else yes = true;
      }
      for (const m of phrase.matchAll(new RegExp(NO.source, "gi"))) {
        if (NEGATION.test(phrase.slice(0, m.index))) yes = true;
        else no = true;
      }
    }
    if (yes === no) continue;
    const named = [...new Set([...sentence.matchAll(/\brace-\d+\b/gi)].map((x) => x[0].toLowerCase()))];
    const scope = new Set(named.length ? named : racesOf.size ? [...racesOf] : allRaces);
    const claims = [...byId.values()].filter((e) => e.kind === "claim" && typeof e.race === "string" && scope.has(e.race));
    const outcomes = [...byId.values()].filter((e) => e.kind === "race" && typeof e.race === "string" && scope.has(e.race)).map((e) => String(e.data["outcome"]));
    const saidYes = claims.some((c) => c.data["verdict"] === "paid") || outcomes.includes("broken");
    const saidNo = claims.some((c) => c.data["verdict"] !== "paid") || outcomes.some((o) => o !== "broken");
    if ((yes && !saidYes) || (no && !saidNo)) out.push(`${where}: says the judge said ${yes ? "yes" : "no"}, which the chain says it did not`);
  }
  return out;
}

/** A claim as people read it: every slot filled from the facts. */
export function renderClaim(c: Claim, evidence: readonly Evidence[]): string {
  return render(c.text, evidence);
}

export type Verdict = { ok: true; page: Page } | { ok: false; problems: Problem[] };

/** The one gate between a model's reply and the site. */
export function checkPage(reply: unknown, evidence: readonly Evidence[]): Verdict {
  const parsed = schema.safeParse(typeof reply === "string" ? parseReply(reply) : reply);
  if (!parsed.success) {
    // The path and zod's issue code only: a reason carries no text the reply wrote.
    const issues = parsed.error.issues.slice(0, 5).map((i) => `shape: ${i.path.map(String).join(".").replace(/[^A-Za-z0-9_.]/g, "").slice(0, 60) || "reply"} ${SHAPE_CODES.has(i.code) ? i.code : "invalid"}`);
    return { ok: false, problems: issues.length ? [...new Set(issues)] : ["shape: reply not_json"] };
  }
  const page = parsed.data;
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const problems: Problem[] = [];

  problems.push(...checkClaim(page.lede, "lede", byId, LIMITS.lede));
  const seen = new Set<SectionId>();
  let last = -1;
  for (const s of page.sections) {
    if (seen.has(s.id)) problems.push(`section ${s.id}: comes twice`);
    seen.add(s.id);
    const at = SECTIONS.indexOf(s.id);
    if (at < last) problems.push(`section ${s.id}: out of order (record, money, code)`);
    last = at;
    s.claims.forEach((c, i) => problems.push(...checkClaim(c, `${s.id} ${i + 1}`, byId, LIMITS.claim)));
  }
  const needs: SectionId[] = [];
  if (evidence.some((e) => e.kind === "race")) needs.push("record", "money");
  if (evidence.some((e) => e.kind === "code" || e.kind === "library")) needs.push("code");
  for (const id of needs) if (!seen.has(id)) problems.push(`section ${id}: missing, and the facts support it`);

  if (problems.length) return { ok: false, problems };
  const clean = (c: Claim): Claim => ({ text: c.text.trim().replace(/\s+/g, " "), refs: [...new Set(c.refs)] });
  return { ok: true, page: { lede: clean(page.lede), sections: page.sections.map((s) => ({ id: s.id, claims: s.claims.map(clean) })) } };
}
