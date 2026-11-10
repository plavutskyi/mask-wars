import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  armHumans,
  CLAIM_GRACE_NS,
  costsFor,
  costYocto,
  humanKey,
  humanName,
  humanRoundKeys,
  humansOf,
  keeperKey,
  settleHumans,
  stillInPlay,
  type FactoryMask,
  type KeeperOptions,
} from "../src/keeper.ts";
import { base58Encode, type Chain } from "../src/near-tx.ts";
// The owner's scripts: the keeper's key they put on chain and the round they open must be the ones the race uses.
import { humanRound, MARGIN, MIN_LOOT, OURS, SEALS } from "../../../scripts/testnet/human-round.mjs";
import { humanPublicKey, keeperPublicKey } from "../../../scripts/testnet/keeper-key.mjs";

const FACTORY = "masks.tinygif8324.testnet";
const BOUNTY = "bounty.tinygif8324.testnet";
const KEEPER = "tinygif8324.testnet";
const ID = "h0001-2026-11-09";
const SAFE = "h0001.tinygif8324.testnet";
const KIRA = `kira.${FACTORY}`;
const LENA = `lena.${FACTORY}`;
const NOVA = "nova.tinygif8324.testnet";
const SEED = "0b".repeat(32);
const MINUTE = 60_000_000_000n;
const NEAR = 10n ** 24n;

/** A signed transaction read back: signer, key, receiver, method, args, deposit. */
function readTx(base64: string) {
  const b = Buffer.from(base64, "base64");
  let at = 0;
  const str = () => {
    const n = b.readUInt32LE(at);
    at += 4;
    return b.subarray(at, (at += n)).toString("utf8");
  };
  const signer = str();
  const pk = `ed25519:${base58Encode(b.subarray(at + 1, (at += 33)))}`;
  at += 8;
  const receiver = str();
  at += 32 + 4 + 1;
  const method = str();
  const args = JSON.parse(str()) as Record<string, string | string[]>;
  at += 8;
  const deposit = b.readBigUInt64LE(at) + (b.readBigUInt64LE(at + 8) << 64n);
  return { signer, pk, receiver, method, args, deposit };
}

/** testnet as the keeper sees it: the bounty contract's round, the factory's masks, the keys on each mask. */
class Testnet implements Chain {
  readonly sent: ReturnType<typeof readTx>[] = [];
  now = 10n * MINUTE;
  commitUntil = 30n * MINUTE;
  revealUntil = 60n * MINUTE;
  deadline = 120n * MINUTE;
  owner = KEEPER;
  state = "open";
  seals: { mask: string; state: string }[] = [];
  judging: string[] = [];
  masks: Record<string, FactoryMask> = {
    kira: mask("kira", "ready"),
    lena: mask("lena", "paused"),
  };
  keys: Record<string, string[]> = {};
  /** What the factory's on_round says about this round. */
  refuses: string | null = null;

