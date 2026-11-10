// Draws every card of a moment (win, loss, unmask, new mask, broken seal) from examples/ into out/moments/, 1600×900.
// The examples are made up, so every card carries the SIMULATED band and none of them is kept in the repository.
// Every card page must render without a console error. Run: pnpm --filter @maskwars/media shots
// A whole race (clip, cards, thread) comes from `pnpm --filter @maskwars/media race <race-id>`.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromFightEvent } from "../src/detector.ts";
import { cardRenderer } from "../src/cards/render.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "out", "moments");
mkdirSync(out, { recursive: true });

const r = await cardRenderer();
let n = 0;
try {
  for (const f of readdirSync(join(root, "examples")).filter((f) => f.endsWith(".json")).sort()) {
    const jobs = fromFightEvent(JSON.parse(readFileSync(join(root, "examples", f), "utf8")));
    for (const job of jobs) {
      if (job.kind === "card") {
        const png = await r.render(job.card, job.event);
        writeFileSync(join(out, `card-${job.card}.png`), png);
        console.log(`card-${job.card}.png  ← ${f}`);
        n++;
      }
      if (job.kind === "draft") console.log(`  draft: ${job.draft.text.replace(/\n/g, " / ")}\n  reply: ${job.draft.reply}`);
    }
    if (jobs.length === 0) console.log(`(no card) ← ${f}: under ×3`);
  }
} finally {
  await r.close();
}
console.log(`${n} cards`);
