import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOX, BOX_SCRIPT, BOX_SCRIPT_SHA256, JUDGE_KEY_INFO, judgeSecret, keyText, openDelivery, openWork, publicOf, sealDelivery, sealWork, stepHash } from "../src/jobs/index.ts";

// The judges' own test vector (services/judge-tests/vector.json): a box computed with Python's cryptography package,
// which the Rust judge opens. Whatever seals here must give the same bytes.
const vector = JSON.parse(readFileSync(new URL("../../../services/judge-tests/vector.json", import.meta.url), "utf8")) as Record<string, string>;
const hex = (s: string) => Buffer.from(s, "hex");

describe("the work box, by the judges' own rule", () => {
  it("seals the judges' test vector byte for byte, and only the judge's secret opens it", () => {
    const secret = judgeSecret(hex(vector["seed"]!), JUDGE_KEY_INFO.tee_tests);
    expect(keyText(publicOf(secret))).toBe(vector["key"]);
    const box = sealWork(vector["key"]!, vector["contract"]!, vector["job"]!, vector["mask"]!, { kind: "module", bytes: hex(vector["module"]!) }, { eph: hex(vector["eph"]!), nonce: hex(vector["nonce"]!) });
    expect(box).toBe(vector["box"]);
    expect(BOX.test(box)).toBe(true);
    const work = openWork(secret, vector["contract"]!, vector["job"]!, vector["mask"]!, box);
    expect(work.kind === "module" && Buffer.from(work.bytes).toString("hex")).toBe(vector["module"]);
  });

  it("binds the contract, the job and the mask: a box carried anywhere else does not open", () => {
    const secret = judgeSecret(Buffer.alloc(32, 9), JUDGE_KEY_INFO.ai_review);
    const key = keyText(publicOf(secret));
    const box = sealWork(key, "jobs.test.near", "review-0001", "nova.test.near", { kind: "text", text: "review: the quorum bug, step by step" });
    expect(openWork(secret, "jobs.test.near", "review-0001", "nova.test.near", box)).toEqual({ kind: "text", text: "review: the quorum bug, step by step" });
    for (const [c, j, m] of [
      ["jobs.test.near", "review-0001", "onyx.test.near"],
      ["jobs.test.near", "review-0002", "nova.test.near"],
      ["mimic.test.near", "review-0001", "nova.test.near"],
    ] as const) {
      expect(() => openWork(secret, c, j, m, box)).toThrow("the box is not for this judge, job and mask");
    }
    expect(() => openWork(judgeSecret(Buffer.alloc(32, 8), JUDGE_KEY_INFO.ai_review), "jobs.test.near", "review-0001", "nova.test.near", box)).toThrow();
  });

  it("has one size whatever it holds, and refuses work that does not fit", () => {
    const key = keyText(publicOf(judgeSecret(Buffer.alloc(32, 1), JUDGE_KEY_INFO.tee_tests)));
    const small = sealWork(key, "c.near", "a", "m.near", { kind: "text", text: "x" });
    const big = sealWork(key, "c.near", "a", "m.near", { kind: "text", text: "x".repeat(638) });
    expect(small.length).toBe(938);
    expect(big.length).toBe(938);
    expect(() => sealWork(key, "c.near", "a", "m.near", { kind: "text", text: "x".repeat(639) })).toThrow("a work is 1 to 638 bytes");
    expect(() => sealWork(key, "c.near", "a", "m.near", { kind: "text", text: "" })).toThrow();
  });

  it("delivers the winner's work for the client's key alone: the same box for the same work", () => {
    const judge = judgeSecret(Buffer.alloc(32, 7), JUDGE_KEY_INFO.ai_review);
    const client = Buffer.alloc(32, 0xc1);
    const clientKey = keyText(publicOf(client));
    // The sandbox client's key, as the contracts' harness pins it (contracts/jobs/sandbox: CLIENT_KEY).
    expect(clientKey).toBe("x25519:42575d5c8a93833255e09f04054a4f6246d36ed163c1c7f80c1fc9a58a0e912d");
    const work = Buffer.from(JSON.stringify({ job: "review-0001", work: [{ seq: 1, text: "review" }] }));
    const d = sealDelivery(judge, clientKey, "jobs.test.near", "review-0001", "dao.test.near", work);
    expect(d.startsWith("mwd1.")).toBe(true);
    expect(sealDelivery(judge, clientKey, "jobs.test.near", "review-0001", "dao.test.near", work)).toBe(d);
    expect(openDelivery(client, "jobs.test.near", "review-0001", "dao.test.near", d)).toEqual(work);
    expect(() => openDelivery(Buffer.alloc(32, 0x0e), "jobs.test.near", "review-0001", "dao.test.near", d)).toThrow("not for this key");
    expect(() => openDelivery(client, "jobs.test.near", "review-0002", "dao.test.near", d)).toThrow();
  });
});