  async rpc(method: string, p: Record<string, string>): Promise<unknown> {
    if (method === "block") return { header: { timestamp_nanosec: this.now.toString() } };
    if (method === "query" && p.request_type === "view_access_key_list") {
      return { keys: (this.keys[p.account_id!] ?? []).map((public_key) => ({ public_key })) };
    }
    if (method === "query" && p.request_type === "view_access_key") {
      return { nonce: 1, block_hash: base58Encode(Buffer.alloc(32, 3)) };
    }
    if (method === "query") {
      const args = JSON.parse(Buffer.from(p.args_base64!, "base64").toString()) as Record<string, string>;
      const value = (() => {
        if (p.account_id === BOUNTY && p.method_name === "get_safe") return { safe: SAFE, masks: [NOVA, KIRA, LENA], min_loot: NEAR.toString() };
        if (p.account_id === BOUNTY && p.method_name === "get_round")
          return { commit_until: this.commitUntil.toString(), reveal_until: this.revealUntil.toString(), seals: this.seals, judging: this.judging };
        if (p.account_id === BOUNTY && p.method_name === "get") {
          return { owner: this.owner, deadline_ns: this.deadline.toString(), status: { state: this.state } };
        }
        if (p.account_id === FACTORY && p.method_name === "get_mask") return this.masks[args.name!] ?? null;
        if (p.account_id === FACTORY && p.method_name === "budget") return this.masks[args.name!]?.state === "ready" ? "50000000000000000000000" : "0";
        throw new Error(`no view ${p.account_id}.${p.method_name}`);
      })();
      return { result: [...Buffer.from(JSON.stringify(value))] };
    }
    if (method === "send_tx") {
      const tx = readTx(p.signed_tx_base64!);
      this.sent.push(tx);
      const ok = (v: unknown, logs: string[] = []) => ({
        status: { SuccessValue: Buffer.from(JSON.stringify(v)).toString("base64") },
        receipts_outcome: [{ outcome: { status: "Unknown", logs } }],
      });
      const m = this.masks[tx.args.name as string]!;
      if (tx.method === "arm") {
        const account = `${m.name}.${FACTORY}`;
        if (this.refuses) {
          return ok(false, [`arming ${m.name} for ${ID} refused: ${this.refuses}. The hold goes back to the tank`]);
        }
        this.masks[m.name] = { ...m, state: "racing", race: { race: tx.args.race as string, held: "50000000000000000000000", armed_ns: "1", keys: [tx.args.arena_key as string, tx.args.target_key as string] } };
        this.keys[account] = [tx.args.arena_key as string, tx.args.target_key as string];
        return ok(true);
      }
      if (tx.method === "settle") {
        this.masks[m.name] = { ...m, state: "ready", race: null };
        this.keys[`${m.name}.${FACTORY}`] = [];
        return ok({ ...m, state: "ready" });
      }
    }
    throw new Error(`no rpc ${method}`);
  }
}

function mask(name: string, state: FactoryMask["state"]): FactoryMask {
  return {
    name,
    account: `${name}.${FACTORY}`,
    owner: "ann.testnet",
    look: "porcelain",
    model: "Qwen/Qwen3.8-27B",
    style: "cunning",
    strategy: true,
    born_ns: "1",
    fuel: (2n * NEAR).toString(),
    brain: (16n * NEAR / 10n).toString(),
    spent: "0",
    race_limit: "50000000000000000000000",
    races: 0,
    state,
    race: null,
    code: "aa",
  };
}

const keeper = (chain: Testnet, lines: string[] = []): KeeperOptions => ({
  chain,
  factory: FACTORY,
  keeper: KEEPER,
  seed: SEED,
  bountyContract: BOUNTY,
  bountyId: ID,
  team: [KEEPER],
  log: (l) => lines.push(l),
});

