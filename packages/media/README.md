# @maskwars/media

The media machine for X. One command takes a recorded race and produces a 16:9 clip, a card for every post and a thread
draft. Publishing is the only step left: the package never posts by itself.

```bash
pnpm --filter @maskwars/media race race-0003     # races/race-0003.json → out/race-0003/
```

The finished output for `race-0003` is in [`shots/race-0003/`](shots/race-0003/): the clip, five cards, frames and the
thread text.

| Output | File |
| --- | --- |
| Clip 1920×1080, H.264, 15–45 s (`race-0003` runs 36.5 s) | `clip.mp4` |
| A 1600×900 card for every post; `01-result` is the clip cover | `cards/01-result.png` … `cards/05-next.png` |
| X thread of 5 posts: texts, media for each, character counts, where the numbers come from | `thread.md` |
| Seven key frames of the clip and a contact sheet of them for visual review | `frames/*.jpg`, `clip-sheet.jpg` |

Flags: `--out <dir>`, `--music <file>`, `--silent`, `--no-clip` (cards and thread only, no ffmpeg). A path to any
record can be given in place of the id. A full run takes about 1.5 min, of which 1 min is the clip render.

## Input: the race record

Schema v1 is `src/race/record.ts` (zod); an example is `races/race-0003.json`. A record is assembled by hand from the
race's transactions and run log, and the `sources` field says where each number was read.

| Field | What it is |
| --- | --- |
| `source`, `network` | `LIVE`: every number happened on chain. `SIMULATED`: the numbers are made up, the clip and cards carry a label, and the thread must not be published |
| `bounty`, `hours` | The bounty as posted at opening, and how many hours the race lasted |
| `masks` | The masks of the race in order of entry: name, account, model |
| `sandbox` | The `Live race` run, its start and the public scoreboard: who, which attempt, when, breach or not |
| `winner`, `drain` | The winner and its transactions on the real safe; the last one moves the money |
| `judge`, `payout` | The OutLayer judge request, its time and cost; the contract payout and its transaction |

Amounts are exact decimal NEAR strings. Addition runs in yocto with `bigint`, so no number is rounded up.
Version 1 tells a race in which the safe is drained: a mask broke the copy in the sandbox, replayed the same plan on the
real safe with its own key, and the contract paid it. A record with any other ending fails validation, and the schema
names the reason.

## Clip

`src/clip/RaceClip.tsx` (Remotion); the timeline is `src/clip/race-plan.ts`. 16:9 only, there are no vertical
compositions.

| Scene | What the viewer sees |
| --- | --- |
| Result, frame 0 | `1 NEAR`, DRAINED BY NOVA, the bounty on top, the winner's mask. The first frame is already the result and the cover |
| Safe | The safe ring, the bounty amount, the network |
| Race | Masks on the mirrored arena floor, the sandbox clock runs to the breach; a hit, BREACH, the rest fade out |
| Breach | The ring's seam glows hot, the safe splits, `1 NEAR OUT OF THE VAULT` |
| Payout | A counter runs up to the exact payout, closing line `NOVA TAKES 1.08664 NEAR` |
| End | YOUR CONTRACT IS NEXT, maskwars.xyz; when the next race is already open, its number and amount |

- Subtitles are burned in: the X feed plays without sound. Each line stays on screen as long as it takes to read; a
  number and its unit are never split.
- Hits follow the brand book, §9: the scene goes 1→1.012 in 60 ms and springs back, the hit ring lasts 700 ms.
- Colors come from `@maskwars/brand`, the fonts are Hubot Sans for words and Mona Sans for numbers, the stills come from
  `brand/art/web`.
- **Music.** The clip takes a file from `apps/web/public/audio/` (first `clip`, `race`, `theme`, `arena`, `music`, then
  the first by name; mp3, m4a, aac, wav, ogg, opus) or from `--music`. The sound is trimmed to the clip, fades out over
  the last 1.5 s and is normalized to −14 LUFS. Without music the clip is built with no audio track.

## X thread

`src/race/thread.ts`: 4–8 posts, each with its own picture.

1. The fight and the money, up to 280 characters, no link, with the clip.
2. What MASK WARS is.
3. How the race went, step by step, with real numbers.
4. The numbers with links to the transactions; the judge in a TEE and the mask's model get one line, as a strength.
5. How to try it yourself: `/break`, MASK CHECK, where to watch the next race.

`lintThread` rejects a thread if: the first post has a link or is longer than 280; a post is longer than 600; there is
a tag outside the list (`@NEARProtocol`, `@near_ai`, `@out_layer`); the text has AI-style phrasing, a promise of
profit, an exclamation mark, an emoji, a hashtag other than `#NEARHackathon`, or a hash or account outside a link; two
posts share one picture.

## Cards 1600×900

`src/race/cards.ts`: `result` (the clip cover), `arena` (the masks of the race in the arena), `how` (four steps with
numbers), `numbers` (a scoreboard of four numbers), `next` (the next race or a call to action). Each page is
self-contained: fonts and stills are embedded, there is no network access, and a console error fails the render. Card
text starts at 36 px; fitting shrinks a long line down to 30 px and no further.

## Moments of people and masks

A separate part of the package for people and their masks: a new mask (a person's own), a win of ×3 or more, a loss
with a line, an unmask, a broken bank seal. Event v1 (zod) → a 1600×900 card and a draft in the queue
`pending → approved → posted | rejected` with Approve all, a stop switch, a daily cap, an hourly pace and
deduplication. The examples in `examples/` are marked `SIMULATED`.

| What | Where |
| --- | --- |
| Event, detector, texts | `src/event.ts`, `src/detector.ts`, `src/copy.ts` |
| Event cards | `src/cards/` · `pnpm --filter @maskwars/media shots` renders them into `shots/` |
| Queue and X port (`MEDIA_X=off` by default, `fake` for rehearsals) | `src/queue/`, SQL `migrations/0001_media_queue.sql` |
| Model port for alternative wording: numbers and handles must stay | `src/writer.ts` |

## Checks

```bash
pnpm --filter @maskwars/media typecheck
pnpm --filter @maskwars/media test       # record, story, thread, lint, clip plan, cards, music, queue
```

The clip frame render test runs only where the Remotion headless browser is available (`/opt/pw-browsers` or
`MEDIA_RENDER=1`).
