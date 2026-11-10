/**
 * One race record in, everything for X out: the 16:9 clip, a card for every post, the thread draft, and the clip's
 * key frames with a contact sheet for eyes. Nothing is published. A thread that does not pass its checks stops the
 * run before anything is drawn.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, shootPage } from "../cards/render.ts";
import { contactSheet, findMusic, renderRaceClip } from "../clip/render.ts";
import { raceCardHtml, RACE_CARD } from "./cards.ts";
import { raceStory } from "./story.ts";
import { CLIP_FILE, lintThread, RACE_CARDS, raceThread, threadMarkdown } from "./thread.ts";

export type MakeOptions = {
  /** The folder everything goes to. */
  out: string;
  /** A music file; `undefined` takes what is in `apps/web/public/audio/`, `null` makes a silent clip. */
  music?: string | null;
  /** false: cards and thread only, no Remotion and no ffmpeg. */
  clip?: boolean;
};

export type MakeResult = {
  id: string;
  out: string;
  files: string[];
  clip: { seconds: number; audio: boolean; lufs: number | null; music: string | null } | null;
};

export async function makeRace(input: unknown, opts: MakeOptions): Promise<MakeResult> {
  const story = raceStory(input);
  const posts = raceThread(story);
  const problems = lintThread(posts);
  if (problems.length) throw new Error(`the thread of ${story.record.id} may not go out:\n${problems.join("\n")}`);

  const files: string[] = [];
  mkdirSync(join(opts.out, "cards"), { recursive: true });
  const browser = await launch();
  try {
    for (const kind of RACE_CARDS) {
      const png = await shootPage(browser, raceCardHtml(kind, story), { ...RACE_CARD, scale: 1 }, kind);
      const file = `cards/${String(RACE_CARDS.indexOf(kind) + 1).padStart(2, "0")}-${kind}.png`;
      writeFileSync(join(opts.out, file), png);
      files.push(file);
    }
  } finally {
    await browser.close();
  }

  let clip: MakeResult["clip"] = null;
  if (opts.clip !== false) {
    const music = opts.music === undefined ? findMusic() : opts.music;
    const r = await renderRaceClip(story.record, { video: join(opts.out, CLIP_FILE), frames: join(opts.out, "frames"), music });
    contactSheet(join(opts.out, "frames"), r.frames.map((f) => f.name), join(opts.out, "clip-sheet.jpg"));
    files.push(CLIP_FILE, ...r.frames.map((f) => `frames/${f.name}.jpg`), "clip-sheet.jpg");
    clip = { seconds: r.seconds, audio: r.audio, lufs: r.lufs, music };
  }

  writeFileSync(join(opts.out, "thread.md"), threadMarkdown(story, posts, clip ? { clipSeconds: clip.seconds } : { noClip: true }));
  files.push("thread.md");
  return { id: story.record.id, out: opts.out, files, clip };
}
