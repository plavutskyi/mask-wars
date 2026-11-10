// Забіг → кліп 16:9, картки 1600×900, чернетка гілки X. Подія людини чи маски → картка й чернетка в черзі. Нічого не публікує.
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
export { explorer, listNames, modelName, raceStory, secondsText } from "./race/story.ts";
export type { RaceStory, StoryMask } from "./race/story.ts";
export * from "./race/thread.ts";
export { countUp, planRaceClip, raceCaptions, raceClock, RACE_CLIP, readSeconds, SCENES } from "./clip/race-plan.ts";
export type { ClipCaption, RaceClipPlan, SceneId } from "./clip/race-plan.ts";
// Heavy, browser-bound: import directly when needed.
//   ./cards/render.ts, ./race/cards.ts (Playwright)   ./clip/render.ts (Remotion + ffmpeg)   ./race/make.ts (all of it)
