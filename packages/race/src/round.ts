/**
 * Simulation mode: one sealed round (RULES.md) with scripted masks and no model calls. `race-runner round` plays it in
 * a fresh local sandbox with the real bounty contract, the real live safe and the real judge; this reads its board.
 *
 * The standard scenario: ONYX seals a guess first, JINX tries to empty the safe in the commit window (the safe is
 * locked to the round and refuses) and leaves a junk claim with the judge, NOVA finds the hole and seals it, ORACLE
 * copies NOVA's plan off the chain, VOLT finds the hole only after the window. NOVA wins; nobody who peeked does, and
 * the saboteur stops nobody. A squatter, which moves the safe first after the window, has its one turn and spoils no
 * plan either.
 */
import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CHALLENGES_DIR } from "./challenge.ts";
import { RUNNER_BIN } from "./sandbox.ts";

export const Play = z.enum(["finder", "gambler", "peeker", "late", "saboteur", "squatter"]);
export type Play = z.infer<typeof Play>;

export interface Scenario {
  readonly masks: readonly { readonly name: string; readonly play: Play }[];
  readonly safe_near: number;
  readonly sweep_near: number;
  readonly min_loot_near: number;
  readonly bounty_near: number;
  readonly commit_minutes: number;
  /** Minutes after the commit window to play and reveal; 60 when absent. */
  readonly reveal_minutes?: number;
  readonly hours: number;
  /** The kind of the round's vault (live-safe's `variant`): `owner` when absent, else `limit` or `pause`. */
  readonly variant?: string;
}

export const RoundEvent = z.object({ mask: z.string(), step: z.string(), ok: z.boolean(), note: z.string() });
export type RoundEvent = z.infer<typeof RoundEvent>;

export const Board = z.object({
  bounty: z.string(),
  events: z.array(RoundEvent),
  status: z.unknown(),
  round: z.unknown(),
  winner: z.string().nullable(),
  prize: z.string(),
});
export type Board = z.infer<typeof Board>;

export interface SimulateOptions {
  readonly bin?: string;
  /** The standard scenario when absent. */
  readonly scenario?: Scenario;
  /** The round's vault is of this kind (`race-runner round --variant`); a scenario's own `variant` when absent. */
  readonly variant?: string;
  readonly signal?: AbortSignal;
}

/** Plays one round in the sandbox and returns its board. Needs the runner built (`build:runner`). */
export async function simulateRound(o: SimulateOptions = {}): Promise<Board> {
  const dir = o.scenario ? await mkdtemp(join(tmpdir(), "maskwars-round-")) : null;
  try {
    const args = ["round"];
    if (dir && o.scenario) {
      const file = join(dir, "scenario.json");
      await writeFile(file, JSON.stringify(o.scenario));
      args.push(file);
    }
    if (o.variant) args.push("--variant", o.variant);
    const out = await run(o.bin ?? RUNNER_BIN, args, o.signal);
    const line = out.split("\n").find((l) => l.startsWith("ROUND_BOARD "));
    if (!line) throw new Error(`the runner printed no board:\n${out.slice(-2000)}`);
    return Board.parse(JSON.parse(line.slice("ROUND_BOARD ".length)));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

function run(bin: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: CHALLENGES_DIR, stdio: ["ignore", "pipe", "pipe"], signal });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`race-runner round exited ${code}: ${stderr.slice(-2000)}`))));
  });
}

const STEP: Record<string, string> = {
  open: "opens",
  seal: "seals",
  window: "",
  "play set_owner": "set_owner",
  "play sweep": "sweep",
  reveal: "reveals",
  asked: "asks",
  claim: "claims",
  paid: "PAID",
};

/** The round as a board for the screen: who sealed, who played, who was refused and why, who got paid. */
export function formatRound(board: Board): string[] {
  // A call of a plan goes by its own name, whatever the vault's kind: `play cash_out` is `cash_out`.
  const label = (step: string) => STEP[step] ?? step.replace(/^play /, "");
  // The column is as wide as it always was, and wider only for a kind whose calls have longer names.
  const width = Math.max(10, ...board.events.map((e) => label(e.step).length));
  return board.events.map((e) => {
    if (e.step === "window") return "—— the commit window closes ——";
    const who = (e.mask || "").toUpperCase().padEnd(7);
    const what = label(e.step).padEnd(width);
    const mark = e.ok ? "✓" : "×";
    const note = e.step.startsWith("play ") && e.ok ? "" : ` ${e.note}`;
    return `${who} ${what} ${mark}${note}`;
  });
}
