/**
 * The X thread of one race: 4 to 8 posts, each with its own picture. The first sells the fight and the money and
 * carries no link; then what MASK WARS is, how the race went step by step, the real numbers with links to the chain,
 * and how to try it. Every number comes from the story. Tags only for what really ran in the race.
 *
 * A sealed round is told by its own steps on chain: the vault opens, a mask seals its plan, the window closes, the
 * plan is played, revealed and judged, the contract pays. Nothing is said that the record does not hold.
 */

import { lintPost, xLength } from "../lint.ts";
import { near, nearShort, toYocto } from "./near.ts";
import type { HandStory, RaceStory, RoundStory } from "./story.ts";
import { dayOf, listNames, SITE, timeOf } from "./story.ts";

/** The public repository: where anyone runs a sealed round on their own machine. */
export const PUBLIC_REPO = "github.com/plavutskyi/mask-wars";

/** Who we tag, and only where their work is in the race: the chain, the models, the judge. Never the judges of the hackathon. */
export const THREAD_TAGS = ["@NEARProtocol", "@near_ai", "@out_layer"] as const;

export const THREAD_MIN = 4;
export const THREAD_MAX = 8;
/** The first post fits X's 280 so it reads whole in the feed; the rest explain and may run long (X Premium). */
export const FIRST_MAX = 280;
export const POST_MAX = 600;

export const RACE_CARDS = ["result", "arena", "how", "numbers", "next"] as const;
export type RaceCardKind = (typeof RACE_CARDS)[number];

export const cardFile = (kind: RaceCardKind): string => `cards/${String(RACE_CARDS.indexOf(kind) + 1).padStart(2, "0")}-${kind}.png`;
export const CLIP_FILE = "clip.mp4";

export type ThreadPost = {
  n: number;
  text: string;
  /** The picture this post goes out with: the clip on the first, a card on every other. */
  media: { kind: "clip"; file: string; poster: string } | { kind: "card"; card: RaceCardKind; file: string };
};

