import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { base64url, canSeal, keyBytes, lineOk, seal, SEALED_LENGTH } from "../src/seal.ts";

const vector = JSON.parse(readFileSync(new URL("../../../services/brain/vector.json", import.meta.url), "utf8")) as {
  key: string;
  mask: string;
  line: string;
  eph: string;
  nonce: string;
  sealed: string;
};
const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

describe("seal", () => {
  it("seals exactly what the mind's module opens", async () => {
    const sealed = await seal(vector.key, vector.mask, vector.line, { ephemeral: bytes(vector.eph), nonce: bytes(vector.nonce) });
    expect(sealed).toBe(vector.sealed);
  });

  it("makes a fresh box every time, always the same size", async () => {
    expect(await canSeal()).toBe(true);
    const a = await seal(vector.key, vector.mask, "take it all");
    const b = await seal(vector.key, vector.mask, "take it all");
    const long = await seal(vector.key, vector.mask, "я".repeat(160));
    expect(a).not.toBe(b);
    expect([a.length, b.length, long.length]).toEqual([SEALED_LENGTH, SEALED_LENGTH, SEALED_LENGTH]);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{763}$/);
  });

  it("takes one line only", async () => {
    expect(lineOk("Wait for the window. Then take it all.")).toBe(true);
    expect(lineOk("")).toBe(false);
    expect(lineOk("two\nlines")).toBe(false);
    expect(lineOk("x".repeat(161))).toBe(false);
    expect(lineOk("😈".repeat(128))).toBe(false);
    await expect(seal(vector.key, vector.mask, "a\tb")).rejects.toThrow("one line");
  });

  it("knows the mind's key format", () => {
    expect(keyBytes(vector.key)).toHaveLength(32);
    expect(() => keyBytes("ed25519:abc")).toThrow("x25519");
  });

  it("writes base64url without padding", () => {
    expect(base64url(Uint8Array.from([0xfb, 0xff]))).toBe("-_8");
    expect(base64url(new TextEncoder().encode("mask"))).toBe("bWFzaw");
  });
});
