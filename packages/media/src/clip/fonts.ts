/**
 * The brand's two faces for a Remotion composition: Hubot Sans for words, Mona Sans for numbers. Importing this file
 * makes the render wait for both before the first frame; the files come from the render's public dir.
 */

import { continueRender, delayRender, staticFile } from "remotion";

export const FONT = { word: "'Hubot Sans', system-ui, sans-serif", num: "'Mona Sans', system-ui, sans-serif" } as const;

if (typeof document !== "undefined") {
  const handle = delayRender("fonts");
  Promise.all(
    [
      ["Hubot Sans", "fonts/hubot-sans.woff2"],
      ["Mona Sans", "fonts/mona-sans.woff2"],
    ].map(([family, file]) => {
      const f = new FontFace(family!, `url(${staticFile(file!)})`, { weight: "200 900", stretch: "75% 125%" });
      (document.fonts as unknown as Set<FontFace>).add(f);
      return f.load();
    }),
  ).then(() => continueRender(handle));
}
