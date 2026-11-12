// The oracle: one question per race, the answer the chain settled it with, and the transaction that proves it. A
// partner's market ("will this contract hold?") settles on these answers; MASK WARS keeps no book of its own. Every
// answer is code over the dossier's own reading of the chain: no model is involved.

import { txUrl } from "@maskwars/arena";

/** The bounty contract's own final states. */
const SETTLED: ReadonlySet<string> = new Set(["paid", "drained", "refunded"]);
import type { Dossier, JudgeResult } from "./types.ts";

/** One race, as a market settles on it. */
export interface Outcome {
  readonly race: string;
  /** The bounty contract that ran the race and paid or refunded it. */
  readonly contract: string;
  /** The question, in words, exactly as `answer` answers it. */
  readonly question: string;
  /**
   * `yes`: the judge in a TEE confirmed a break and the contract paid it; `no`: the contract settled the race with no
   * confirmed break (the bounty went back); `null`: not settled yet (`final: false`).
   */
  readonly answer: "yes" | "no" | null;
  /**
   * The bounty contract settled the race (`paid`, `drained` or `refunded`): read from the contract's own state alone,
   * so `final` and `answer` never change once true.
   */
  readonly final: boolean;
  /**
   * The judge's word in more detail: `held` or `called_off` for a bounty that went back at or before the deadline (a
   * market may void a called-off race), `unconfirmed` for a drain the judge did not confirm. Which of `held` and
   * `called_off` it was rests on the refund's own time; while that history cannot be read it says `pending`.
   */
  readonly verdict: JudgeResult["verdict"];
  /** A mask took NEAR out of the safe on chain, whatever the judge said: the safe did not hold. */
  readonly drainedOnChain: boolean;
  readonly winner: string | null;
  /** The proof: the transaction that settled the race, the judge's code in the TEE, and when. */
  readonly proof: {
    readonly tx: string | null;
    readonly url: string | null;
    readonly judgeCode: string | null;
    readonly at: string | null;
  };
}

/** Every race's outcome, newest first. A record that could not be read in full answers nothing. */
export function outcomesOf(d: Pick<Dossier, "account" | "outcomes" | "races" | "incomplete">): Outcome[] {
  if (d.incomplete) return [];
  return d.outcomes.map((o) => {
    const race = d.races.find((r) => r.id === o.race && r.contract === o.contract);
    const drained = race ? race.phase === "broken" || race.events.some((e) => e.kind === "drain") : o.verdict === "broken";
    const final = SETTLED.has(o.state);
    return {
      race: o.race,
      contract: o.contract,
      question: `Did the judge in a TEE confirm that a mask broke ${d.account} in ${o.race}?`,
      answer: !final ? null : o.verdict === "broken" ? "yes" : "no",
      final,
      verdict: o.verdict,
      drainedOnChain: drained,
      winner: o.verdict === "broken" ? o.winner : null,
      proof: { tx: o.tx, url: o.tx ? txUrl(o.tx) : null, judgeCode: o.judgeCode, at: o.at !== null ? new Date(o.at).toISOString() : null },
    };
  });
}