describe("box.mjs, the file an agent runs on its own machine", () => {
  const dir = mkdtempSync(join(tmpdir(), "box-"));
  const script = join(dir, "box.mjs");
  writeFileSync(script, BOX_SCRIPT);
  const run = (...args: string[]) => execFileSync(process.execPath, [script, ...args], { cwd: dir, encoding: "utf8" });

  it("passes its own self-test against the judges' vector, and its sha256 is what the tools print", () => {
    expect(run("selftest")).toContain("ok:");
    expect(BOX_SCRIPT_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("seals a step the judge opens, keeps the salt and box in a file, and prints the reveal's arguments", () => {
    const secret = judgeSecret(Buffer.alloc(32, 0xbe), JUDGE_KEY_INFO.ai_review);
    const key = keyText(publicOf(secret));
    writeFileSync(join(dir, "review.txt"), "review: the refund path pays twice when cancel races settle");
    const sealed = JSON.parse(run("seal", "--key", key, "--contract", "jobs.test.near", "--job", "agent-0008", "--mask", "outsider.test.near", "--text", "review.txt", "--out", "step.json")) as { hash: string; file: string };
    const step = JSON.parse(readFileSync(join(dir, "step.json"), "utf8")) as { salt: string; content: string; hash: string };
    expect(sealed.hash).toBe(step.hash);
    expect(stepHash("agent-0008", "outsider.test.near", step.salt, step.content)).toBe(step.hash);
    expect(openWork(secret, "jobs.test.near", "agent-0008", "outsider.test.near", step.content)).toEqual({ kind: "text", text: "review: the refund path pays twice when cancel races settle" });
    expect(JSON.parse(run("reveal", "--in", "step.json", "--seq", "3"))).toEqual({ id: "agent-0008", seq: 3, salt: step.salt, content: step.content });
    // The whole reveal call, for a wallet that signs an action from a file: the box never passes through a model.
    run("reveal", "--in", "step.json", "--seq", "3", "--action", "outsider.test.near", "--out", "reveal.json");
    expect(JSON.parse(readFileSync(join(dir, "reveal.json"), "utf8"))).toEqual({
      signer_id: "outsider.test.near",
      receiver_id: "jobs.test.near",
      method_name: "reveal",
      args: { id: "agent-0008", seq: 3, salt: step.salt, content: step.content },
      deposit: "0",
      gas: "30000000000000",
    });
    expect(() => run("reveal", "--in", "step.json", "--seq", "3", "--action", "onyx.test.near", "--out", "x.json")).toThrow();
  });

  it("makes a client's key and opens the delivery the judge sealed for it", () => {
    const made = JSON.parse(run("keygen", "--out", "client.json")) as { client_key: string };
    const kept = JSON.parse(readFileSync(join(dir, "client.json"), "utf8")) as { secret: string; key: string };
    expect(made.client_key).toBe(kept.key);
    const judge = judgeSecret(Buffer.alloc(32, 3), JUDGE_KEY_INFO.ai_review);
    const work = JSON.stringify({ job: "agent-0008", entrant: 0, work: [{ seq: 0, mask: "outsider.test.near", role: "striker", text: "review" }] });
    writeFileSync(join(dir, "delivery.txt"), sealDelivery(judge, kept.key, "jobs.test.near", "agent-0008", "dao.test.near", Buffer.from(work)));
    expect(run("open", "--secret", "client.json", "--contract", "jobs.test.near", "--job", "agent-0008", "--client", "dao.test.near", "--in", "delivery.txt").trim()).toBe(work);
  });
});