describe("the keeper's keys", () => {
  it("are the keys the sandbox round signs with (the Rust test reads the same vector)", () => {
    const v = JSON.parse(readFileSync(new URL("./human-keys.json", import.meta.url), "utf8")) as {
      seed: string;
      mask: string;
      round: string;
      keys: Record<string, string>;
      keeper: { factory: string; key: string };
    };
    for (const [receiver, key] of Object.entries(v.keys)) expect(humanKey(v.seed, v.mask, v.round, receiver).publicKeyText).toBe(key);
    expect(keeperKey(v.seed, v.keeper.factory).publicKeyText).toBe(v.keeper.key);
  });

  it("are new for every round, every mask and every receiver: a key that leaked dies with its round", () => {
    const all = [
      humanKey(SEED, KIRA, ID, BOUNTY),
      humanKey(SEED, KIRA, ID, SAFE),
      humanKey(SEED, KIRA, "h0002-2026-11-10", BOUNTY),
      humanKey(SEED, LENA, ID, BOUNTY),
      keeperKey(SEED, FACTORY),
    ].map((k) => k.publicKeyText);
    expect(new Set(all).size).toBe(all.length);
    const { safeKey, claimKey } = humanRoundKeys(SEED, KIRA, ID, SAFE, BOUNTY);
    expect([safeKey.publicKeyText, claimKey.publicKeyText]).toEqual([all[1], all[0]]);
    expect(() => humanKey("not hex", KIRA, ID, BOUNTY)).toThrow("KEEPER_SEED");
  });

  it("knows a person's mask by its account: a direct sub-account of the factory with a mask's name", () => {
    expect(humanName(KIRA, FACTORY)).toBe("kira");
    expect(humanName(NOVA, FACTORY)).toBeNull();
    expect(humanName(`a.kira.${FACTORY}`, FACTORY)).toBeNull();
    expect(humanName(`Kira.${FACTORY}`, FACTORY)).toBeNull();
    expect(humanName(`kira.evil${FACTORY}`, FACTORY)).toBeNull();
    expect(humansOf([NOVA, KIRA, LENA], FACTORY).map((h) => h.name)).toEqual(["kira", "lena"]);
  });

  it("turns the mind's dollars into NEAR rounded down", () => {
    expect(costYocto(0.01, 2.5)).toBe(4n * 10n ** 21n);
    expect(costYocto(0, 2.5)).toBe(0n);
    expect(costYocto(0.01, 0)).toBe(0n);
    expect(costYocto(-1, 2.5)).toBe(0n);
    expect(costYocto(1 / 3, 3)).toBeLessThanOrEqual(NEAR / 9n);
  });
});

describe("the keeper arms the people's masks of a round", () => {
  it("arms each ready mask with this round's keys, signed with its own function-call key and no NEAR", async () => {
    const chain = new Testnet();
    const lines: string[] = [];
    const armed = await armHumans(keeper(chain, lines));
    expect(armed.map((a) => [a.name, a.armed])).toEqual([
      ["kira", true],
      ["lena", false],
    ]);
    expect(armed[1]!.note).toBe("the mask is paused");
    expect(chain.sent).toHaveLength(1);
    const tx = chain.sent[0]!;
    expect([tx.signer, tx.pk, tx.receiver, tx.method, tx.deposit]).toEqual([KEEPER, keeperKey(SEED, FACTORY).publicKeyText, FACTORY, "arm", 0n]);
    expect(tx.args).toEqual({
      name: "kira",
      race: ID,
      arena_key: humanKey(SEED, KIRA, ID, BOUNTY).publicKeyText,
      target: SAFE,
      target_key: humanKey(SEED, KIRA, ID, SAFE).publicKeyText,
      target_methods: ["set_owner", "sweep"],
    });
    expect(armed[0]).toMatchObject({ model: "Qwen/Qwen3.8-27B", style: "cunning" });
  });

  it("arms a mask once: a second run sees it armed for this round", async () => {
    const chain = new Testnet();
    await armHumans(keeper(chain));
    const again = await armHumans(keeper(chain));
    expect(chain.sent).toHaveLength(1);
    expect(again[0]).toMatchObject({ name: "kira", armed: true, note: "already armed for this round" });
  });

  it("counts a mask as armed only when the factory says so and both keys are on it", async () => {
    const chain = new Testnet();
    chain.refuses = "the mask is not on the round's list";
    const armed = await armHumans(keeper(chain));
    expect(armed[0]).toMatchObject({ name: "kira", armed: false });
    expect(armed[0]!.note).toContain("the mask is not on the round's list");
  });

  it("arms no mask for a round outside our team, or once the commit window closed", async () => {
    const theirs = new Testnet();
    theirs.owner = "someone.testnet";
    await expect(armHumans(keeper(theirs))).rejects.toThrow("not by our team");
    const late = new Testnet();
    late.now = late.commitUntil;
    await expect(armHumans(keeper(late))).rejects.toThrow("the commit window is closed");
    const refunded = new Testnet();
    refunded.state = "refunded";
    await expect(armHumans(keeper(refunded))).rejects.toThrow("refunded, not open");
    expect([...theirs.sent, ...late.sent, ...refunded.sent]).toEqual([]);
  });
});

