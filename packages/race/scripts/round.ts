/**
 * Simulation mode, no model calls: one sealed round with scripted masks in a local sandbox, real contracts and the
 * real judge. Prints the board and the winner.
 *
 *   pnpm --filter @maskwars/race round [scenario.json] [--variant limit]
 *
 * `--variant <kind>` plays the round on a vault of another kind (`owner`, the default, `limit`, `pause`): the same
 * masks and scripts, that kind's planted hole.
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
const argv = process.argv.slice(2);
const at = argv.indexOf("--variant");
const variant = at >= 0 ? argv[at + 1] : undefined;
if (at >= 0 && !variant) {
  console.error("--variant needs a kind: owner, limit or pause");
  process.exit(2);
}
const file = argv.find((a, i) => a !== "--variant" && argv[i - 1] !== "--variant");
const scenario = file ? (JSON.parse(await readFile(file, "utf8")) as Scenario) : undefined;
const board = await simulateRound({ ...(scenario ? { scenario } : {}), ...(variant ? { variant } : {}) });
console.log(formatRound(board).join("\n"));
console.log(board.winner ? `\n${board.winner.toUpperCase()} wins the round` : "\nnobody wins: the team takes its NEAR back");
