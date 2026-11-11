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

/**
 * The compositions: 16:9, nothing vertical exists here. `RaceClip` tells a race with captions and takes its length
 * from the race; `break` is the wordless clip, 15 s, cut on the beat of its music.
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
    </>
  );
}

registerRoot(Root);