describe("the keeper settles what the minds spent", () => {
  it("settles each armed mask for what its mind spent, never more than the race held, and leaves a mask in play armed", async () => {
    const chain = new Testnet();
    chain.masks.lena = mask("lena", "ready");
    await armHumans(keeper(chain));
    const costs = new Map([
      [KIRA, 12n * 10n ** 21n],
      [LENA, 9n * NEAR],
    ]);
    // LENA's sealed plan is still in play: it keeps its keys for the reveal and the claim.
    const settled = await settleHumans(keeper(chain), costs, new Set([LENA]));
    expect(settled.map((s) => [s.name, s.settled, s.spent])).toEqual([
      ["kira", true, (12n * 10n ** 21n).toString()],
      ["lena", false, "0"],
    ]);
    const settle = chain.sent.filter((t) => t.method === "settle");
    expect(settle.map((t) => t.args)).toEqual([{ name: "kira", race: ID, spent: (12n * 10n ** 21n).toString() }]);
    // Once LENA is out of play, the most its mind pays is what the race held.
    const later = await settleHumans(keeper(chain), costs);
    expect(later.find((s) => s.name === "lena")).toMatchObject({ settled: true, spent: "50000000000000000000000" });
    expect(chain.keys[KIRA]).toEqual([]);
  });

  /**
   * The review's finding 5: the bounty contract takes a revealed or refused seal's claim until 12 hours after the
   * deadline, but the keeper took the mask's keys as soon as the reveal window closed, so a person's mask whose drain
   * the judge refused once, or whose claim had not gone in yet, could never claim its win.
   */
  it("keeps the keys of every mask that sealed while the bounty would still take its claim: open, and the grace not over", async () => {
    const chain = new Testnet();
    chain.now = 40n * MINUTE;
    chain.seals = [
      { mask: KIRA, state: "revealed" },
      { mask: LENA, state: "refused" },
    ];
    chain.judging = [NOVA];
    const inPlay = async () => [...(await stillInPlay(keeper(chain)))].sort();
    expect(await inPlay()).toEqual([KIRA, LENA, NOVA].sort());
    // Past the reveal window, past the deadline: KIRA may still claim, LENA may claim again.
    chain.judging = [];
    for (const now of [chain.revealUntil, chain.deadline, chain.deadline + CLAIM_GRACE_NS - 1n]) {
      chain.now = now;
      expect(await inPlay(), `at ${now}`).toEqual([KIRA, LENA].sort());
    }
    // The claim grace is over: no claim can come, the keys go.
    chain.now = chain.deadline + CLAIM_GRACE_NS;
    expect(await inPlay()).toEqual([]);
    // A claim still with the judge keeps its keys until the judge answers.
    chain.judging = [KIRA];
    expect(await inPlay()).toEqual([KIRA]);
    // Someone won and was paid: nobody else can claim, whatever the time.
    chain.judging = [];
    chain.now = 40n * MINUTE;
    chain.state = "drained";
    chain.seals = [{ mask: KIRA, state: "confirmed" }];
    expect(await inPlay()).toEqual([]);
    // A bounty from before per-claim records, `judging`, is still open to claims.
    chain.state = "judging";
    expect(await inPlay()).toEqual([KIRA]);
  });

  /** The review's finding 7: a costs file of another round would charge its masks for minds that ran elsewhere. */
  it("settles with the costs of this very round only", () => {
    const file = (bounty: unknown) => JSON.stringify({ bounty, costs: { [KIRA]: { usd: 0.0021, calls: 5 }, [LENA]: { usd: -1, calls: 1 } } });
    expect(costsFor(file(ID), ID)).toEqual(new Map([[KIRA, 0.0021], [LENA, 0]]));
    expect(() => costsFor(file("human-0002"), ID)).toThrow(`the costs file is of human-0002, not of ${ID}: nothing settled`);
    // The race job's old file named no round.
    expect(() => costsFor(JSON.stringify({ [KIRA]: { usd: 0.0021, calls: 5 } }), ID)).toThrow("names no round");
    expect(() => costsFor(file(7), ID)).toThrow("names no round");
    expect(() => costsFor("{", ID)).toThrow("not JSON");
    // No file at all: the Keeper workflow without a run settles at no cost.
    expect(costsFor("", ID)).toEqual(new Map());
  });
});


