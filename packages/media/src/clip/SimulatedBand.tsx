/**
 * The mark of a clip drawn from made-up numbers, on every frame: a solid band across the whole picture through its
 * centre, and the word tiled over everything else. It is not a stamp in a corner: no crop of a frame is left without
 * it, so a made-up result cannot pass for a real one. The cards carry the same mark (`cards/html.ts`).
 */

import { color } from "@maskwars/brand";
import type { CSSProperties } from "react";

/** What the band says: the same words as on the cards. */
export const SIMULATED_BAND = "SIMULATED · NOT A REAL RESULT";

const ROWS = 9;
const WORDS = 7;

export function SimulatedBand({ width }: { width: number }) {
  const px = (n: number): number => Math.round((n * width) / 1600);
  const word: CSSProperties = { fontFamily: "'Hubot Sans', system-ui, sans-serif", fontWeight: 800, fontStretch: "125%", lineHeight: 1, whiteSpace: "nowrap" };
  return (
    <div data-simulated="" style={{ position: "absolute", inset: 0, overflow: "hidden", zIndex: 99 }}>
      <div
        style={{
          position: "absolute",
          left: "-25%",
          top: "-45%",
          width: "150%",
          height: "190%",
          transform: "rotate(-14deg)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          ...word,
          fontSize: px(64),
          letterSpacing: "0.06em",
          color: "rgba(255,178,63,.16)",
        }}
      >
        {Array.from({ length: ROWS }, (_, i) => (
          <div key={i} style={{ marginLeft: i % 2 ? px(-240) : 0 }}>
            {Array.from({ length: WORDS }, () => "SIMULATED").join("\u00a0\u00a0\u00a0\u00a0")}
          </div>
        ))}
      </div>
      <div
        style={{
          position: "absolute",
          left: "-10%",
          top: "50%",
          width: "120%",
          height: px(140),
          marginTop: px(-70),
          transform: "rotate(-14deg)",
          background: color.amber,
          color: color.ink,
          boxShadow: `0 0 0 ${px(8)}px ${color.ink}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          ...word,
          fontSize: px(64),
          letterSpacing: "0.04em",
        }}
      >
        {SIMULATED_BAND}
      </div>
    </div>
  );
}
