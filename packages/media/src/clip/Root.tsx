import { Composition, registerRoot } from "remotion";
import type { RaceRecord } from "../race/record.ts";
import { raceStory } from "../race/story.ts";
import { RaceClip } from "./RaceClip.tsx";
import type { RaceClipProps } from "./RaceClip.tsx";
import { planRaceClip, RACE_CLIP } from "./race-plan.ts";

/** The one composition: 16:9, nothing vertical exists here. Its length comes from the race it tells. */
function Root() {
  return (
    <Composition
      id="RaceClip"
      component={RaceClip}
      width={RACE_CLIP.width}
      height={RACE_CLIP.height}
      fps={RACE_CLIP.fps}
      durationInFrames={RACE_CLIP.minS * RACE_CLIP.fps}
      defaultProps={{ record: null as unknown as RaceRecord, music: null } satisfies RaceClipProps}
      calculateMetadata={({ props }) => ({ durationInFrames: planRaceClip(raceStory(props.record)).durationInFrames })}
    />
  );
}

registerRoot(Root);
