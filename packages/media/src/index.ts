// A race → a 16:9 clip, 1600×900 cards and a draft of the X thread. A moment of a person or a mask → a card and a draft in the queue. Nothing is published.
export * from "./event.ts";
export * from "./money.ts";
export * from "./masks.ts";
export * from "./lint.ts";
export * from "./copy.ts";
export * from "./detector.ts";
export * from "./writer.ts";
export * from "./queue/types.ts";
export * from "./queue/store.ts";
export * from "./queue/x.ts";
export * from "./queue/queue.ts";
export * from "./race/near.ts";
export * from "./race/record.ts";
export { dayOf, explorer, listNames, modelName, raceStory, secondsText, timeOf } from "./race/story.ts";
export type { Breach, HandStory, Lapse, RaceStory, RoundStory, StoryMask } from "./race/story.ts";
// A sealed round's record, read from the chain through the arena reader (`pnpm --filter @maskwars/media round`).
export { judgeRun, roundFromChain, standing } from "./race/chain.ts";
export type { JudgeRun, RoundChain } from "./race/chain.ts";
export * from "./race/thread.ts";
export { countUp, planRaceClip, raceCaptions, raceClock, RACE_CLIP, readSeconds, SCENES } from "./clip/race-plan.ts";
export type { Captions, ClipCaption, RaceClipPlan, SceneId } from "./clip/race-plan.ts";
// Heavy, browser-bound: import directly when needed.
//   ./cards/render.ts, ./race/cards.ts (Playwright)   ./clip/render.ts (Remotion + ffmpeg)   ./race/make.ts (all of it)
