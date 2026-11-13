import { Composition, registerRoot } from "remotion";
import { Break } from "../break/Break.tsx";
import type { BreakProps } from "../break/props.ts";
import type { BreakPlan } from "../break/plan.ts";
import { BREAK } from "../break/plan.ts";
import type { RaceRecord } from "../race/record.ts";
import { raceStory } from "../race/story.ts";
import { RaceClip } from "./RaceClip.tsx";
import type { RaceClipProps } from "./RaceClip.tsx";
import { planRaceClip, RACE_CLIP } from "./race-plan.ts";
import { Promo } from "../promo/Promo.tsx";
import type { PromoProps } from "../promo/Promo.tsx";
import { DURATION, PROMO } from "../promo/plan.ts";
import { Demo } from "../demo/Demo.tsx";
import type { DemoProps } from "../demo/Demo.tsx";
import type { DemoData } from "../demo/plan.ts";
import { DEMO, DURATION as DEMO_DURATION } from "../demo/plan.ts";
import { Tour } from "../tour/Tour.tsx";
import type { TourProps } from "../tour/Tour.tsx";
import type { TourData } from "../tour/plan.ts";
import { DURATION as TOUR_DURATION, TOUR } from "../tour/plan.ts";

/**
 * The compositions: 16:9, nothing vertical exists here. `RaceClip` tells a race with captions and takes its length
 * from the race; `break` is the wordless clip, 15 s, cut on the beat of its music; `Promo` is the long film and
 * `Demo` the one-story film of a round, both cut on the bars of the same track; `Tour` is every page of the site
 * being used, chapter by chapter, on that track played whole.
 */
function Root() {
  return (
    <>
      <Composition
        id="RaceClip"
        component={RaceClip}
        width={RACE_CLIP.width}
        height={RACE_CLIP.height}
        fps={RACE_CLIP.fps}
        durationInFrames={RACE_CLIP.minS * RACE_CLIP.fps}
        defaultProps={{ record: null as unknown as RaceRecord, music: null } satisfies RaceClipProps}
        calculateMetadata={({ props }) => (props.record ? { durationInFrames: planRaceClip(raceStory(props.record)).durationInFrames } : {})}
      />
      <Composition
        id={BREAK.id}
        component={Break}
        width={BREAK.width}
        height={BREAK.height}
        fps={BREAK.fps}
        durationInFrames={BREAK.seconds * BREAK.fps}
        defaultProps={{ record: null as unknown as RaceRecord, plan: null as unknown as BreakPlan, sounds: null } satisfies BreakProps}
      />
      <Composition
        id={PROMO.id}
        component={Promo}
        width={PROMO.width}
        height={PROMO.height}
        fps={PROMO.fps}
        durationInFrames={DURATION}
        defaultProps={{ today: null as unknown as RaceRecord, first: null as unknown as RaceRecord, music: null } satisfies PromoProps}
      />
      <Composition
        id={DEMO.id}
        component={Demo}
        width={DEMO.width}
        height={DEMO.height}
        fps={DEMO.fps}
        durationInFrames={DEMO_DURATION}
        defaultProps={{ data: null as unknown as DemoData, music: null } satisfies DemoProps}
      />
      <Composition
        id={TOUR.id}
        component={Tour}
        width={TOUR.width}
        height={TOUR.height}
        fps={TOUR.fps}
        durationInFrames={TOUR_DURATION}
        defaultProps={{ data: null as unknown as TourData, music: null } satisfies TourProps}
      />
    </>
  );
}

registerRoot(Root);
