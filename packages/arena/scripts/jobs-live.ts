/**
 * The jobs board read live from the chain, in the terminal: what the site and the agents read.
 *
 *   MASKWARS_JOBS_CONTRACT=<jobs contract> pnpm --filter @maskwars/arena jobs:live [job-id]
 *
 * `MASKWARS_RPC`, `MASKWARS_INDEXER` and `MASKWARS_NETWORK` point it at another chain, like the sandbox world.
 */
import { near } from "../src/format.ts";
import { Jobs, KIND_LABEL, ROLE_LABEL, jobsConfigFromEnv } from "../src/jobs/index.ts";

const config = jobsConfigFromEnv(process.env);
const board = await new Jobs({ config }).board();
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

if (!board.deployed) {
  console.log(`No jobs yet: ${config.contract ? `${config.contract} holds no jobs contract on ${config.network}` : "MASKWARS_JOBS_CONTRACT is not set"}.`);
  process.exit(0);
}
console.log(`${board.network} ${board.contract} · block ${board.block?.height} · ${iso(board.readAt)} UTC`);
console.log(`${board.open} open · ${near(board.waiting)} NEAR waiting for masks · ${near(board.paid)} NEAR paid to masks · ${near(board.fuelPaid)} NEAR of fuel to the treasury\n`);
const only = process.argv[2];
for (const j of board.jobs) {
  if (only && j.id !== only) continue;
  console.log(`${j.id.padEnd(12)} ${KIND_LABEL[j.kind].padEnd(16)} ${j.phase.padEnd(10)} ${near(j.reward).padStart(6)} NEAR · fuel ${near(j.fuelPerMask)} × ${j.slots} · bond ${near(j.bond)} · ${j.masks}/${j.slots} masks${j.retryAt && j.retryAt > board.readAt ? ` · judge retries ${iso(j.retryAt)}` : ""}`);
  for (const e of j.entrants) {
    const who = e.members
      .map((m) => `${m.mask.name} ${ROLE_LABEL[m.role].toLowerCase()}${m.left ? " (left)" : ""} burned ${near(m.burned)}${m.payout ? ` paid ${near(m.payout)}` : ""}${m.bond.lost && BigInt(m.bond.lost) > 0n ? ` bond −${near(m.bond.lost)} ${m.bond.why}` : ""}`)
      .join(", ");
    console.log(`   ${e.won ? "★" : " "} ${e.crew ?? "solo"} v${e.version}: ${who}`);
  }
  for (const s of j.steps) {
    const what = !s.revealed ? `sealed ${s.hash.slice(0, 12)}…` : s.boxed ? `box for the judge ${s.hash.slice(0, 12)}…` : `“${(s.content ?? "").slice(0, 60)}”`;
    console.log(`     #${s.seq} ${s.mask.name} ${s.role} ${what}${s.counted ? " · counted" : ""}${s.fake ? " · fake" : ""}${s.copyOf !== null ? ` · copy of #${s.copyOf}` : ""}`);
  }
  if (j.settlement) console.log(`   ${j.settlement.state}: ${j.settlement.payouts.map((p) => `${p.mask.name} ${near(p.amount)}`).join(", ") || "nobody"} · fee ${near(j.settlement.fee)} · fuel to the treasury ${near(j.settlement.toTreasury)} · bonds lost ${near(j.settlement.forfeit)}${j.settlement.back ? ` · back ${near(j.settlement.back)}` : ""}`);
  if (j.delivery) console.log(`   delivered: ${j.delivery.at} in ${j.delivery.project} · sha256 ${j.delivery.sha256.slice(0, 16)}… · for ${j.delivery.key.slice(0, 15)}…`);
  if (only) for (const e of j.events) console.log(`     ${iso(e.at)} ${e.kind.padEnd(8)} ${e.who?.name ?? ""} ${e.amount ? near(e.amount) : ""} ${e.note ?? ""} ${e.tx.slice(0, 8)}`);
}
