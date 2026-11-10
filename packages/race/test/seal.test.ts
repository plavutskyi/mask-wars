import { describe, expect, it } from "vitest";
import { NearKey, base58Encode } from "../src/near-tx.ts";
import { newSalt, planText, sealHash, sealSalt } from "../src/seal.ts";

describe("a seal", () => {
  it("is the same sha256 the bounty contract computes", () => {
    // The same vector is checked in contracts/bounty (seal_hash) and contracts/challenges/runner (round.rs).
    const plan = planText([
      { method: "set_owner", args: { new_owner: "nova.tinygif8324.testnet" } },
      { method: "sweep", args: { to: "nova.tinygif8324.testnet", amount: "1000000000000000000000000" } },
    ]);
    expect(plan).toBe(
      '[{"method":"set_owner","args":{"new_owner":"nova.tinygif8324.testnet"}},{"method":"sweep","args":{"to":"nova.tinygif8324.testnet","amount":"1000000000000000000000000"}}]',
    );
    expect(sealHash("race-0004", "nova.tinygif8324.testnet", "0123456789abcdef0123456789abcdef", plan)).toBe(
      "cce78cfbfb2d6aee8c1b5aed63ee1fdc5c1efe8cab8a421bae8a200979e6ca10",
    );
  });

  it("binds the mask: another mask's copy of the hash seals nothing of its own", () => {
    const plan = planText([{ method: "sweep", args: { to: "x", amount: "1" } }]);
    const salt = newSalt();
    expect(sealHash("race-0004", "onyx.tinygif8324.testnet", salt, plan)).not.toBe(sealHash("race-0004", "nova.tinygif8324.testnet", salt, plan));
  });

  it("gets a fresh salt the contract accepts", () => {
    const a = newSalt();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newSalt()).not.toBe(a);
  });

  it("gets its salt from the mask's key: the same every time, different for every round and mask", () => {
    const key = new NearKey(`ed25519:${base58Encode(Buffer.alloc(32, 2))}`);
    const salt = sealSalt(key, "race-0004", "nova.tinygif8324.testnet");
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(sealSalt(key, "race-0004", "nova.tinygif8324.testnet")).toBe(salt);
    expect(sealSalt(key, "race-0005", "nova.tinygif8324.testnet")).not.toBe(salt);
    expect(sealSalt(key, "race-0004", "onyx.tinygif8324.testnet")).not.toBe(salt);
    const other = new NearKey(`ed25519:${base58Encode(Buffer.alloc(32, 3))}`);
    expect(sealSalt(other, "race-0004", "nova.tinygif8324.testnet")).not.toBe(salt);
  });
});
