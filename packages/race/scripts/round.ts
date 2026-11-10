/**
 * Simulation mode, no model calls: one sealed round with scripted masks in a local sandbox, real contracts and the
 * real judge. Prints the board and the winner.
 *
 *   pnpm --filter @maskwars/race round [scenario.json]
 *
 * Needs the runner built: `pnpm --filter @maskwars/race build:runner`.
 */
import { readFile } from "node:fs/promises";
import { formatRound, simulateRound, type Scenario } from "../src/round.ts";
import { RunnerSandbox } from "../src/sandbox.ts";

if (!(await new RunnerSandbox().available())) {
  console.error("runner not built: pnpm --filter @maskwars/race build:runner");
  process.exit(2);
}
const file = process.argv[2];
const scenario = file ? (JSON.parse(await readFile(file, "utf8")) as Scenario) : undefined;
const board = await simulateRound(scenario ? { scenario } : {});
console.log(formatRound(board).join("\n"));
console.log(board.winner ? `\n${board.winner.toUpperCase()} wins the round` : "\nnobody wins: the team takes its NEAR back");
