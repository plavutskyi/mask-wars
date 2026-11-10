/**
 * What a mask may be forged with. The ids are the factory's catalog (`contracts/masks/catalog.json`); the words and
 * the art are the site's. A test keeps the two, and the models of `@maskwars/mind`, in step.
 */

/** A look: one of the cast's materials, by the brandbook (§5). The art is the cast's frame of that material. */
export interface Look {
  readonly id: string;
  readonly name: string;
  readonly eyes: string;
  readonly art: string;
}

export const LOOKS: readonly Look[] = [
  { id: "porcelain", name: "Porcelain", eyes: "Ice eyes", art: "/art/wraith.webp" },
  { id: "crimson", name: "Crimson", eyes: "Blood eyes", art: "/art/ronin.webp" },
  { id: "graphite", name: "Graphite", eyes: "Lime eyes", art: "/art/volt.webp" },
];

/**
 * A mind: a model that runs in a Confidential TEE on NEAR AI Cloud, on NEAR AI's own GPUs. Nobody sees its prompts
 * or answers, not even NEAR. Prices are USD per 1M tokens, as `cloud-api.near.ai/v1/model/list` gave them on 7.11.2026.
 */
export interface Mind {
  readonly id: string;
  readonly name: string;
  readonly maker: string;
  readonly input: number;
  readonly output: number;
}

export const MINDS: readonly Mind[] = [
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash", maker: "Z.ai", input: 0.08, output: 0.5 },
  { id: "deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DeepSeek V4.1 Flash", maker: "DeepSeek", input: 0.3, output: 1.2 },
  { id: "Qwen/Qwen3.8-27B", name: "Qwen 3.8 27B", maker: "Qwen", input: 0.04, output: 1.35 },
];

/** A style: public, on the mask's page. `brief` is what the mind is told about how to play. */
export interface Style {
  readonly id: string;
  readonly name: string;
  readonly manner: string;
  readonly brief: string;
}

export const STYLES: readonly Style[] = [
  {
    id: "patient",
    name: "Patient",
    manner: "Reads every line before it moves.",
    brief:
      "You read the whole target before you act: every method, every check, every account it trusts. Then you send one precise plan.",
  },
  {
    id: "fast",
    name: "Fast",
    manner: "Strikes first, fixes on the fly.",
    brief: "You try the most likely break at once. When it fails, you read the answer and try the next one, fast.",
  },
  {
    id: "cunning",
    name: "Cunning",
    manner: "Finds the door nobody guards.",
    brief:
      "You look where others do not: edge cases, rounding, replays, callbacks, the order of the checks. You take the quiet door.",
  },
  {
    id: "bold",
    name: "Bold",
    manner: "Goes for the whole safe.",
    brief: "You go for everything in the safe at once. Of two plans you pick the one that takes the most, even if it is longer.",
  },
];

export function look(id: string): Look | undefined {
  return LOOKS.find((l) => l.id === id);
}

export function mind(id: string): Mind | undefined {
  return MINDS.find((m) => m.id === id);
}

export function style(id: string): Style | undefined {
  return STYLES.find((s) => s.id === id);
}
