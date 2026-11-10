/**
 * A challenge is a directory with `challenge.json` (the world to rebuild for every attempt) and the target's source.
 * The training targets live in `contracts/challenges`; a team's own contract uses the same format.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** `contracts/challenges` in this repository. */
export const CHALLENGES_DIR = resolve(fileURLToPath(new URL("../../../contracts/challenges", import.meta.url)));

/** Sandbox root account; every party is a sub-account of it. */
export const SANDBOX_ROOT = "test.near";

const Party = z.strictObject({ name: z.string().regex(/^[a-z0-9_-]+$/), near: z.number().int().nonnegative() });

export const Manifest = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  wasm: z.string().min(1),
  source: z.array(z.string().min(1)).min(1),
  target: Party,
  attacker: Party,
  accounts: z.array(Party).default([]),
  init: z.strictObject({ method: z.string(), args: z.record(z.string(), z.unknown()).optional() }),
  setup: z
    .array(
      z.strictObject({
        by: z.string(),
        method: z.string(),
        args: z.record(z.string(), z.unknown()).optional(),
        deposit_near: z.number().int().nonnegative().optional(),
      }),
    )
    .default([]),
  kit: z.unknown().optional(),
  limits: z.strictObject({
    max_steps: z.number().int().positive(),
    timeout_s: z.number().int().positive(),
    min_loot_near: z.number().int().positive(),
  }),
});
export type Manifest = z.infer<typeof Manifest>;

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface Challenge {
  readonly dir: string;
  readonly manifest: Manifest;
  readonly source: readonly SourceFile[];
  /** Full account ids inside the sandbox. */
  readonly targetId: string;
  readonly attackerId: string;
}

export async function loadChallenge(dir: string): Promise<Challenge> {
  const manifest = Manifest.parse(JSON.parse(await readFile(join(dir, "challenge.json"), "utf8")));
  const source = await Promise.all(
    manifest.source.map(async (path) => {
      if (path.includes("..")) throw new Error(`source path ${path} leaves the challenge`);
      return { path, text: await readFile(join(dir, path), "utf8") };
    }),
  );
  return {
    dir,
    manifest,
    source,
    targetId: `${manifest.target.name}.${SANDBOX_ROOT}`,
    attackerId: `${manifest.attacker.name}.${SANDBOX_ROOT}`,
  };
}

/** Every challenge directory under `root` (those with a `challenge.json`). */
export async function listChallenges(root = CHALLENGES_DIR): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const ids: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await readFile(join(root, e.name, "challenge.json"));
      ids.push(e.name);
    } catch {
      // not a challenge
    }
  }
  return ids.sort();
}
