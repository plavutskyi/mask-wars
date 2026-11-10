// The vectors shared with the TEE module (services/check): the file is what the check answers today, and every vector
// answers from its own exchanges alone. `cargo test` in services/check replays the same file.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ReasonCode } from "../src/check.ts";
import { VECTORS_FILE, type VectorFile, buildVectors, format, replay } from "./vectors.ts";

const text = readFileSync(VECTORS_FILE, "utf8");
const file = JSON.parse(text) as VectorFile;

/** Every reason the check can give. */
const CODES: readonly ReasonCode[] = [
  "no_account",
  "unused_implicit",
  "arena_drained",
  "arena_taken_over",
  "arena_target",
  "arena_withstood",
  "arena_pending",
  "arena_unreadable",
  "reported",
  "young_account",
  "code_deployed",
  "code_changed",
  "account_age",
  "contract",
  "plain_account",
  "history_unavailable",
  "rpc_agree",
  "rpc_single",
  "rpc_disagree",
  "chain_unreadable",
];

describe("the vectors shared with the TEE module", () => {
  it("are what the check answers today (pnpm --filter @maskwars/check vectors writes them again)", async () => {
    expect(format(await buildVectors())).toBe(text);
  });

  it.each(file.vectors.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    const { got, unexpected } = await replay(v);
    expect(unexpected).toEqual([]);
    expect(got).toEqual(v.expect);
  });

  it("cover every reason and every verdict, on both networks", () => {
    const answers = file.vectors.flatMap((v) => ("throws" in v.expect ? [] : [v.expect]));
    expect([...new Set(answers.flatMap((a) => a.reasons.map((r) => r.code)))].sort()).toEqual([...CODES].sort());
    expect(new Set(answers.map((a) => a.verdict))).toEqual(new Set(["allow", "warn", "block"]));
    expect(new Set(file.vectors.map((v) => v.network))).toEqual(new Set(["mainnet", "testnet"]));
    expect(file.vectors.some((v) => "throws" in v.expect)).toBe(true);
  });
});
