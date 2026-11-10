/**
 * The arena on testnet right now, read with no keys: every race, its course and the league.
 *
 *   pnpm --filter @maskwars/arena live [--json]
 *
 * Exits 1 if the first paid drain on the arena does not read as it happened (race-0003: NOVA drained safe-0001 and the
 * contract paid it), 4 if neither RPC nor the indexer answered.
 */
import { Arena, duration, near, raceNo } from "../src/index.ts";

const arena = new Arena();
let view;
try {
  view = await arena.view();
} catch (error) {
  console.error(`the chain did not answer: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(4);
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(view, null, 2));
} else {
  const now = view.now;
  console.log(now ? `NOW  race ${raceNo(now.id)} · ${now.phase}${now.live ? " · LIVE" : ""} · ${near(now.prize)} NEAR\n` : "NOW  no race yet\n");
  for (const r of view.races) {
    const result = r.winner ? `${r.winner.name} took ${near(r.takes)} NEAR${r.breakMs !== null ? ` · broke it in ${duration(r.breakMs)}` : ""}` : r.phase;
    console.log(`${r.id}  ${r.target}  ${result}`);
    for (const e of r.events) {
      const t = new Date(e.at).toISOString().slice(5, 19).replace("T", " ");
      const what = [e.kind, e.method, e.verdict, e.amount ? `${near(e.amount)} NEAR` : null].filter(Boolean).join(" ");
      console.log(`   ${t}  ${(e.who?.name ?? "").padEnd(20)} ${what}`);
    }
  }
  console.log("\nLEAGUE");
  for (const m of view.league) {
    console.log(`  ${m.who.name.padEnd(8)} ${String(m.breaks).padStart(2)} breaks  ${near(m.earned).padStart(8)} NEAR  fastest ${duration(m.fastestMs)}`);
  }
}

const first = view.races.find((r) => r.id === "race-0003" && r.contract === "tinygif8324.testnet");
const ok = first?.state === "drained" && first.winner?.account === "nova.tinygif8324.testnet" && first.loot !== null && BigInt(first.loot) > 0n && first.payout !== null;
if (!ok) {
  console.error("race-0003 does not read as NOVA's paid drain");
  process.exit(1);
}
