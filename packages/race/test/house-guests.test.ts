/**
 * The guests of the house's round: people's masks that can race, fewest races first, and agents whose sign-up holds up
 * against the chain, first signed up first; nobody past the network's numbers, and no answer means no guest.
 */
import { createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { nep413Hash, type Signup, signupMessage, signupNonce } from "@maskwars/arena/guests";
import { NETWORKS } from "@maskwars/network";
import { describe, expect, it } from "vitest";
import { agentGuests, drawKey, fetchSignups, forgedGuests, pickGuests, SEAT_FUEL_FLOOR, seatFuel } from "../src/house-guests.ts";
import { base58Encode, type Chain } from "../src/near-tx.ts";

const net = NETWORKS.testnet;
const SLOT = Date.UTC(2026, 10, 12, 18, 0);
const NEAR = 10n ** 24n;

interface World {
  masks: object[] | null;
  accounts: Record<string, bigint>;
  keys: Record<string, "FullAccess" | "FunctionCall">;
}

function chainOf(w: World): Chain & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async rpc(_method: string, params: unknown) {
      const p = params as { request_type: string; account_id: string; method_name?: string; args_base64?: string; public_key?: string };
      if (_method === "block") return { header: { hash: "BLOCKHASH", height: 7 } };
      asked.push(`${p.request_type} ${p.account_id}${p.method_name ? `.${p.method_name}` : ""}`);
      if (p.request_type === "call_function") {
        if (w.masks === null) throw new Error(`query: UNKNOWN_ACCOUNT ${p.account_id} does not exist while viewing`);
        const { from_index, limit } = JSON.parse(Buffer.from(p.args_base64!, "base64").toString()) as { from_index: number; limit: number };
        return { result: [...Buffer.from(JSON.stringify(w.masks.slice(from_index, from_index + limit)))] };
      }
      if (p.request_type === "view_account") {
        const a = w.accounts[p.account_id];
        if (a === undefined) throw new Error(`query: UNKNOWN_ACCOUNT ${p.account_id} does not exist while viewing`);
        return { amount: a.toString(), storage_usage: 182, code_hash: "11111111111111111111111111111111" };
      }
      if (p.request_type === "view_access_key") {
        const k = w.keys[`${p.account_id} ${p.public_key}`];
        if (!k) throw new Error("query: UNKNOWN_ACCESS_KEY access key does not exist while viewing");
        return { nonce: 1, permission: k === "FullAccess" ? "FullAccess" : { FunctionCall: { receiver_id: "x", method_names: [] } } };
      }
      throw new Error(`unexpected ${p.request_type}`);
    },
  };
}

const mask = (name: string, o: Partial<{ state: string; brain: string; races: number; born: number; limit: string }> = {}) => ({
  name,
  account: `${name}.${net.factory}`,
  brain: o.brain ?? (NEAR / 2n).toString(),
  race_limit: o.limit ?? (NEAR / 20n).toString(),
  races: o.races ?? 0,
  born_ns: String(o.born ?? 1),
  state: o.state ?? "ready",
});

function agent(account: string) {
  const { privateKey } = generateKeyPairSync("ed25519");
  const public_key = `ed25519:${base58Encode(createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(12))}`;
  const signup = (slot = SLOT): Signup => {
    const m = signupMessage(net.id, slot, account);
    return { account, public_key, slot, signature: sign(null, nep413Hash(m, signupNonce(m)), privateKey).toString("base64") };
  };
  return { account, public_key, signup };
}

