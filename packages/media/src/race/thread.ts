/**
 * The X thread of one race: 4 to 8 posts, each with its own picture. The first sells the fight and the money and
 * carries no link; then what MASK WARS is, how the race went step by step, the real numbers with links to the chain,
 * and how to try it. Every number comes from the story. Tags only for what really ran in the race.
 */

import { lintPost, xLength } from "../lint.ts";
import { near, toYocto } from "./near.ts";
import type { RaceStory } from "./story.ts";
import { listNames, SITE } from "./story.ts";

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

export function raceThread(s: RaceStory): ThreadPost[] {
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
        `The drain, ${s.drained} NEAR:\n${bare(s.links.drain)}`,
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
  return posts.map((p, i) => ({ n: i + 1, ...p }));
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

/** 1 пост, 3 пости, 5 постів. */
function posts_uk(n: number): string {
  const d = n % 10;
  const h = n % 100;
  return `${n} ${d === 1 && h !== 11 ? "пост" : d >= 2 && d <= 4 && (h < 12 || h > 14) ? "пости" : "постів"}`;
}

/** The draft the owner publishes from: Ukrainian around, English posts in boxes, the picture of each post named. */
export function threadMarkdown(s: RaceStory, posts: readonly ThreadPost[], extra: { clipSeconds?: number; noClip?: boolean } = {}): string {
  const r = s.record;
  const lines: string[] = [
    `# Гілка X: ${r.id}, ${s.winner.name}`,
    "",
    s.simulated
      ? "**SIMULATED: цифри вигадані, не публікувати.**"
      : `Цифри — із запису забігу \`races/${r.id}.json\` (${r.network}). Публікують руками: пакет нічого не постить.`,
    "",
    "Як публікувати: пост 1 з кліпом, кожен наступний — відповідь на попередній, до кожного його картинка з цієї теки.",
    `Пости довші за ${FIRST_MAX} знаків потребують X Premium.`,
    "",
    "| Пост | Медіа | Знаків X |",
    "| --- | --- | --- |",
    ...posts.map((p) => {
      const clip = extra.noClip ? " (ще не зібрано: запуск із `--no-clip`)" : extra.clipSeconds ? `, ${extra.clipSeconds.toFixed(0)} с` : "";
      return `| ${p.n}/ | \`${p.media.file}\`${p.media.kind === "clip" ? `${clip}; обкладинка \`${p.media.poster}\`` : ""} | ${xLength(p.text)} |`;
    }),
    "",
  ];
  for (const p of posts) {
    lines.push(`**${p.n}/** ${p.media.kind === "clip" ? `Відео \`${p.media.file}\`` : `Картка \`${p.media.file}\``}`, "", "```text", p.text, "```", "");
  }
  lines.push(
    "## Звідки цифри",
    "",
    `- Злив, ${s.drained} NEAR: ${s.links.drain}`,
    `- Виплата, ${s.paid} NEAR: ${s.links.payout}`,
    `- Забіг у пісочниці: ${s.links.run}`,
    `- Суддя: запит OutLayer ${r.judge.request}, ${s.judge.seconds} с, ${s.judge.cost} NEAR`,
    ...r.sources.map((x) => `- ${x}`),
    "",
    `Позначки лише ці: ${THREAD_TAGS.join(", ")}. У гілці ${posts_uk(posts.length)}.`,
    "",
  );
  return lines.join("\n");
}
