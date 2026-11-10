import { describe, expect, it } from "vitest";
import { accountOk, amountOf, dollarsOf, jobHash, jobIdOk, jobOf, jobText, networkOf, newJobId, parseNear, teamOk } from "../src/index.ts";

describe("a job in the team's words", () => {
  it("is one clean line of 8 to 280 characters", () => {
    expect(jobText("  Attack my   vault\nbefore launch ")).toBe("Attack my vault before launch");
    expect(jobText("short")).toBeNull();
    expect(jobText("x".repeat(280))).toHaveLength(280);
    expect(jobText("x".repeat(281))).toBeNull();
  });

  it("hides nothing: no control characters, no text that reads backwards", () => {
    expect(jobText("Attack my\u0000 vault")).toBeNull();
    expect(jobText("Attack my vault \u202ehcnual")).toBeNull();
    expect(jobText("Attack\u200b my vault")).toBeNull();
    expect(jobText("Attack my vault\tbefore launch")).toBe("Attack my vault before launch");
  });

  it("names a NEAR account for the target on either network, and a mainnet account for the team", () => {
    expect(accountOk("vault.acme.near")).toBe(true);
    expect(accountOk("vault.acme.testnet")).toBe(true);
    expect(accountOk("Vault.acme.near")).toBe(false);
    expect(accountOk("a")).toBe(false);
    expect(accountOk("acme..near")).toBe(false);
    expect(networkOf("vault.acme.testnet")).toBe("testnet");
    expect(networkOf("vault.acme.near")).toBe("mainnet");
    expect(teamOk("acme.near")).toBe(true);
    expect(teamOk("0x3602b546589a8fcafdce7fad64a46f91db0e4d50")).toBe(true);
    expect(teamOk("acme.testnet")).toBe(false);
  });

  it("is whole or nothing, cleaned as a person would mean it", () => {
    expect(jobOf({ text: "Attack my vault before launch", target: " Vault.Acme.near ", team: "ACME.near" })).toEqual({
      text: "Attack my vault before launch",
      target: "vault.acme.near",
      team: "acme.near",
    });
    expect(jobOf({ text: "Attack my vault before launch", target: "vault.acme.near" })).toBeNull();
    expect(jobOf({ text: "Attack", target: "vault.acme.near", team: "acme.near" })).toBeNull();
    expect(jobOf({ text: "Attack my vault before launch", target: "vault.acme.near", team: "acme.testnet" })).toBeNull();
  });

  it("is marked by a hash of exactly its text, target and team", () => {
    const job = { text: "Attack my vault before launch", target: "vault.acme.near", team: "acme.near" };
    // sha256 of {"v":1,"text":"Attack my vault before launch","target":"vault.acme.near","team":"acme.near"}
    expect(jobHash(job)).toBe("2cb5b3cf0c9ff84b82e59fd95bb95346106a5ad6563a2f522e7ea3619bd7da8a");
    expect(jobHash({ ...job, team: "acme2.near" })).not.toBe(jobHash(job));
    expect(jobHash({ ...job, text: `${job.text}.` })).not.toBe(jobHash(job));
  });

  it("gets an id nobody guesses", () => {
    const ids = new Set(Array.from({ length: 200 }, newJobId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(jobIdOk(id)).toBe(true);
    expect(jobIdOk("job-ILOU00000000")).toBe(false);
  });
});

describe("the amount on the job", () => {
  it("reads dollars first, then NEAR", () => {
    expect(amountOf({ usd: "250" })).toEqual({ usd: 250 });
    expect(amountOf({ usd: "$1,250.50" })).toEqual({ usd: 1250.5 });
    expect(amountOf({ near: "100" })).toEqual({ near: 100 });
    expect(amountOf({ usd: "250", near: "100" })).toEqual({ usd: 250 });
    expect(amountOf({ usd: "lots", near: "2.5 NEAR" })).toEqual({ near: 2.5 });
    expect(amountOf({ usd: "0" })).toBeNull();
    expect(amountOf({})).toBeNull();
  });

  it("takes NEAR as a person types it, up to four decimals", () => {
    expect(parseNear("1,000")).toBe(1000);
    expect(parseNear("0.0001")).toBe(0.0001);
    expect(parseNear("0.00001")).toBeNull();
    expect(parseNear("-1")).toBeNull();
    expect(parseNear("2000000")).toBeNull();
  });

  it("prices NEAR in dollars at the live price, to the cent, inside what a route carries", () => {
    expect(dollarsOf({ usd: 250 }, 3.7)).toBe(250);
    expect(dollarsOf({ near: 100 }, 3.7)).toBe(370);
    expect(dollarsOf({ near: 0.1 }, 3.7)).toBeNull();
    expect(dollarsOf({ near: 5000 }, 3.7)).toBeNull();
    expect(dollarsOf({ near: 100 }, 0)).toBeNull();
  });
});
