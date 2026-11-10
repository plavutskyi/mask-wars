import { describe, expect, it } from "vitest";
import { base58Decode, base58Encode, encodeTx, NearKey, signTx } from "../src/near-tx.ts";

// Made once with near-api-js 5 (`createTransaction`, `functionCall`, `signTransaction`) from the same inputs: a
// throwaway key whose seed is 32 bytes of 7.
const SEED = Buffer.alloc(32, 7);
const SECRET = `ed25519:${base58Encode(Buffer.concat([SEED, base58Decode("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB")]))}`;
const PUBLIC = "ed25519:GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB";
const HASH = "8GpRaE1naBGQB5JDHFk5bTK7UmxotgEZ6TinbVNB5zgU";
const SIGNED =
  "GAAAAG5vdmEudGlueWdpZjgzMjQudGVzdG5ldADqSmxj4pxSCr71UHsTLsX5lUd2rr6+e5JCHuppFEbSLBQamb4cAAAAHQAAAHNhZmUtMDAwMS50aW55Z2lmODMyNC50ZXN0bmV0JZeSHlORWntLKOV3wHDM4WiLUkIT1juOKeOFYSzQuFQBAAAAAgUAAABzd2VlcEYAAAB7InRvIjoibm92YS50aW55Z2lmODMyNC50ZXN0bmV0IiwiYW1vdW50IjoiMTUwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCJ9AOBX60gbAAAAAAAAAAAAAAAAAAAAAAAAAJn7g8kpG2uSfRigDNVcpNHzRsI9T9GqOhIiU4BXI2RePXfxMD+wJFGGJjRqMNPIuA//WjiV8gDNC+Qg3Ac55AM=";

const sweep = (key: NearKey) => ({
  signer: "nova.tinygif8324.testnet",
  publicKey: key.publicKey,
  nonce: 123456789012n,
  receiver: "safe-0001.tinygif8324.testnet",
  blockHash: base58Decode("3Xk8pQ2rT5vW9yB1cD4fG6hJ7kL8mN9oP1qR2sT3uV4w"),
  method: "sweep",
  args: Buffer.from('{"to":"nova.tinygif8324.testnet","amount":"1500000000000000000000000"}'),
  gas: 30_000_000_000_000n,
  deposit: 0n,
});

describe("a mask's transaction", () => {
  it("reads a NEAR secret key, 64 or 32 bytes, and knows its public half", () => {
    expect(new NearKey(SECRET).publicKeyText).toBe(PUBLIC);
    expect(new NearKey(`ed25519:${base58Encode(SEED)}`).publicKeyText).toBe(PUBLIC);
  });

  it("signs byte for byte as near-api-js does", () => {
    const key = new NearKey(SECRET);
    expect(signTx(sweep(key), key)).toEqual({ hash: HASH, base64: SIGNED });
  });

  it("carries the deposit as u128", () => {
    const key = new NearKey(SECRET);
    const body = encodeTx({ ...sweep(key), deposit: (1n << 100n) + 5n });
    expect(body.subarray(-16).toString("hex")).toBe("05000000000000000000000010000000");
  });

  it("refuses a key that is not ed25519 or does not match itself", () => {
    expect(() => new NearKey("secp256k1:abc")).toThrow("ed25519");
    const raw = base58Decode(SECRET.slice(8));
    raw[40] = raw[40]! ^ 1;
    expect(() => new NearKey(`ed25519:${base58Encode(raw)}`)).toThrow("does not match");
  });

  it("keeps leading zero bytes through base58", () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 255]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });
});
