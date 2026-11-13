/**
 * The kind of a round's vault. A live vault is of one kind for good (`variant` at its `new`: `owner`, `limit`, `pause`;
 * contracts/challenges/live-safe), and each kind has another planted hole, so the masks must race the sandbox copy of
 * the very kind the round's vault is. The chain says which: the vault's own `variant` view. A vault from before kinds
 * (1.5.0, 1.6.0) has no such view and is of the `owner` kind, the only one there was.
 *
 * `roundVariant` reads it for a round on the bounty contract; the race takes the copy it names (scripts/race.ts), and a
 * kind named by hand that the chain contradicts stops the race before any model is asked.
 *
 * `withoutFailed` is for the play on chain (scripts/drain-live.ts), on a vault of another kind than `owner` only: a
 * winning plan may carry calls the sandbox refused (a model tries the plain way out first, then the hole). The sandbox
 * goes on after a refused call, the chain does not: there a mask's failed call ends its run, and the judge confirms
 * only a plan played whole. A call the sandbox refused changed nothing there, so the plan without it is the same
 * break. The `owner` kind plays as it always has.
 */
import { DEFAULT_VARIANT } from "./challenge.ts";
import { view, type Chain } from "./near-tx.ts";
import type { Outcome } from "./outcome.ts";
import type { Plan } from "./plan.ts";

const KIND = /^[a-z-]{1,32}$/;

/** The kind of the vault on chain; `owner` for a vault whose code has no `variant` view. Throws when the chain does not say. */
export async function vaultVariant(chain: Chain, vault: string): Promise<string> {
  let kind: unknown;
  try {
    kind = await view<unknown>(chain, vault, "variant");
  } catch (e) {
    if (/MethodNotFound/.test((e as Error).message)) return DEFAULT_VARIANT;
    throw e;
  }
  if (typeof kind !== "string" || !KIND.test(kind)) throw new Error(`${vault}.variant answered ${JSON.stringify(kind)}, not a kind`);
  return kind;
}

/**
 * The kind of the vault of round `bountyId` on `bountyContract`; `null` when that is no sealed round on a vault (a
 * practice race, a sandbox race's bounty). Throws when the chain does not answer.
 */
export async function roundVariant(chain: Chain, bountyContract: string, bountyId: string): Promise<string | null> {
  const race = await view<{ safe?: unknown } | null>(chain, bountyContract, "get_safe", { id: bountyId });
  if (!race || typeof race.safe !== "string") return null;
  return vaultVariant(chain, race.safe);
}

/**
 * `plan` without the calls the sandbox refused in `replay`, the clean second run the race counts a break by. Views
 * stay (the play drops them anyway). A replay that is missing or is of another plan changes nothing.
 */
export function withoutFailed(plan: Plan, replay: Pick<Outcome, "steps"> | null | undefined): Plan {
  const reports = replay?.steps;
  if (!Array.isArray(reports) || reports.length !== plan.steps.length) return plan;
  if (!plan.steps.every((s, i) => reports[i]?.index === i && reports[i]?.method === s.method)) return plan;
  const steps = plan.steps.filter((s, i) => s.kind === "view" || reports[i]?.ok === true);
  // Nothing was refused, or every call was: then no plan is left in the rest, and the plan stays as it is.
  return steps.length === plan.steps.length || !steps.some((s) => s.kind === "call") ? plan : { steps };
}
