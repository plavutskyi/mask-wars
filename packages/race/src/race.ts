/**
 * A race: several agents on one target at once, each attempt in its own clean sandbox. The first breach that
 * reproduces in a second clean sandbox wins; everyone else is stopped and their running sandboxes are killed.
 */
import type { AttemptMemory, Attacker } from "./agent.ts";
import type { Challenge } from "./challenge.ts";
import type { JournalEntry } from "./journal.ts";
import { localOutcome, type Outcome } from "./outcome.ts";
import type { Plan } from "./plan.ts";
import type { Sandbox } from "./sandbox.ts";

export interface RaceOptions {
  readonly challenge: Challenge;
  readonly attackers: readonly Attacker[];
  readonly sandbox: Sandbox;
  /** Attempts per agent. */
  readonly maxAttempts: number;
  /** Called for every public journal entry as it happens (the screen). */
  readonly onEntry?: (entry: JournalEntry) => void;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

/** What only the code owner sees: the plan that broke the vault and both sandbox runs. */
export interface Finding {
  readonly attacker: string;
  readonly attempt: number;
  readonly plan: Plan;
  readonly outcome: Outcome;
  readonly replay: Outcome;
}

export interface RaceResult {
  readonly winner: { readonly attacker: string; readonly attempt: number; readonly atMs: number; readonly stolen: string } | null;
  /** Public: safe to put on screen. */
  readonly journal: readonly JournalEntry[];
  /** Private: for the team only. */
  readonly finding: Finding | null;
  readonly elapsedMs: number;
}

export async function runRace(options: RaceOptions): Promise<RaceResult> {
  const { challenge, sandbox, maxAttempts } = options;
  if (options.attackers.length === 0) throw new Error("a race needs at least one attacker");
  if (new Set(options.attackers.map((a) => a.id)).size !== options.attackers.length) throw new Error("attacker ids must be unique");

  const now = options.now ?? Date.now;
  const started = now();
  const stop = new AbortController();
  const onOuterAbort = () => stop.abort();
  options.signal?.addEventListener("abort", onOuterAbort, { once: true });

  const journal: JournalEntry[] = [];
  let finding: Finding | null = null;
  let winnerAt = 0;

  const record = (attacker: string, attempt: number, verdict: Outcome["verdict"]) => {
    const entry = { attacker, attempt, verdict, atMs: now() - started };
    journal.push(entry);
    options.onEntry?.(entry);
    return entry;
  };

  const runAgent = async (agent: Attacker) => {
    const history: AttemptMemory[] = [];
    for (let attempt = 1; attempt <= maxAttempts && !stop.signal.aborted; attempt++) {
      const proposal = await agent.propose(challenge, history);
      if (stop.signal.aborted) return;
      if (!proposal.ok) {
        history.push({ attempt, plan: null, outcome: localOutcome(challenge.manifest.id, "invalid", proposal.error) });
        record(agent.id, attempt, "invalid");
        continue;
      }
      const outcome = await sandbox.attempt(challenge, proposal.plan, stop.signal);
      if (stop.signal.aborted) return;
      history.push({ attempt, plan: proposal.plan, outcome });
      if (outcome.verdict !== "breach") {
        record(agent.id, attempt, outcome.verdict);
        continue;
      }
      // A breach counts only if the same plan breaks a second, clean world the same way.
      const replay = await sandbox.attempt(challenge, proposal.plan, stop.signal);
      if (stop.signal.aborted) return;
      if (replay.verdict !== "breach") {
        record(agent.id, attempt, "held");
        continue;
      }
      const entry = record(agent.id, attempt, "breach");
      finding = { attacker: agent.id, attempt, plan: proposal.plan, outcome, replay };
      winnerAt = entry.atMs;
      stop.abort();
      return;
    }
  };

  // Settle as soon as there is a winner: a loser still waiting on its model has nothing left to add.
  const won = new Promise<void>((resolve) => stop.signal.addEventListener("abort", () => resolve(), { once: true }));
  try {
    await Promise.race([Promise.all(options.attackers.map(runAgent)), won]);
  } finally {
    options.signal?.removeEventListener("abort", onOuterAbort);
  }

  const f = finding as Finding | null;
  return {
    winner: f ? { attacker: f.attacker, attempt: f.attempt, atMs: winnerAt, stolen: f.replay.stolen } : null,
    journal: [...journal],
    finding: f,
    elapsedMs: now() - started,
  };
}
