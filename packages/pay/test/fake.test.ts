import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { fakePay } from "../src/fake.ts";
import {
  accountOf,
  base64url,
  cashOutRequest,
  catalogOf,
  challengeOf,
  checkIntent,
  concat,
  Ledger,
  OneClick,
  progressOf,
  signedWebauthn,
  topUpRequest,
  utf8,
  vaultCoins,
  vaultOf,
} from "../src/index.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/oneclick.json", import.meta.url), "utf8"));

describe("the money pages' round trip, against 1Click and NEAR Intents in memory", () => {
  it("tops up from Solana, then cashes out to Base with a passkey signature", async () => {
    let t = Date.parse("2026-11-08T09:10:00.000Z");
    const pay = fakePay({ tokens: fx.tokens, stepMs: 1000, now: () => t });
    const api = new OneClick({ fetch: pay.fetch });
    const ledger = new Ledger({ fetch: pay.fetch });
    const cat = catalogOf(await api.tokens())!;
    const secret = p256.utils.randomSecretKey();
    const key = p256.getPublicKey(secret, false).slice(1);
    const account = accountOf(key);
    const vault = async () => vaultOf(account, cat, await ledger.balances(account, vaultCoins(cat).map((c) => c.assetId)));
    expect((await vault()).usd).toBe(0);

    const usdc = cat.chains[0]!.coins[0]!;
    const wet = await api.quote(topUpRequest({ account, from: usdc, amount: 25_000_000n, dry: false, now: new Date(t) }));
    const at = wet.quote.depositAddress!;
    expect(progressOf(await api.status(at)).stage).toBe("waiting");
    t += 2500;
    expect(progressOf(await api.status(at)).stage).toBe("seen");
    t += 2000;
    expect(progressOf(await api.status(at)).stage).toBe("done");
    const full = await vault();
    expect(full.usd).toBeCloseTo(25 * usdc.price * 0.997, 1);

    const out = await api.quote(
      cashOutRequest({ account, from: cat.near, to: cat.chains[1]!.coins[0]!, recipient: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F", amount: BigInt(full.near) / 2n, dry: false, now: new Date(t) }),
    );
    const intent = await api.generateIntent({ depositAddress: out.quote.depositAddress!, signerId: account, standard: "webauthn" });
    expect(
      checkIntent(intent, { signer: account, depositAddress: out.quote.depositAddress!, asset: cat.near.assetId, amount: out.quote.amountIn, notAfter: out.quote.deadline!, now: new Date(t) }),
    ).toEqual({ ok: true });
    const payload = intent.payload as string;
    const authenticatorData = concat(sha256(utf8("maskwars.xyz")), Uint8Array.of(0x05), new Uint8Array(4));
    const clientDataJSON = utf8(JSON.stringify({ type: "webauthn.get", challenge: base64url(challengeOf(payload)), origin: "https://maskwars.xyz" }));
    const signature = p256.sign(sha256(concat(authenticatorData, sha256(clientDataJSON))), secret, { prehash: false, format: "der" });
    const signed = signedWebauthn(payload, key, { authenticatorData, clientDataJSON, signature })!;

    const forged = { ...signed, payload: payload.replace(out.quote.amountIn, (BigInt(out.quote.amountIn) * 2n).toString()) };
    await expect(api.submitIntent(forged)).rejects.toMatchObject({ status: 400 });
    expect((await api.submitIntent(signed)).intentHash).toBeTruthy();
    await expect(api.submitIntent(signed)).rejects.toMatchObject({ status: 400 });
    expect(progressOf(await api.status(out.quote.depositAddress!)).stage).toBe("moving");
    t += 1500;
    const sent = progressOf(await api.status(out.quote.depositAddress!));
    expect(sent.stage).toBe("done");
    expect((await vault()).near).toBe((BigInt(full.near) - BigInt(out.quote.amountIn)).toString());
  });

  it("refuses an amount below the route's minimum, like 1Click", async () => {
    const pay = fakePay({ tokens: fx.tokens });
    const cat = catalogOf(fx.tokens)!;
    const err = await new OneClick({ fetch: pay.fetch }).quote(topUpRequest({ account: fx.account, from: cat.chains[0]!.coins[0]!, amount: 500_000n, dry: true })).catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
  });
});