describe("people's masks in the house's round", () => {
  it("only masks that can race, fewest races first, then the oldest, at most the network's number", async () => {
    const w: World = {
      masks: [
        mask("kira", { races: 3, born: 1 }),
        mask("lena", { races: 0, born: 5 }),
        mask("zed", { state: "paused" }),
        mask("ava", { state: "racing" }),
        mask("dry", { brain: "0" }),
        mask("max", { races: 0, born: 2 }),
        mask("ivy", { races: 1, born: 9 }),
      ],
      accounts: {},
      keys: {},
    };
    const got = await forgedGuests(chainOf(w), net.factory, 3);
    expect(got.accounts).toEqual([`max.${net.factory}`, `lena.${net.factory}`, `ivy.${net.factory}`]);
    expect(got.notes).toContain("1 more people's mask(s) can race: they get their turn on a later day");
  });

  it("a seat takes fuel for one whole race of the mind: a yocto, or less than its race limit, waits for a refuel", async () => {
    const w: World = {
      masks: [
        mask("yocto", { brain: "1" }),
        mask("half", { brain: (NEAR / 40n).toString() }),
        mask("full", { brain: (NEAR / 20n).toString(), born: 3 }),
        // A limit under the factory's least (0.01 NEAR) still needs 0.01.
        mask("tiny", { brain: (NEAR / 200n).toString(), limit: "1" }),
        mask("cent", { brain: (NEAR / 100n).toString(), limit: "1", born: 4 }),
      ],
      accounts: {},
      keys: {},
    };
    const got = await forgedGuests(chainOf(w), net.factory, 3);
    expect(got.accounts).toEqual([`full.${net.factory}`, `cent.${net.factory}`]);
    expect(got.notes).toContain("3 people's mask(s) hold less than one race of fuel for their mind: a refuel brings them back");
    expect(seatFuel({ race_limit: (NEAR / 20n).toString() })).toBe(NEAR / 20n);
    expect(seatFuel({ race_limit: "1" })).toBe(SEAT_FUEL_FLOOR);
  });

  it("on mainnet the round reads no agent's sign-up: the site is not even asked", async () => {
    let asked = 0;
    const get = (async () => {
      asked += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const all = await pickGuests({ chain: chainOf({ masks: [mask("kira")], accounts: {}, keys: {} }), net: NETWORKS.mainnet, slot: SLOT, site: "https://maskwars.example", get });
    expect(all.agents).toEqual([]);
    expect(all.masks).toEqual([`kira.${net.factory}`]);
    expect(asked).toBe(0);
  });

  it("reads the factory page by page, and a factory that is not on chain lets no mask in", async () => {
    const many = Array.from({ length: 120 }, (_, i) => mask(`m${i}`, { races: i === 117 ? 0 : 1, born: i }));
    const chain = chainOf({ masks: many, accounts: {}, keys: {} });
    expect((await forgedGuests(chain, net.factory, 1)).accounts).toEqual([`m117.${net.factory}`]);
    expect(chain.asked.filter((a) => a.endsWith("list_masks"))).toHaveLength(3);
    const none = await forgedGuests(chainOf({ masks: null, accounts: {}, keys: {} }), net.factory, 3);
    expect(none).toEqual({ accounts: [], notes: [`${net.factory} is not on chain: no person's mask races today`] });
  });
});

describe("agents in the house's round", () => {
  const a = agent("alpha.testnet");
  const b = agent("bravo.testnet");
  const c = agent("charlie.testnet");
  const d = agent("delta.testnet");
  const w: World = {
    masks: [],
    accounts: { "alpha.testnet": NEAR, "bravo.testnet": NEAR, "charlie.testnet": NEAR / 100n, "delta.testnet": NEAR, [net.house]: NEAR },
    keys: {
      [`alpha.testnet ${a.public_key}`]: "FullAccess",
      [`bravo.testnet ${b.public_key}`]: "FullAccess",
      [`charlie.testnet ${c.public_key}`]: "FullAccess",
      [`delta.testnet ${d.public_key}`]: "FunctionCall",
    },
  };

  it("draws the seats among the sign-ups that pass every check, by a block's hash, never by who came first", async () => {
    const e = agent("echo.testnet");
    w.accounts["echo.testnet"] = NEAR;
    w.keys[`echo.testnet ${e.public_key}`] = "FullAccess";
    const valid = ["alpha.testnet", "bravo.testnet", "echo.testnet"];
    const signups = [{ ...b.signup(), at: 2 }, { ...a.signup(), at: 1 }, { ...c.signup(), at: 3 }, { ...d.signup(), at: 4 }, { ...e.signup(), at: 5 }, { ...b.signup(), at: 6 }];
    for (const seed of ["seed-one", "seed-two", "seed-three"]) {
      const want = [...valid].sort((x, y) => (drawKey(seed, x) < drawKey(seed, y) ? -1 : 1)).slice(0, 2);
      const got = await agentGuests(chainOf(w), net, SLOT, signups, 2, seed);
      expect(got.accounts).toEqual(want);
    }
    // Some seed puts the last to sign up first: arrival buys nothing.
    const late = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].find((seed) => drawKey(seed, "echo.testnet") < drawKey(seed, "alpha.testnet") && drawKey(seed, "echo.testnet") < drawKey(seed, "bravo.testnet"));
    expect((await agentGuests(chainOf(w), net, SLOT, signups, 1, late!)).accounts).toEqual(["echo.testnet"]);
  });

  it("turns away a sign-up of another round, a poor account, a function-call key, an unknown account or one of ours", async () => {
    const ghost = agent("ghost.testnet");
    const ours = agent(net.house);
    w.keys[`${net.house} ${ours.public_key}`] = "FullAccess";
    const got = await agentGuests(chainOf(w), net, SLOT, [a.signup(SLOT - 86_400_000), c.signup(), d.signup(), ghost.signup(), ours.signup()], 5);
    expect(got.accounts).toEqual([]);
    expect([...got.notes].sort()).toEqual([
      expect.stringMatching(/^alpha\.testnet: turned away, slot: the round being filled is 2026-11-12 18:00 UTC/),
      "charlie.testnet: turned away, holds less than 0.05 NEAR, too little for its calls",
      "delta.testnet: turned away, the key that signed is not a full-access key of the account",
      "ghost.testnet: turned away, no such account",
      `${net.house}: turned away, one of the arena's own accounts`,
    ].sort());
  });

  it("reads the sign-ups for this slot from the site, and a site that does not answer lets no agent in", async () => {
    const site = "https://maskwars.example";
    const ok = (async (url: string) => new Response(JSON.stringify({ slot: SLOT, signups: [a.signup()] }), { status: url.endsWith(`slot=${SLOT}`) ? 200 : 404 })) as unknown as typeof fetch;
    expect((await fetchSignups(site, SLOT, ok)).signups.map((s) => s.account)).toEqual(["alpha.testnet"]);
    const down = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    expect(await fetchSignups(site, SLOT, down)).toEqual({ signups: [], note: `${site}/api/round/guests?slot=${SLOT} did not answer (fetch failed): no agent today` });
    const other = (async () => new Response(JSON.stringify({ slot: SLOT + 1, signups: [a.signup()] }))) as unknown as typeof fetch;
    expect((await fetchSignups(site, SLOT, other)).signups).toEqual([]);

    const all = await pickGuests({ chain: chainOf({ ...w, masks: [mask("kira")] }), net, slot: SLOT, site, get: ok });
    expect([all.masks, all.agents]).toEqual([[`kira.${net.factory}`], ["alpha.testnet"]]);
    expect(all.notes).toContain('agents drawn by block 7 (BLOCKHASH): sha256("<block hash>:<account>"), lowest first');
  });
});
