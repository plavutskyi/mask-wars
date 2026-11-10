/**
 * An attack plan is data: a typed list of calls and views from the attacker's account to the target. No code, no
 * other receivers, no contract deploys. The same shape is enforced again by the Rust runner (`deny_unknown_fields`),
 * so a plan that passes here is replayable there byte for byte.
 */
import { z } from "zod";

export const MAX_GAS_TGAS = 300;
const U128_MAX = (1n << 128n) - 1n;

const method = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_]+$/, "method names are letters, digits and _");
const args = z.record(z.string(), z.unknown());
const yocto = z
  .string()
  .regex(/^\d+$/, "yoctoNEAR as a decimal string")
  .refine((s) => !/^\d+$/.test(s) || BigInt(s) <= U128_MAX, "does not fit in u128");

export const CallStep = z.strictObject({
  kind: z.literal("call"),
  method,
  args: args.optional(),
  deposit: yocto.optional(),
  gas_tgas: z.number().int().min(1).max(MAX_GAS_TGAS).optional(),
});

export const ViewStep = z.strictObject({
  kind: z.literal("view"),
  method,
  args: args.optional(),
});

export const Step = z.discriminatedUnion("kind", [CallStep, ViewStep]);
export const Plan = z.strictObject({ steps: z.array(Step).min(1) });

export type Step = z.infer<typeof Step>;
export type Plan = z.infer<typeof Plan>;

export type PlanParse = { ok: true; plan: Plan } | { ok: false; error: string };

/**
 * Reads a plan out of a model's reply. Models wrap JSON in prose or fences; we take the first balanced `{…}` and
 * hold it to the schema. Anything else is an invalid attempt with a reason the model can act on.
 */
export function parsePlan(reply: string, maxSteps: number): PlanParse {
  const json = firstObject(reply);
  if (json === null) return { ok: false, error: "no JSON object in the reply" };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  const parsed = Plan.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `plan format: ${issue ? `${issue.path.join(".") || "plan"}: ${issue.message}` : "invalid"}` };
  }
  if (parsed.data.steps.length > maxSteps) {
    return { ok: false, error: `plan has ${parsed.data.steps.length} steps, limit is ${maxSteps}` };
  }
  return { ok: true, plan: parsed.data };
}

/** The first top-level `{…}` in `text`, respecting strings and escapes. */
export function firstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}