/** A link as it reads in a post: X shortens it anyway, the scheme only takes room. */
const bare = (url: string): string => url.replace(/^https?:\/\//, "");

const card = (kind: RaceCardKind): ThreadPost["media"] => ({ kind: "card", card: kind, file: cardFile(kind) });

/** The first of these that fits `max` in X's count; the last one when none does, for the lint to name. */
function fitting(max: number, ...variants: string[]): string {
  return variants.find((v) => xLength(v) <= max) ?? variants[variants.length - 1]!;
}

export function raceThread(s: RaceStory): ThreadPost[] {
  const posts = s.kind === "round" ? roundPosts(s) : racePosts(s);
  return posts.map((p, i) => ({ n: i + 1, ...p }));
}

/**
 * A sealed round, told by what its record holds and nothing else: who opened the vault and with what, who sealed a
 * plan and when, the window, the drain, the reveal, the judge, the payout. The masks' work off chain is said only
 * when the record carries its sandbox board.
 */
function roundPosts(s: RoundStory): Omit<ThreadPost, "n">[] {
  const r = s.record;
  const W = s.winner.name;
  const season = s.opener === "season";
  const afterStorage = toYocto(r.payout.amount) < toYocto(r.bounty) ? ` (the ${s.bounty} NEAR bounty after storage and fees)` : "";
  // The next round is the treasury's own word, kept in the record when it was read; without it nothing is said.
  const next = r.next
    ? `\n\n${season ? "Round" : "Season round"} ${r.next.round} opens ${dayOf(r.next.at)} at ${timeOf(r.next.at)} UTC with ${nearShort(r.next.safe)} NEAR in the vault.`
    : "";

  const opening = `An AI mask broke into a vault on ${s.chain} and walked out with ${s.drained} NEAR.`;
  const first = fitting(
    FIRST_MAX,
    [opening, `${W} sealed its plan, waited out the window, drained the vault with its own key, and the contract paid it a ${s.paid} NEAR bounty on top.`, `This is MASK WARS. ${s.where}, step by step:`].join("\n\n"),
    [opening, `${W} sealed its plan, drained the vault with its own key, and the contract paid it ${s.paid} NEAR on top.`, `This is MASK WARS. ${s.where}:`].join("\n\n"),
  );

  // The seal is on chain; the break of the copy is said only when the record carries the sandbox board.
  const board = [...new Set((r.sandbox?.board ?? []).map((b) => b.mask))];
  const sealStep = (extra: boolean): string =>
    (s.breach ? `${W} broke a private copy of the vault on its ${s.breach.tryWords} and sealed its plan on chain ${s.sealed.words} in` : `${W} sealed its plan on chain ${s.sealed.words} in`) +
    (extra && s.seals > 1 && s.sealPlace === 1 ? `, the first of ${s.seals} sealed plans` : "") +
    `. Only a hash, so nobody could copy it.`;
  const steps = (extra: boolean): string => {
    const lines = [
      // A season's vault holds what its treasury put in. A vault made by hand also pays for its own code out of what
      // went into it, so its round is told by the bounty alone.
      season ? `The season treasury opened a fresh vault: ${s.safe} NEAR inside, a ${s.bounty} NEAR bounty on top.` : `A vault opened with a ${s.bounty} NEAR bounty for the first mask to drain it.`,
      ...(board.length > 1 ? [`${listNames(board.map((name) => ({ name })))} attacked a private copy of it.`] : []),
      sealStep(extra),
      `The vault stayed locked until the ${s.sealMinutes} minute sealing window closed.`,
      `${s.played.words === "under a second" ? "At once" : `${s.played.words} later`} ${W} played the plan on the real vault with its own key: ${s.drained} NEAR out.`,
      `${W} revealed the plan, and a judge checked the drain against it.`,
      `The contract paid ${W} ${s.paid} NEAR.`,
    ];
    return [`How ${s.name} went:`, lines.map((line, i) => `${i + 1}. ${line}`).join("\n")].join("\n\n");
  };
  // Every transaction that moved the NEAR is linked, so the links add up to the number over them.
  const drain = s.drainLinks.length > 1 ? `The drain, ${s.drained} NEAR in ${s.drainLinks.length} transactions:` : `The drain, ${s.drained} NEAR:`;

  return [
    { text: first, media: { kind: "clip", file: CLIP_FILE, poster: cardFile("result") } },
    {
      text: [
        `MASK WARS is an arena where AI agents race to break smart contracts.`,
        `${season ? "A season treasury opens a fresh vault on a schedule," : "A vault opens"} with NEAR inside and a bounty on top. AI masks attack it. The first one in keeps what it drains, and once a judge confirms the drain, the contract pays it the bounty. No human approves the payout.`,
        `Every mask is an AI agent with its own NEAR account and its own keys.`,
      ].join("\n\n"),
      media: card("arena"),
    },
    { text: fitting(POST_MAX, steps(true), steps(false)), media: card("how") },
    {
      text: [
        `The money moved on chain. Check it yourself.`,
        ...(s.links.seal ? [`The sealed plan:\n${bare(s.links.seal)}`] : []),
        `${drain}\n${s.drainLinks.map(bare).join("\n")}`,
        `The payout, ${s.paid} NEAR${afterStorage}:\n${bare(s.links.payout)}`,
        `The judge runs in a secure enclave (TEE) on @out_layer and checked the drain in ${s.judge.seconds} s for ${s.judge.cost} NEAR.` +
          (s.winner.model ? ` ${W} thinks with ${s.winner.model}, privately on @near_ai Cloud.` : ""),
      ].join("\n\n"),
      media: card("numbers"),
    },
    {
      text: [
        `Try it yourself:`,
        `1. Run a sealed round on your machine, no keys and no wallet:\n${PUBLIC_REPO}\npnpm install && pnpm demo`,
        `2. Plug your agent into the arena:\nclaude mcp add --transport http maskwars https://${SITE}/mcp`,
        `3. Shipping a contract on NEAR? Let the masks try it first: ${SITE}/break`,
        `4. Watch the next round: ${SITE}`,
        `Built on @NEARProtocol at #NEARHackathon.${next}`,
      ].join("\n\n"),
      media: card("next"),
    },
  ];
}

/** A race opened by hand, told by its sandbox board. */
function racePosts(s: HandStory): Omit<ThreadPost, "n">[] {
  const r = s.record;
  const W = s.winner.name;
  const together = s.masks.length > 1 ? " at the same time" : "";
  const afterFees = toYocto(s.paid) < toYocto(s.bounty) ? ` (the ${s.bounty} NEAR bounty after fees)` : "";
  const next = r.next
    ? `\n\nRace ${Number(r.next.id.slice(5))} opens ${new Date(r.next.at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} with a ${near(r.next.bounty)} NEAR bounty.`
    : "";

  const posts: Omit<ThreadPost, "n">[] = [
    {
      text: [
        `An AI mask broke into a vault on ${s.chain} and walked out with ${s.drained} NEAR.`,
        `${W} found the hole on its ${s.breach.tryWords}, drained the vault with its own key, and the contract paid it a ${s.paid} NEAR bounty on top.`,
        `This is MASK WARS. Race ${s.no}, step by step:`,
      ].join("\n\n"),
      media: { kind: "clip", file: CLIP_FILE, poster: cardFile("result") },
    },
    {
      text: [
        `MASK WARS is an arena where AI agents race to break smart contracts.`,
        `A vault opens with NEAR inside and a bounty on top. AI masks attack it. The first one in keeps what it drains, and once a judge confirms the drain, the contract pays it the bounty. No human approves the payout.`,
        `Every mask is an AI agent with its own NEAR account and its own keys.`,
      ].join("\n\n"),
      media: card("arena"),
    },
    {
      text: [
        `How race ${s.no} went:`,
        [
          `1. The vault opened with a ${s.bounty} NEAR bounty and a ${s.hours} hour clock.`,
          `2. ${listNames(s.masks)} attacked a private copy of it${together}.`,
          `3. ${W} broke the copy on its ${s.breach.tryWords}, ${s.breach.words} in.`,
          `4. ${W} played the same plan on the real vault with its own key: ${s.drained} NEAR out.`,
          `5. A judge read the drain from the chain, and the contract paid ${W}.`,
        ].join("\n"),
      ].join("\n\n"),
      media: card("how"),
    },
    {
      text: [
        `The money moved on chain. Check it yourself.`,
        `The drain, ${s.drained} NEAR:\n${s.drainLinks.map(bare).join("\n")}`,
        `The payout, ${s.paid} NEAR${afterFees}:\n${bare(s.links.payout)}`,
        `The judge runs in a secure enclave (TEE) on @out_layer and checked the drain in ${s.judge.seconds} s for ${s.judge.cost} NEAR.` +
          (s.winner.model ? ` ${W} thinks with ${s.winner.model}, privately on @near_ai Cloud.` : ""),
      ].join("\n\n"),
      media: card("numbers"),
    },
    {
      text: [
        `Try it yourself:`,
        [
          `1. Shipping a contract on NEAR? Send it to ${SITE}/break and let the masks try it before anyone else does.`,
          ...(r.network === "testnet"
            ? [`2. Building an AI agent that pays contracts? Let it ask the arena first. Ask about the vault ${W} drained and the answer is BLOCK, with the reason:\n${SITE}/api/check?account=${r.target.account}`]
            : []),
          `${r.network === "testnet" ? 3 : 2}. Follow the next race at ${SITE}`,
        ].join("\n"),
        `Built on @NEARProtocol at #NEARHackathon.${next}`,
      ].join("\n\n"),
      media: card("next"),
    },
  ];
  return posts;
}

/** Everything that keeps a thread from going out, each with its post number. Empty means it may go. */
export function lintThread(posts: readonly ThreadPost[]): string[] {
  const out: string[] = [];
  if (posts.length < THREAD_MIN || posts.length > THREAD_MAX) out.push(`a thread is ${THREAD_MIN} to ${THREAD_MAX} posts, this one is ${posts.length}`);
  for (const p of posts) {
    const first = p.n === 1;
    const problems = lintPost(p.text, { role: first ? "post" : "thread", max: first ? FIRST_MAX : POST_MAX, handles: THREAD_TAGS });
    for (const why of problems) out.push(`${p.n}/ ${why}`);
  }
  const files = posts.map((p) => p.media.file);
  if (new Set(files).size !== files.length) out.push("every post has its own picture");
  if (posts[0]?.media.kind !== "clip") out.push("1/ the first post carries the clip");
  return out;
}

/**
 * The draft a person posts from, in English: which picture goes with which post, the posts in boxes, and a link for
 * every number. Nothing is posted by the package.
 */
export function threadMarkdown(s: RaceStory, posts: readonly ThreadPost[], extra: { clipSeconds?: number; noClip?: boolean } = {}): string {
  const r = s.record;
  const lines: string[] = [`# X thread: ${s.heading}, ${s.winner.name}`, ""];
  if (s.simulated) lines.push("**SIMULATED: the numbers are made up. Do not post.**", "");
  lines.push(
    "| Post | Media | X characters |",
    "| --- | --- | --- |",
    ...posts.map((p) => {
      const clip = extra.noClip ? " (not rendered: run without `--no-clip`)" : extra.clipSeconds ? `, ${extra.clipSeconds.toFixed(0)} s` : "";
      return `| ${p.n}/ | \`${p.media.file}\`${p.media.kind === "clip" ? `${clip}; cover \`${p.media.poster}\`` : ""} | ${xLength(p.text)} |`;
    }),
    "",
  );
  for (const p of posts) {
    lines.push(`**${p.n}/** ${p.media.kind === "clip" ? `Video \`${p.media.file}\`` : `Card \`${p.media.file}\``}`, "", "```text", p.text, "```", "");
  }
  lines.push("## Where the numbers come from", "", `Record: \`races/${r.id}.json\`, ${s.chain}.`, "");
  if (s.kind === "round") {
    lines.push(
      s.opener === "season"
        ? `- The treasury opened the round, ${s.safe} NEAR in the vault, ${s.bounty} NEAR bounty: ${s.links.open}`
        : `- The round opened with a ${s.bounty} NEAR bounty: ${s.links.open}`,
      `- ${s.winner.name} sealed its plan ${s.sealed.words} in${s.links.seal ? `: ${s.links.seal}` : " (the indexer did not show its commit transaction)"}`,
      `- The drain, ${s.drained} NEAR, ${s.played.words} after the window closed: ${s.drainLinks.join(" and ")}`,
      `- The reveal: ${s.links.reveal}`,
      `- The claim: ${s.links.claim}`,
      `- The payout, ${s.paid} NEAR: ${s.links.payout}`,
      ...(s.links.run ? [`- The race on the copy: ${s.links.run}`] : []),
    );
  } else {
    lines.push(`- The drain, ${s.drained} NEAR: ${s.drainLinks.join(" and ")}`, `- The payout, ${s.paid} NEAR: ${s.links.payout}`, `- The race in the sandbox: ${s.links.run}`);
  }
  lines.push(`- The judge: OutLayer request ${r.judge.request}, ${s.judge.seconds} s, ${s.judge.cost} NEAR`, ...r.sources.map((x) => `- ${x}`), "");
  return lines.join("\n");
}
