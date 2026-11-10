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

export const TEE_MODELS = {
  "z-ai/glm-5.3-flash": { input: 0.08, output: 0.5, cached: 0.012 },
  "deepseek-ai/DeepSeek-V4.1-Flash-1017": { input: 0.3, output: 1.2, cached: 0.006 },
  "Qwen/Qwen3.8-27B": { input: 0.04, output: 1.35, cached: 0.018 },
} as const;

export type TeeModel = keyof typeof TEE_MODELS;

export function isTeeModel(value: unknown): value is TeeModel {
  return typeof value === "string" && Object.hasOwn(TEE_MODELS, value);
}

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedTokens: number;
}

/** Cost of one call in USD. Unknown models cost 0 here; their provider reports its own cost. */
export function costUsd(model: string, usage: Usage): number {
  if (!isTeeModel(model)) return 0;
  const p = TEE_MODELS[model];
  const fresh = Math.max(0, usage.promptTokens - usage.cachedTokens);
  return (fresh * p.input + usage.cachedTokens * p.cached + usage.completionTokens * p.output) / 1_000_000;
}
