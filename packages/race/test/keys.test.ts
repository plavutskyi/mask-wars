import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openFinding, sealableKeys, sealFinding } from "../src/finding-box.ts";
import { claimKeyOf, raceKey, roundKeys, secretsOf } from "../src/keys.ts";
import { base58Encode, NearKey } from "../src/near-tx.ts";
// The owner's script that puts the public halves on chain: it must derive exactly the keys the race signs with.
import { racePublicKey, safeAccount } from "../../../scripts/testnet/season-keys.mjs";

const SEED = "07".repeat(32);
const SEASON = "season.tinygif8324.testnet";
const BOUNTY = "bounty.tinygif8324.testnet";

describe("a mask's race keys from its seed", () => {
  it("gives one fixed key per receiver", () => {
    // Worked out once with node:crypto: HMAC-SHA256(seed, "maskwars-race-key:" + receiver) as the ed25519 seed.
    expect(raceKey(SEED, `s0001.${SEASON}`).publicKeyText).toBe("ed25519:G9MxSP5Wg2AuFcm58oWpHWaofvEUfJXv8tuq2VVAthXX");
    expect(raceKey(SEED, BOUNTY).publicKeyText).toBe("ed25519:AyZEmDtmMNNkiscYhza333uceJUzgebLnTtdBf4k6w3r");
    expect(raceKey(SEED, `s0002.${SEASON}`).publicKeyText).not.toBe(raceKey(SEED, `s0001.${SEASON}`).publicKeyText);
  });

  it("is the key the owner's script puts on chain, for every safe of the season", () => {
    for (let n = 1; n <= 30; n++) {
      const safe = safeAccount(SEASON, n);
      expect(safe).toBe(`s${String(n).padStart(4, "0")}.${SEASON}`);
      expect(raceKey(SEED, safe).publicKeyText).toBe(racePublicKey(SEED, safe));
    }
    expect(raceKey(SEED, BOUNTY).publicKeyText).toBe(racePublicKey(SEED, BOUNTY));
  });

  it("takes a seed and plays any safe with it, or the two old keys on their one safe", () => {
    const fromSeed = roundKeys({ seed: SEED }, `s0003.${SEASON}`, BOUNTY);
    expect(fromSeed.anyMethod).toBe(true);
    expect(fromSeed.safeKey.publicKeyText).toBe(racePublicKey(SEED, `s0003.${SEASON}`));
    expect(fromSeed.claimKey.publicKeyText).toBe(racePublicKey(SEED, BOUNTY));
    const old = {
      safe: `ed25519:${base58Encode(Buffer.alloc(32, 1))}`,
      claim: `ed25519:${base58Encode(Buffer.alloc(32, 2))}`,
    };
    const legacy = roundKeys(old, "safe-0002.tinygif8324.testnet", BOUNTY);
    expect(legacy.anyMethod).toBe(false);
    expect(legacy.safeKey.publicKeyText).toBe(new NearKey(old.safe).publicKeyText);
    expect(() => roundKeys({ safe: old.safe }, "x.testnet", BOUNTY)).toThrow("a seed, or both");
    expect(() => raceKey("07", BOUNTY)).toThrow("32 bytes");
  });

  it("seals the finding for the seed's key on the bounty contract, the one the owner publishes in MASK_CLAIM_KEYS", () => {
    // After the split of Live race, the race job seals the winning plan for a published key and the drain job opens it
    // with the mask's own key. With seeds, that key is the one the seed gives for the bounty contract.
    const dir = mkdtempSync(join(tmpdir(), "season-keys-"));
    const file = join(dir, "mask-seeds.json");
    writeFileSync(file, JSON.stringify({ NOVA: { seed: SEED } }));
    const script = fileURLToPath(new URL("../../../scripts/testnet/season-keys.mjs", import.meta.url));
    execFileSync(process.execPath, [script, file, SEASON, BOUNTY, "1", "2", "nova"], { stdio: "pipe" });
    const published = JSON.parse(readFileSync(join(dir, "mask-seeds.public.json"), "utf8")) as Record<string, string>;
    const claim = claimKeyOf({ seed: SEED }, BOUNTY);
    expect(published).toEqual({ NOVA: claim.publicKeyText });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ NOVA: { seed: SEED } });
    // On chain the mask holds that key on the bounty contract and others elsewhere: only it gets the box.
    const onChain = [
      { public_key: claim.publicKeyText, access_key: { permission: { FunctionCall: { receiver_id: BOUNTY, method_names: [] } } } },
      { public_key: racePublicKey(SEED, `s0001.${SEASON}`), access_key: { permission: { FunctionCall: { receiver_id: `s0001.${SEASON}`, method_names: [] } } } },
    ];
    const to = sealableKeys(onChain as never, BOUNTY, [published.NOVA!]);
    expect(to).toEqual([claim.publicKeyText]);
    const box = sealFinding('{"attacker":"NOVA"}', { mask: "NOVA", account: "nova.tinygif8324.testnet", to: to[0]! });
    expect(openFinding(box, claimKeyOf({ seed: SEED }, BOUNTY))).toBe('{"attacker":"NOVA"}');
    // A rotation gives the mask a new seed, so a leaked old one opens nothing sealed after it.
    execFileSync(process.execPath, [script, "--rotate", file, SEASON, BOUNTY, "1", "2", "nova"], { stdio: "pipe" });
    const rotated = JSON.parse(readFileSync(file, "utf8")) as Record<string, { seed: string }>;
    expect(rotated.NOVA!.seed).not.toBe(SEED);
    expect(() => openFinding(sealFinding("x", { mask: "NOVA", account: "nova.tinygif8324.testnet", to: claimKeyOf(rotated.NOVA!, BOUNTY).publicKeyText }), claim)).toThrow();
  }, 30_000);

  it("names every secret so the job log masks it", () => {
    expect(secretsOf({ NOVA: { seed: SEED }, ONYX: { safe: "ed25519:a", claim: "ed25519:b" } })).toEqual([SEED, "ed25519:a", "ed25519:b"]);
  });
});
