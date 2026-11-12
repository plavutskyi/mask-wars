/**
 * Models a mask may think with on NEAR AI Cloud: Confidential TEE only, canonical IDs only (an alias changes who signs
 * the response). Confidential TEE is NEAR AI's own GPU fleet inside TEEs, with attestation; `/v1/models` lists it as
 * `owned_by: "nearai"`. "3P Confidential TEE" (`attested 3p`) runs in another provider's enclave, and Incognito models
 * (OpenAI, Anthropic, Gemini and others) run outside any TEE: neither belongs here.
 *
 * Checked live 8.11.2026: all three are `nearai`, the prices below (USD per 1M tokens) match `/v1/models`, and each
 * passes every check in attestation.ts, GPUs included.
 */
export const NEAR_AI_BASE_URL = "https://cloud-api.near.ai/v1";

/**
 * The models a person's mask may pick: the forge offers them (packages/forge, contracts/masks/catalog.json) and the
 * mind module on OutLayer carries them (services/brain/mind.json), so a change here changes that module's fingerprint.
 */
export const TEE_MODELS = {
  "z-ai/glm-5.3-flash": { input: 0.08, output: 0.5, cached: 0.012 },
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": { input: 0.3, output: 1.2, cached: 0.006 },
  "Qwen/Qwen3.8-27B": { input: 0.04, output: 1.35, cached: 0.018 },
} as const;

/**
 * NEAR AI's red-teaming builds ("abliterated": the refusals removed, for security research), for the arena's own masks.
 * `Qwen/Qwen3.8-27B-abliterated` was checked on 11.11.2026 as the others:
 * `nearai`, `attestationSupported`, the same price as its base, every check in attestation.ts passing on its own node
 * (8 × H100), its answers signed by that node, and the live safe's winning plan written with no refusal.
 */
export const RED_TEAM_MODELS = {
  "Qwen/Qwen3.8-27B-abliterated": { input: 0.04, output: 1.35, cached: 0.018 },
} as const;

export type TeeModel = keyof typeof TEE_MODELS | keyof typeof RED_TEAM_MODELS;

const PRICES: Readonly<Record<TeeModel, { readonly input: number; readonly output: number; readonly cached: number }>> = { ...TEE_MODELS, ...RED_TEAM_MODELS };

/** Every model a mask of the arena thinks with, a person's or the arena's own: what the site's attestation check covers. */
export const ATTESTED_MODELS = Object.keys(PRICES) as readonly TeeModel[];

export function isTeeModel(value: unknown): value is TeeModel {
  return typeof value === "string" && Object.hasOwn(PRICES, value);
}

/**
 * The model each of the arena's own masks thinks with in a race (packages/race/scripts/race.ts), by its name on the
 * board. ORACLE thinks with the abliterated Qwen since 11.11.2026: NEAR AI's red-teaming build of the base it had, at
 * the same price. The arena's pages name the same models (packages/arena, `MODELS`; a test of packages/race holds the
 * two tables together).
 */
export const ARENA_MODELS = {
  ONYX: "z-ai/glm-5.3-flash",
  NOVA: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
  ORACLE: "Qwen/Qwen3.8-27B-abliterated",
} as const satisfies Readonly<Record<string, TeeModel>>;

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
}

/** Cost of one call in USD. Unknown models cost 0 here; their provider reports its own cost. */
export function costUsd(model: string, usage: Usage): number {
  if (!isTeeModel(model)) return 0;
  const p = PRICES[model];
  const fresh = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (fresh * p.input + usage.cachedTokens * p.cached + usage.completionTokens * p.output) / 1_000_000;
}