describe("the owner's scripts", () => {
  it("put on chain exactly the keeper's key the keeper signs with, and derive the masks' keys the same way", () => {
    expect(keeperPublicKey(SEED, FACTORY)).toBe(keeperKey(SEED, FACTORY).publicKeyText);
    expect(humanPublicKey(SEED, KIRA, ID, SAFE)).toBe(humanKey(SEED, KIRA, ID, SAFE).publicKeyText);
  });

  it("open a round with our masks and every person's mask that can race, its safe funded for the one plan a run seals", () => {
    const people = [
      { account: KIRA, state: "ready", brain: "1600000000000000000000000" },
      { account: LENA, state: "paused", brain: "1600000000000000000000000" },
      { account: `mira.${FACTORY}`, state: "ready", brain: "0" },
      { account: `vera.${FACTORY}`, state: "racing", brain: "1600000000000000000000000" },
      { account: `nora.${FACTORY}`, state: "ready", brain: "1" },
    ];
    const r = humanRound({ n: 7, people });
    expect([r.id, r.safe]).toEqual(["human-0007", "h0007.tinygif8324.testnet"]);
    expect(r.masks).toEqual([...OURS, KIRA, `nora.${FACTORY}`]);
    expect(r.init).toEqual({ owner: r.safe, masks: r.masks, arbiter: BOUNTY, team: KEEPER });
    expect(r.open).toMatchObject({ id: r.id, safe: r.safe, min_loot: MIN_LOOT.toString(), hours: 24, commit_minutes: 60 });
    // The bounty contract asks for 3 minutes for each mask's turn and 3 more.
    expect(r.open.reveal_minutes).toBeGreaterThanOrEqual(3 * (r.masks.length + 1));
    expect([r.safeNear, r.deposit]).toEqual(["2.20 NEAR", "0.500 NEAR"]);
  });

  /**
   * The review's finding 4: the safe was funded with min_loot for every mask, but a run seals one plan, which takes
   * exactly min_loot, and a won round's safe gives its team nothing back. With five masks 2.1 NEAR stayed in it for
   * good, with sixteen 7.6. Now, whatever the number of masks, a win leaves only the margin behind.
   */
  it("a won round leaves only the margin in its safe, however many masks it has", () => {
    const near = (text: string) => BigInt(Math.round(Number.parseFloat(text) * 100)) * 10n ** 22n;
    const code = 16n * 10n ** 23n;
    for (const n of [1, 2, 5, 13]) {
      const people = Array.from({ length: n }, (_, i) => ({ account: `m${String(i).padStart(3, "0")}.${FACTORY}`, state: "ready", brain: "1" }));
      const r = humanRound({ n: 1, people });
      const left = near(r.safeNear) - code - SEALS * MIN_LOOT;
      expect(left, `${r.masks.length} masks`).toBe(MARGIN);
      expect(left).toBeLessThan(MIN_LOOT);
    }
    expect(SEALS).toBe(1n);
  });

  it("caps a round at 16 masks and opens none without a person's mask ready", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ account: `m${String(i).padStart(3, "0")}.${FACTORY}`, state: "ready", brain: "1" }));
    const r = humanRound({ n: 1, people: many });
    expect(r.masks).toHaveLength(16);
    expect(r.open.reveal_minutes).toBe(60);
    expect(() => humanRound({ n: 1, people: [] })).toThrow("no person's mask is ready");
    expect(() => humanRound({ n: 0, people: many })).toThrow("n:");
  });
});
