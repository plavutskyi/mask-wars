import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CoreError,
  fightSeal,
  identitySeal,
  makeSalt32,
  preimage,
  sha256Hex,
  splitmix64,
  strategySeal,
  utf8,
  verifyFightSeal,
  verifyIdentitySeal,
  verifyStrategySeal,
} from "../src/index.ts";

const salt = "ab".repeat(32);
const nodeSha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("sha256", () => {
  it("matches node:crypto on every length around the block edges and on random input", () => {
    const next = splitmix64(7n);
    for (let n = 0; n < 300; n++) {
      const bytes = Uint8Array.from({ length: n }, () => Number(next() & 0xffn));
      expect(sha256Hex(bytes)).toBe(nodeSha(bytes));
    }
    expect(sha256Hex(utf8("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("seal", () => {
  it("hashes the spec's layout: domain 00 fight 00 mask 00 primary 00 backup 00 call 00 salt", () => {
    const text = `maskwars.seal.v1\0f-0-1\0onyx\0BTC\0ETH\0SOL\0${salt}`;
    expect(fightSeal("f-0-1", "onyx", ["BTC", "ETH", "SOL"], salt)).toBe(nodeSha(Buffer.from(text, "utf8")));
    expect(identitySeal("onyx", "glm", salt)).toBe(nodeSha(Buffer.from(`maskwars.identity.v1\0onyx\0glm\0${salt}`)));
    expect(strategySeal("onyx", "Wait.", salt)).toBe(nodeSha(Buffer.from(`maskwars.strategy.v1\0onyx\0Wait.\0${salt}`)));
  });

  it("fails on another salt, coin, fight or mask", () => {
    const seal = fightSeal("f-0-1", "onyx", ["BTC", "ETH", "SOL"], salt);
    expect(verifyFightSeal(seal, "f-0-1", "onyx", ["BTC", "ETH", "SOL"], salt)).toBe(true);
    expect(verifyFightSeal(seal, "f-0-1", "onyx", ["BTC", "ETH", "SOL"], "cd".repeat(32))).toBe(false);
    expect(verifyFightSeal(seal, "f-0-1", "onyx", ["BTC", "ETH", "ZEC"], salt)).toBe(false);
    expect(verifyFightSeal(seal, "f-0-2", "onyx", ["BTC", "ETH", "SOL"], salt)).toBe(false);
    expect(verifyFightSeal(seal, "f-0-1", "nova", ["BTC", "ETH", "SOL"], salt)).toBe(false);
    expect(verifyIdentitySeal(identitySeal("onyx", "glm", salt), "onyx", "qwen", salt)).toBe(false);
    expect(verifyStrategySeal(strategySeal("onyx", "a", salt), "onyx", "a", salt)).toBe(true);
    expect(verifyFightSeal(seal.toUpperCase(), "f-0-1", "onyx", ["BTC", "ETH", "SOL"], salt)).toBe(false);
  });

  it("refuses bad ids, salts and 0x00 inside a field", () => {
    expect(() => fightSeal("fight-1", "onyx", [], salt)).toThrow(CoreError);
    expect(() => fightSeal("f-0-1", "Onyx", [], salt)).toThrow(CoreError);
    expect(() => fightSeal("f-0-1", "onyx", [], "AB".repeat(32))).toThrow(CoreError);
    expect(() => preimage(["a\0b"])).toThrow(CoreError);
  });

  it("takes salt from the randomness it is given", () => {
    expect(makeSalt32((n) => new Uint8Array(n).fill(1))).toBe("01".repeat(32));
    expect(() => makeSalt32(() => new Uint8Array(31))).toThrow(CoreError);
  });
});
