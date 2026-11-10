/**
 * A MASK WARS race written as an Agent Market competition, for a person to post: the call spends the pool.
 *
 *   pnpm --filter @maskwars/market competition                                   # the targets
 *   pnpm --filter @maskwars/market competition open-admin --pool 50 --hours 72   # title, pool, deadline, brief
 *   pnpm --filter @maskwars/market competition open-admin --pool 50 --json       # the POST /v1/jobs/competition body
 *
 * `--badge none|verified|identity_verified` (default none): the least badge an entrant's builder must hold.
 * Exit code 2 on anything the marketplace would refuse.
 */
import { join } from "node:path";
import { CHALLENGES_DIR, listChallenges, loadChallenge } from "@maskwars/race";
import type { VerificationLevel } from "../src/api.ts";
import { competitionProblems, raceCompetition } from "../src/competition.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const id = argv.find((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--"));
const ids = await listChallenges();
if (!id) {
  console.log("usage: competition <target> --pool <USDC> [--hours 72] [--badge none] [--json]\n");
  for (const t of ids) {
    const c = await loadChallenge(join(CHALLENGES_DIR, t));
    const fit = competitionProblems(c, { pool: "1", hours: 72 });
    console.log(`${t.padEnd(16)} ${c.manifest.title}${fit.length > 0 ? `   (not for a competition: ${fit.join("; ")})` : ""}`);
  }
  process.exit(0);
}
if (!ids.includes(id)) {
  console.error(`no target ${id}; there are ${ids.join(", ")}`);
  process.exit(2);
}

const pool = flag("pool");
if (!pool) {
  console.error("--pool <USDC> is required: the whole prize pool, debited into escrow when the competition is posted");
  process.exit(2);
}
const badge = (flag("badge") ?? "none") as VerificationLevel;
if (!["none", "verified", "identity_verified"].includes(badge)) {
  console.error("--badge is none, verified or identity_verified");
  process.exit(2);
}

const challenge = await loadChallenge(join(CHALLENGES_DIR, id));
const options = { pool, hours: Number(flag("hours") ?? 72), minBuilderVerification: badge };
const problems = competitionProblems(challenge, options);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  process.exit(2);
}
const body = raceCompetition(challenge, options);

if (argv.includes("--json")) {
  console.log(JSON.stringify(body, null, 2));
} else {
  console.log(`Title       ${body.title}`);
  console.log(`Prize pool  ${body.poolAmount} USDC, locked in escrow when posted; the best works (score 80 and up) share it`);
  console.log(`Closes      ${body.entriesCloseAt} (${options.hours} h from now)`);
  console.log(`Badge       ${body.minBuilderVerification}`);
  console.log(`Tags        ${(body.tags ?? []).join(", ")}`);
  console.log("\n----- brief (Markdown) -----\n");
  console.log(body.description);
}
