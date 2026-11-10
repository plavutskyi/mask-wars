// Builds what a host page loads from maskwars.xyz: the element as one script, and the brand's two faces beside it.
// Two names for the same script: `/hire/v1.js`, always the latest, and `/hire/v1.<hash>.js`, never changed once
// published, which a host pins with `integrity=` (release.json, read by /hire for the line it gives out). Earlier pinned
// files stay, so a host pinned to one keeps working. A test rebuilds all of it in memory and fails if anything drifts.
// Usage: pnpm --filter @maskwars/hire build
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bundle, fonts, OUT, RELEASE, release } from "./bundle.ts";

mkdirSync(OUT, { recursive: true });
const code = await bundle();
const r = release(code);
writeFileSync(new URL("v1.js", OUT), code);
writeFileSync(new URL(r.file, OUT), code);
writeFileSync(RELEASE, `${JSON.stringify(r, null, 2)}\n`);
for (const [name, bytes] of fonts()) writeFileSync(new URL(name, OUT), bytes);
console.log(`hire: wrote ${fileURLToPath(OUT)} (${r.file}, ${r.integrity})`);
