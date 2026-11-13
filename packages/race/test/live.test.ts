import { describe, expect, it } from "vitest";
import {
  accountMap,
  guardCall,
  playLive,
  resumeLive,
  SAFE_CALL_TGAS,
  sealLive,
  sweepRuleOf,
  SWEEP_MARGIN,
  translateArgs,
  type RoundSeal,
} from "../src/live.ts";
import { base58Encode, NearKey, type Chain } from "../src/near-tx.ts";
import { MAX_GAS_TGAS, Plan } from "../src/plan.ts";
import { sealHash, sealSalt } from "../src/seal.ts";
import { challenge, planText } from "./fixtures.ts";

const SAFE = "safe-0002.tinygif8324.testnet";
const NOVA = "nova.tinygif8324.testnet";
const BOUNTY = "tinygif8324.testnet";
const TEAM = "team.tinygif8324.testnet";
const ID = "race-0004";
const NEAR = 10n ** 24n;
const MINUTE = 60_000_000_000n;
const key = (n: number) => new NearKey(`ed25519:${base58Encode(Buffer.alloc(32, n))}`);
const SAFE_KEY = key(1);
const CLAIM_KEY = key(2);

/** A signed transaction read back: who signed with which key, to whom, what. */
function readTx(base64: string) {
  const b = Buffer.from(base64, "base64");
  let at = 0;
  const str = () => {
    const n = b.readUInt32LE(at);
    at += 4;
    return b.subarray(at, (at += n)).toString("utf8");
  };
  const signer = str();
  const pk = base58Encode(b.subarray(at + 1, (at += 33)));
  at += 8;
  const receiver = str();
  at += 32 + 4 + 1;
  const method = str();
  const args = JSON.parse(str()) as Record<string, unknown>;
  const gas = b.readBigUInt64LE(at);
  at += 8;
  const deposit = b.readBigUInt64LE(at);
  return { signer, pk: `ed25519:${pk}`, receiver, method, args, gas, deposit };
}

/**
 * testnet as the mask sees it: a sealed round on the bounty contract, a safe locked to it with `available` NEAR, and a
 * clock. The contract's part checks the reveal against the seal the way the real one does; the safe's part keeps the
 * turns: until `othersTurnUntil` another mask has the safe to itself, and until `earlierUntil` an earlier seal goes
 * first. With `viewLags` the safe's `waits_for` does not see another mask's turn yet.
 */
class FakeTestnet implements Chain {
  readonly sent: ReturnType<typeof readTx>[] = [];
  owner = SAFE;
  available = 2n * NEAR;
  status = "open";
  now = 10n * MINUTE;
  commitUntil = 30n * MINUTE;
  seal: (RoundSeal & { salt?: string }) | null = null;
  /** The safe's lock, as the bounty contract armed it; `null` for a safe that is not locked to the round. */
  lock: { arbiter: string; bounty: string; opens_ns: string } | null = { arbiter: BOUNTY, bounty: ID, opens_ns: "" };
  othersTurnUntil = 0n;
  earlierUntil = 0n;
  /** Until then the mask missed its slot and a later seal plays first. */
  missedUntil = 0n;
  viewLags = false;
  /** Who opened the bounty, and the team the safe was deployed for. */
  bountyOwner = TEAM;
  safeTeam: string | null = TEAM;
  /** What the mask's key on the safe still pays for; `null`: no limit. */
  allowance: bigint | null = NEAR / 2n;
  readonly judge: "pays" | "refuses";
  constructor(judge: "pays" | "refuses" = "pays") {
    this.judge = judge;
  }

  async rpc(method: string, p: Record<string, string>): Promise<unknown> {
    if (method === "block") return { header: { timestamp_nanosec: this.now.toString() } };
    if (method === "query" && p.request_type === "view_access_key") {
      const permission = { FunctionCall: { allowance: this.allowance?.toString() ?? null, receiver_id: SAFE, method_names: [] } };
      return { nonce: 7, block_hash: base58Encode(Buffer.alloc(32, 9)), permission };
    }
    if (method === "query") {
      const args = JSON.parse(Buffer.from(p.args_base64!, "base64").toString()) as Record<string, string>;
      const value = (() => {
        if (p.account_id === BOUNTY && p.method_name === "get_safe")
          return args.id === ID ? { safe: SAFE, masks: [NOVA, "onyx.tinygif8324.testnet"], min_loot: NEAR.toString() } : null;
        if (p.account_id === BOUNTY && p.method_name === "get_round")
          return {
            commit_until: this.commitUntil.toString(),
            reveal_until: (90n * MINUTE).toString(),
            deadline_ns: (100n * MINUTE).toString(),
            seals: this.seal ? [this.seal] : [],
            judging: [],
          };
        if (p.account_id === BOUNTY && p.method_name === "get") return { owner: this.bountyOwner, status: { state: this.status } };
        if (p.account_id === SAFE && p.method_name === "team") return this.safeTeam;
        if (p.account_id === SAFE && p.method_name === "waits_for") return this.waitsFor(true);
        if (p.account_id === SAFE && p.method_name === "get_owner") return this.owner;
        if (p.account_id === SAFE && p.method_name === "available") return this.available.toString();
        if (p.account_id === SAFE && p.method_name === "get_round")
          return this.lock && { ...this.lock, opens_ns: this.lock.opens_ns || this.commitUntil.toString() };
        if (p.account_id === SAFE && p.method_name === "get_turn")
          return { mask: "onyx.tinygif8324.testnet", until_ns: this.othersTurnUntil.toString() };
        throw new Error(`no view ${p.account_id}.${p.method_name}`);
      })();
      return { result: [...Buffer.from(JSON.stringify(value))] };
    }
    if (method === "send_tx") {
      const tx = readTx(p.signed_tx_base64!);
      this.sent.push(tx);
      const fail = (error: string) => ({ status: { Failure: { error } }, receipts_outcome: [] });
      const a = tx.args as Record<string, string>;
      if (tx.method === "commit") {
        if (this.now >= this.commitUntil) return fail("the commit window is closed");
        this.seal = { mask: tx.signer, hash: a.hash!, seq: 0, state: "sealed", plan: null, txs: [] };
      }
      if (tx.method === "set_owner" || tx.method === "sweep") {
        if (this.now < this.commitUntil) throw new Error("a sealed plan is played only after the window");
        const why = this.waitsFor(false);
        if (why) return fail(why);
      }
      if (tx.method === "set_owner") this.owner = a.new_owner!;
      if (tx.method === "sweep") {
        if (this.owner !== tx.signer) return fail("owner only");
        if (BigInt(a.amount!) > this.available) return fail("not that much in the safe");
        this.available -= BigInt(a.amount!);
      }
      if (tx.method === "reveal") {
        const { plan, salt } = tx.args as { plan: string; salt: string; txs: string[] };
        if (!this.seal || sealHash(ID, tx.signer, salt, plan) !== this.seal.hash) return fail("the plan does not match the seal");
        this.seal = { ...this.seal, state: "revealed", plan, salt, txs: (tx.args as { txs: string[] }).txs };
      }
      if (tx.method === "claim_drain") {
        this.status = this.judge === "pays" ? "drained" : "open";
        this.seal = { ...this.seal!, state: this.judge === "pays" ? "confirmed" : "refused" };
        // Waiting only for INCLUDED_FINAL, testnet answers with a bare word.
        return { final_execution_status: "INCLUDED_FINAL", status: "Started" };
      }
      return { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: "Unknown" } }] };
    }
    throw new Error(`no rpc ${method}`);
  }

  waitsFor(asView: boolean): string | null {
    if (this.now < this.othersTurnUntil && !(asView && this.viewLags)) return "another mask has its turn on the safe";
    if (this.now < this.earlierUntil) return "an earlier seal goes first";
    if (this.now < this.missedUntil) return "this seal missed its slot: the later seals play first";
    return null;
  }
}

const live = (chain: FakeTestnet, lines: string[]) => ({
  chain,
  bountyContract: BOUNTY,
  bountyId: ID,
  mask: NOVA,
  safeKey: SAFE_KEY,
  claimKey: CLAIM_KEY,
  log: (l: string) => lines.push(l),
  // Waiting moves the clock: ten seconds per nap.
  sleep: async (ms: number) => {
    chain.now += BigInt(ms) * 1_000_000n;
  },
});

async function round(judge: "pays" | "refuses" = "pays", kind: "breach" | "miss" = "breach", steps?: unknown[]) {
  const chain = new FakeTestnet(judge);
  const lines: string[] = [];
  const plan = steps ? Plan.parse({ steps }) : Plan.parse(JSON.parse(await planText("live-safe", kind)));
  const sealed = await sealLive({ ...live(chain, lines), challenge: await challenge("live-safe"), plan, salt: "salt-0123456789abcdef" });
  const sealedAt = chain.sent.length;
  const result = await playLive(live(chain, lines), sealed);
  return { chain, sealed, sealedAt, result, lines };
}

describe("a sealed round on testnet", () => {
  it("seals the plan in the window, plays it after, reveals it and claims with the mask's other key", async () => {
    const { chain, sealed, result } = await round();
    expect(chain.sent.map((t) => [t.method, t.signer, t.receiver, t.pk])).toEqual([
      ["commit", NOVA, BOUNTY, CLAIM_KEY.publicKeyText],
      ["set_owner", NOVA, SAFE, SAFE_KEY.publicKeyText],
      ["sweep", NOVA, SAFE, SAFE_KEY.publicKeyText],
      ["reveal", NOVA, BOUNTY, CLAIM_KEY.publicKeyText],
      ["claim_drain", NOVA, BOUNTY, CLAIM_KEY.publicKeyText],
    ]);
    expect(chain.sent.every((t) => t.deposit === 0n)).toBe(true);
    // Only the hash goes on chain in the window; it is the hash of exactly the calls played later.
    expect(Object.keys(chain.sent[0]!.args)).toEqual(["id", "hash"]);
    expect(chain.sent[0]!.args.hash).toBe(sealHash(ID, NOVA, sealed.salt, sealed.plan));
    expect(JSON.stringify(chain.sent.slice(1, 3).map((t) => ({ method: t.method, args: t.args })))).toBe(sealed.plan);
    // The sandbox plan sweeps 3 NEAR; the real safe has 2 to give, and the mask leaves 0.03 NEAR of them for the
    // storage the turns before its own may add.
    expect(chain.sent[2]!.args).toEqual({ to: NOVA, amount: (197n * NEAR / 100n).toString() });
    const [owner, sweep] = result.calls.map((c) => c.hash);
    expect(chain.sent[3]!.args).toEqual({ id: ID, plan: sealed.plan, salt: sealed.salt, txs: [owner, sweep] });
    expect(chain.sent[4]!.args).toEqual({ id: ID, tx_hash: sweep });
    expect(result).toMatchObject({ status: "drained", seal: "confirmed", drainTx: sweep });
  });

  it("waits for the commit window to close before it touches the safe", async () => {
    const { chain, sealedAt, lines } = await round();
    expect(sealedAt).toBe(1);
    expect(chain.now).toBeGreaterThanOrEqual(chain.commitUntil);
    expect(lines.some((l) => l.includes("the commit window is closed"))).toBe(true);
  });

  it("says when the judge did not pay", async () => {
    const { result } = await round("refuses");
    expect(result.claimTx).not.toBeNull();
    expect(result).toMatchObject({ status: "open", seal: "refused" });
  });

  it("will not seal a plan that never sweeps", async () => {
    await expect(round("pays", "breach", [{ kind: "call", method: "set_owner", args: { new_owner: "attacker.test.near" } }])).rejects.toThrow(
      "never sweeps",
    );
  });

  it("plays a safe of the library with a seed's key: any method, and the plan's last call is the drain it claims", async () => {
    const chain = new FakeTestnet();
    const lines: string[] = [];
    const plan = Plan.parse({
      steps: [{ kind: "call", method: "claim_for", args: { member: "attacker.test.near", amount: (2n * NEAR).toString() } }],
    });
    const o = { ...live(chain, lines), challenge: await challenge("pause-bypass"), plan, salt: "salt-0123456789abcdef" };
    // An old key on the safe reaches only set_owner and sweep: nothing of this plan.
    await expect(sealLive(o)).rejects.toThrow("never sweeps");
    const sealed = await sealLive({ ...o, safeMethods: null });
    expect(sealed.calls).toEqual([{ method: "claim_for", args: { member: NOVA, amount: (2n * NEAR).toString() } }]);
    const result = await playLive(live(chain, lines), sealed);
    expect(chain.sent.map((t) => t.method)).toEqual(["commit", "claim_for", "reveal", "claim_drain"]);
    expect(chain.sent[3]!.args).toEqual({ id: ID, tx_hash: result.calls[0]!.hash });
    expect(result).toMatchObject({ status: "drained", drainTx: result.calls[0]!.hash });
  });

  // The vault's other kinds (live-safe's `variant`): the plan is that kind's own calls, with no sweep in it. The mask
  // plays it with its seed's key as the sandbox found it: the amounts stay, since such a vault pays as much of them as
  // it holds, and the plan's last call is the drain it claims.
  for (const [kind, methods] of [
    ["limit", ["request_exit", "request_exit", "withdraw"]],
    ["pause", ["book", "cash_out"]],
  ] as const) {
    it(`plays a vault of the ${kind} kind: the sandbox plan as it is, and the last call is the drain`, async () => {
      const chain = new FakeTestnet();
      chain.available = NEAR / 4n;
      const lines: string[] = [];
      const plan = Plan.parse(JSON.parse(await planText(`live-safe.${kind}`, "breach")));
      const o = { ...live(chain, lines), challenge: await challenge("live-safe", kind), plan, salt: "salt-0123456789abcdef", safeMethods: null };
      const sealed = await sealLive(o);
      // The view is dropped, the calls are the plan's own, with the amounts the sandbox copy was asked for.
      const calls = plan.steps.filter((s) => s.kind === "call").map((s) => ({ method: s.method, args: s.args ?? {} }));
      expect(sealed.calls).toEqual(calls);
      expect(sealed.calls.map((c) => c.method)).toEqual([...methods]);
      const result = await playLive(live(chain, lines), sealed);
      expect(chain.sent.map((t) => t.method)).toEqual(["commit", ...methods, "reveal", "claim_drain"]);
      for (const t of chain.sent.slice(1, 1 + methods.length)) {
        expect(t).toMatchObject({ signer: NOVA, pk: SAFE_KEY.publicKeyText, receiver: SAFE, deposit: 0n, gas: BigInt(SAFE_CALL_TGAS) * 10n ** 12n });
      }
      expect(chain.sent.at(-1)!.args).toEqual({ id: ID, tx_hash: result.calls.at(-1)!.hash });
      expect(result).toMatchObject({ status: "drained", drainTx: result.calls.at(-1)!.hash });
    });
  }

  it("a call of another kind's plan may name only the mask, the vault and amounts, as any call", async () => {
    const chain = new FakeTestnet();
    const plan = Plan.parse({ steps: [{ kind: "call", method: "book", args: { amount: "1", to: "thief.testnet" } }, { kind: "call", method: "cash_out" }] });
    const o = { ...live(chain, []), challenge: await challenge("live-safe", "pause"), plan, salt: "salt-0123456789abcdef", safeMethods: null };
    await expect(sealLive(o)).rejects.toThrow("names an account outside the round");
    const paid = Plan.parse({ steps: [{ kind: "call", method: "book", args: { amount: "1" }, deposit: "1" }] });
    await expect(sealLive({ ...o, plan: paid })).rejects.toThrow("attaches no NEAR");
  });

  // The first live round with a model's own plan (race-0004, 10.11): ONYX took the safe, swept, and swept again for
  // the rest. Each sweep was cut to the whole of what the safe had, the second failed on chain, and the run stopped
  // before the reveal: a drained safe and no bounty.
  it("a plan with two sweeps never asks the safe for the same NEAR twice", async () => {
    const { chain, result, lines } = await round("pays", "breach", [
      { kind: "call", method: "set_owner", args: { new_owner: "attacker.test.near" }, gas_tgas: 30 },
      { kind: "call", method: "sweep", args: { to: "attacker.test.near", amount: (3n * NEAR).toString() }, gas_tgas: 30 },
      { kind: "call", method: "sweep", args: { to: "attacker.test.near", amount: NEAR.toString() }, gas_tgas: 30 },
    ]);
    // The safe has 2 NEAR to give: the first sweep takes it less the margin, and nothing is left for a second one.
    expect(chain.sent.map((t) => t.method)).toEqual(["commit", "set_owner", "sweep", "reveal", "claim_drain"]);
    expect(chain.sent[2]!.args).toEqual({ to: NOVA, amount: (197n * NEAR / 100n).toString() });
    expect(lines).toContain("sweep      skip: an earlier sweep of the plan leaves nothing to take");
    expect(result.status).toBe("drained");
  });

  it("a plan that sweeps in two parts keeps both while the safe can pay them", async () => {
    const { chain } = await round("pays", "breach", [
      { kind: "call", method: "set_owner", args: { new_owner: "attacker.test.near" }, gas_tgas: 30 },
      { kind: "call", method: "sweep", args: { to: "attacker.test.near", amount: NEAR.toString() }, gas_tgas: 30 },
      { kind: "call", method: "sweep", args: { to: "attacker.test.near", amount: (3n * NEAR).toString() }, gas_tgas: 30 },
    ]);
    expect(chain.sent.filter((t) => t.method === "sweep").map((t) => t.args.amount)).toEqual([
      NEAR.toString(),
      (97n * NEAR / 100n).toString(),
    ]);
  });

  it("a mask that missed its slot waits for the later seals, but never past the reveal window", async () => {
    // The safe gives each seal a slot; a seal whose job came late plays once the later seals have had theirs.
    for (const [missedUntil, played] of [
      [40n * MINUTE, true],
      [95n * MINUTE, false],
    ] as const) {
      const chain = new FakeTestnet();
      const lines: string[] = [];
      const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
      const sealed = await sealLive({ ...live(chain, lines), challenge: await challenge("live-safe"), plan, salt: "salt-0123456789abcdef" });
      chain.missedUntil = missedUntil;
      const play = playLive(live(chain, lines), sealed);
      if (played) {
        expect((await play).status).toBe("drained");
        expect(lines).toContain("waiting    this seal missed its slot: the later seals play first");
        expect(chain.now).toBeGreaterThanOrEqual(missedUntil);
      } else {
        // reveal_until is at 90 minutes: no call is spent on a plan that could not be revealed.
        await expect(play).rejects.toThrow("before the reveal window ends");
        expect(chain.sent.map((t) => t.method)).toEqual(["commit"]);
        expect(chain.now).toBeLessThan(90n * MINUTE);
      }
    }
  });

  it("will not seal after the window", async () => {
    const chain = new FakeTestnet();
    chain.now = chain.commitUntil;
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    await expect(sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan })).rejects.toThrow("the commit window is closed");
    expect(chain.sent).toEqual([]);
  });

  it("claims nothing when the sweep fails", async () => {
    const { chain, result } = await round("pays", "miss");
    // The miss plan sweeps without the hole: sealed, played, refused by the safe; nothing to reveal or claim.
    expect(chain.sent.map((t) => t.method)).toEqual(["commit", "sweep"]);
    expect(result).toMatchObject({ revealTx: null, claimTx: null, drainTx: null });
  });

  it("leaves out a step the mask's key cannot call, and seals what it will really play", async () => {
    const breach = JSON.parse(await planText("live-safe", "breach")) as { steps: unknown[] };
    const { chain, sealed, result, lines } = await round("pays", "breach", [{ kind: "call", method: "available" }, ...breach.steps]);
    expect(chain.sent.map((t) => t.method)).toEqual(["commit", "set_owner", "sweep", "reveal", "claim_drain"]);
    expect(sealed.calls.map((c) => c.method)).toEqual(["set_owner", "sweep"]);
    expect(result.status).toBe("drained");
    expect(lines.some((l) => l.startsWith("available") && l.includes("skip"))).toBe(true);
  });

  it("salts the seal with the mask's own key, so a job that died after commit can still reveal", async () => {
    const chain = new FakeTestnet();
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    const first = await sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan });
    expect(first.salt).toBe(sealSalt(CLAIM_KEY, ID, NOVA));
    // The job dies here. A new one, with the same finding and the same keys, finds the seal and rebuilds it.
    chain.available += 123n;
    const again = await resumeLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan });
    expect(again).toMatchObject({ plan: first.plan, salt: first.salt, hash: first.hash, seq: 0 });
    expect(chain.sent.map((t) => t.method)).toEqual(["commit"]);
    const result = await playLive(live(chain, []), again);
    expect(result).toMatchObject({ status: "drained", seal: "confirmed" });
  });

  it("rebuilds the sealed cut when the safe pays out a step more or less than when it sealed (review finding 2)", async () => {
    for (const drift of [99n * 10n ** 19n, -2n * 10n ** 20n, 3n * 10n ** 22n]) {
      const chain = new FakeTestnet();
      chain.available = 2n * NEAR + 10n ** 20n;
      const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
      const first = await sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan });
      chain.available += drift;
      const again = await resumeLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan });
      expect(again).toMatchObject({ plan: first.plan, hash: first.hash });
    }
  });

  it("will not resume a seal it cannot rebuild", async () => {
    const chain = new FakeTestnet();
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    await sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan });
    chain.available = NEAR;
    await expect(resumeLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan })).rejects.toThrow(
      "is not the sealed one",
    );
  });

  it("refuses a mask that is not in the race", async () => {
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    await expect(
      sealLive({ ...live(new FakeTestnet(), []), mask: "stranger.testnet", challenge: await challenge("live-safe"), plan }),
    ).rejects.toThrow("not a mask of race-0004");
  });

  it("maps every sandbox account and refuses one that exists only there", async () => {
    const c = await challenge("live-safe");
    const m = accountMap(c, { safe: SAFE, mask: NOVA, owner: SAFE });
    expect(translateArgs({ a: ["attacker.test.near", "safe.test.near", "alice.test.near"], n: 1 }, m)).toEqual({
      a: [NOVA, SAFE, SAFE],
      n: 1,
    });
    expect(() => translateArgs({ to: "bob.test.near" }, m)).toThrow("only in the sandbox");
  });
});

describe("a sweep sealed for all the safe holds (review finding 2)", () => {
  /** A safe that can pay out 0.0001 NEAR above a step of 0.01 NEAR, and turns before NOVA's that take `grown` of it. */
  async function occupied(grown: bigint) {
    const chain = new FakeTestnet();
    chain.available = 2n * NEAR + 10n ** 20n;
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    const sealed = await sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan });
    chain.available -= grown;
    return { chain, sealed, result: await playLive(live(chain, []), sealed) };
  }

  it("leaves the margin, so it still pays after the turns before it grew the safe's storage", async () => {
    // Three masks ahead of NOVA each add a first move and a turn: about 0.0015 NEAR of storage each.
    const { sealed, result } = await occupied(45n * 10n ** 19n);
    expect(sealed.calls[1]!.args.amount).toBe((197n * NEAR / 100n).toString());
    expect(result.status).toBe("drained");
  });

  it("covers sixteen masks ahead with the longest names", async () => {
    expect(SWEEP_MARGIN).toBeGreaterThanOrEqual(17n * 15n * 10n ** 20n);
    expect((await occupied(17n * 15n * 10n ** 20n)).result.status).toBe("drained");
  });

  it("would have failed with the old cut, which kept back only what the rounding left", async () => {
    // The old cut: 2.00 NEAR of the 2.0001 the safe could pay out when NOVA sealed. The turns ahead took 0.0045 NEAR.
    const chain = new FakeTestnet();
    chain.available = 2n * NEAR + 10n ** 20n;
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    const sealed = await sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan });
    const old = { ...sealed, calls: [sealed.calls[0]!, { method: "sweep", args: { to: NOVA, amount: (2n * NEAR).toString() } }] };
    chain.available -= 45n * 10n ** 19n;
    const result = await playLive(live(chain, []), old);
    expect(result.calls.map((c) => [c.method, c.ok])).toEqual([["set_owner", true], ["sweep", false]]);
    expect(result.claimTx).toBeNull();
  });
});

describe("a plan played on chain names only the round", () => {
  const ours = { safe: SAFE, mask: NOVA, owner: SAFE };

  it("pays only the mask and hands the safe only to the mask (A9)", () => {
    expect(() => guardCall({ method: "sweep", args: { to: NOVA, amount: "1" } }, ours)).not.toThrow();
    expect(() => guardCall({ method: "set_owner", args: { new_owner: NOVA } }, ours)).not.toThrow();
    expect(() => guardCall({ method: "sweep", args: { to: "evil.testnet", amount: "1" } }, ours)).toThrow(
      "names an account outside the round: evil.testnet",
    );
    expect(() => guardCall({ method: "sweep", args: { to: SAFE, amount: "1" } }, ours)).toThrow("sweep pays only the mask");
    expect(() => guardCall({ method: "set_owner", args: { new_owner: SAFE } }, ours)).toThrow(
      "set_owner hands the safe only to the mask",
    );
    expect(() => guardCall({ method: "set_owner", args: { new_owner: "evil.testnet" } }, ours)).toThrow("outside the round");
    // Nothing else may ride along: no other account deep in the arguments, no free text.
    expect(() => guardCall({ method: "sweep", args: { to: NOVA, amount: "1", via: ["7", { y: "evil.testnet" }] } }, ours)).toThrow(
      "via[1].y names an account outside the round",
    );
    expect(() => guardCall({ method: "sweep", args: { to: NOVA, amount: "1", memo: "Hello!" } }, ours)).toThrow(
      "memo names something that is not an amount",
    );
  });

  it("will not seal a sandbox win whose third step would send the safe's NEAR to a stranger", async () => {
    // The A9 plan: in the sandbox `evil.testnet` does not exist, so the third step fails there and the plan still
    // wins. On testnet it would pay the stranger. The mask seals nothing and signs nothing on the safe.
    const steps = [
      { kind: "call", method: "set_owner", args: { new_owner: "attacker.test.near" } },
      { kind: "call", method: "sweep", args: { to: "attacker.test.near", amount: NEAR.toString() } },
      { kind: "call", method: "sweep", args: { to: "evil.testnet", amount: NEAR.toString() } },
    ];
    const chain = new FakeTestnet();
    const plan = Plan.parse({ steps });
    await expect(sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan })).rejects.toThrow("evil.testnet");
    expect(chain.sent).toEqual([]);
    // Nor a plan that hands the safe to its sandbox owner, or to a stranger.
    for (const owner of ["alice.test.near", "evil.testnet"]) {
      const handOver = Plan.parse({ steps: [{ kind: "call", method: "set_owner", args: { new_owner: owner } }, steps[1]] });
      await expect(sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan: handOver })).rejects.toThrow(
        /set_owner hands the safe only to the mask|outside the round/,
      );
    }
    expect(chain.sent).toEqual([]);
  });

  it("checks every call again right before it is signed", async () => {
    const chain = new FakeTestnet();
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    const sealed = await sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan });
    const tampered = { ...sealed, calls: [sealed.calls[0]!, { method: "sweep", args: { to: "evil.testnet", amount: "1" } }] };
    await expect(playLive(live(chain, []), tampered)).rejects.toThrow("evil.testnet");
    expect(chain.sent.map((t) => t.method)).toEqual(["commit"]);
  });

  it("gives every call on the safe the same small gas, whatever the plan asked (A13)", async () => {
    const breach = JSON.parse(await planText("live-safe", "breach")) as { steps: { kind: string; gas_tgas?: number }[] };
    const greedy = breach.steps.map((st) => (st.kind === "call" ? { ...st, gas_tgas: MAX_GAS_TGAS } : st));
    const { chain } = await round("pays", "breach", greedy);
    const onSafe = chain.sent.filter((t) => t.receiver === SAFE);
    expect(onSafe.map((t) => t.method)).toEqual(["set_owner", "sweep"]);
    expect(onSafe.every((t) => t.gas === BigInt(SAFE_CALL_TGAS) * 10n ** 12n)).toBe(true);
  });

  it("does not start its one turn when the key's allowance cannot pay for the whole plan (A13)", async () => {
    const chain = new FakeTestnet();
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    const sealed = await sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan });
    chain.allowance = 10n ** 21n;
    await expect(playLive(live(chain, []), sealed)).rejects.toThrow("allowance");
    expect(chain.sent.map((t) => t.method)).toEqual(["commit"]);
    chain.allowance = null;
    expect((await playLive(live(chain, []), sealed)).status).toBe("drained");
  });
});

describe("a safe locked to the round", () => {
  it("waits out another mask's turn without spending a call, then plays its own (H1)", async () => {
    const chain = new FakeTestnet();
    chain.othersTurnUntil = chain.commitUntil + 3n * MINUTE;
    const lines: string[] = [];
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    const sealed = await sealLive({ ...live(chain, lines), challenge: await challenge("live-safe"), plan });
    const result = await playLive(live(chain, lines), sealed);
    expect(chain.sent.map((t) => t.method)).toEqual(["commit", "set_owner", "sweep", "reveal", "claim_drain"]);
    expect(chain.now).toBeGreaterThanOrEqual(chain.othersTurnUntil);
    expect(lines.filter((l) => l.includes("another mask has its turn on the safe"))).toHaveLength(1);
    expect(result.status).toBe("drained");
  });

  it("waits while an earlier seal goes first, and never sends a call the safe would refuse (review finding 3)", async () => {
    const chain = new FakeTestnet();
    chain.earlierUntil = chain.commitUntil + 6n * MINUTE;
    const lines: string[] = [];
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    const sealed = await sealLive({ ...live(chain, lines), challenge: await challenge("live-safe"), plan });
    const result = await playLive(live(chain, lines), sealed);
    expect(chain.sent.map((t) => t.method)).toEqual(["commit", "set_owner", "sweep", "reveal", "claim_drain"]);
    expect(chain.now).toBeGreaterThanOrEqual(chain.earlierUntil);
    expect(lines.some((l) => l.includes("an earlier seal goes first"))).toBe(true);
    expect(result.status).toBe("drained");
  });

  it("sends a call again when another mask took its turn in the same moment (H1)", async () => {
    const chain = new FakeTestnet();
    chain.viewLags = true;
    chain.othersTurnUntil = chain.commitUntil + 3n * MINUTE;
    const lines: string[] = [];
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    const sealed = await sealLive({ ...live(chain, lines), challenge: await challenge("live-safe"), plan });
    const result = await playLive(live(chain, lines), sealed);
    expect(chain.sent.map((t) => t.method)).toEqual(["commit", "set_owner", "set_owner", "sweep", "reveal", "claim_drain"]);
    expect(chain.now).toBeGreaterThanOrEqual(chain.othersTurnUntil);
    expect(lines.some((l) => l.includes("onyx.tinygif8324.testnet has its turn"))).toBe(true);
    // The refused call is no move: the plan's transactions are the two that went through.
    expect(result.calls.filter((c) => c.ok).map((c) => c.method)).toEqual(["set_owner", "sweep"]);
    expect(chain.sent[4]!.args.txs).toEqual(result.calls.filter((c) => c.ok).map((c) => c.hash));
    expect(result.status).toBe("drained");
  });

  it("seals nothing in a round someone other than the safe's team opened (review finding 1)", async () => {
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    // An older safe that names no team, a bounty opened by another account, and a team other than the one we play for.
    for (const [owner, team, ours] of [
      [TEAM, null, undefined],
      ["intruder.testnet", TEAM, undefined],
      [TEAM, TEAM, "other-team.testnet"],
    ] as const) {
      const chain = new FakeTestnet();
      chain.bountyOwner = owner;
      chain.safeTeam = team;
      await expect(
        sealLive({ ...live(chain, []), team: ours, challenge: await challenge("live-safe"), plan }),
      ).rejects.toThrow("not our round");
      expect(chain.sent).toEqual([]);
    }
    const chain = new FakeTestnet();
    const sealed = await sealLive({ ...live(chain, []), team: TEAM, challenge: await challenge("live-safe"), plan });
    expect((await playLive({ ...live(chain, []), team: TEAM }, sealed)).status).toBe("drained");
  });

  it("seals nothing on a safe that is not locked to this round", async () => {
    const plan = Plan.parse(JSON.parse(await planText("live-safe", "breach")));
    for (const lock of [null, { arbiter: "team.testnet", bounty: ID, opens_ns: "" }, { arbiter: BOUNTY, bounty: "race-0005", opens_ns: "" }]) {
      const chain = new FakeTestnet();
      chain.lock = lock;
      await expect(sealLive({ ...live(chain, []), challenge: await challenge("live-safe"), plan })).rejects.toThrow(
        "is not locked to race-0004",
      );
      expect(chain.sent).toEqual([]);
    }
  });
});

describe("a round with the people's masks: every sealed sweep asks for min_loot", () => {
  const seal = async (chain: FakeTestnet, lines: string[] = []) =>
    sealLive({
      ...live(chain, lines),
      sweep: "min_loot",
      challenge: await challenge("live-safe"),
      plan: Plan.parse(JSON.parse(await planText("live-safe", "breach"))),
      salt: "salt-0123456789abcdef",
    });

  it("seals and plays a sweep of exactly min_loot, and leaves the rest of the safe to the later seals", async () => {
    const chain = new FakeTestnet();
    chain.available = 5n * NEAR;
    const lines: string[] = [];
    const sealed = await seal(chain, lines);
    // The sandbox plan sweeps 2.5 NEAR, the safe could pay out 5: the seal asks for the round's 1 NEAR of min_loot.
    expect(sealed.calls).toEqual([
      { method: "set_owner", args: { new_owner: NOVA } },
      { method: "sweep", args: { to: NOVA, amount: NEAR.toString() } },
    ]);
    expect(lines.some((l) => l.includes("min_loot"))).toBe(true);
    const result = await playLive({ ...live(chain, lines), sweep: "min_loot" }, sealed);
    expect(result).toMatchObject({ status: "drained", seal: "confirmed" });
    expect(chain.available).toBe(4n * NEAR);
  });

  it("an earlier seal under the arena's own rule would spoil the later plan; under min_loot it does not", async () => {
    // The safe pays out 2.52 NEAR and the plan sweeps 2.5. Seal #0 under the arena's own rule takes all of it but the
    // margin: a later sealed sweep of min_loot would find 0.03 NEAR and fail.
    const greedy = new FakeTestnet();
    greedy.available = 252n * NEAR / 100n;
    const all = await sealLive({
      ...live(greedy, []),
      challenge: await challenge("live-safe"),
      plan: Plan.parse(JSON.parse(await planText("live-safe", "breach"))),
      salt: "salt-0123456789abcdef",
    });
    await playLive(live(greedy, []), all);
    expect(greedy.available).toBe(SWEEP_MARGIN);
    // Under min_loot the same plan takes 1 NEAR and leaves 1.52: the next seal of 1 NEAR still pays.
    const fair = new FakeTestnet();
    fair.available = 252n * NEAR / 100n;
    const sealed = await seal(fair);
    await playLive({ ...live(fair, []), sweep: "min_loot" }, sealed);
    expect(fair.available).toBe(152n * NEAR / 100n);
  });

  it("resumes its seal whatever the safe holds by then: the sweep is min_loot, not a cut of the safe", async () => {
    const chain = new FakeTestnet();
    chain.available = 5n * NEAR;
    const sealed = await seal(chain);
    chain.available = 37n * NEAR / 10n;
    const again = await resumeLive({
      ...live(chain, []),
      sweep: "min_loot",
      challenge: await challenge("live-safe"),
      plan: Plan.parse(JSON.parse(await planText("live-safe", "breach"))),
      salt: "salt-0123456789abcdef",
    });
    expect(again.hash).toBe(sealed.hash);
    expect(again.plan).toBe(sealed.plan);
  });

  it("seals nothing on a safe that cannot pay min_loot", async () => {
    const chain = new FakeTestnet();
    chain.available = NEAR / 2n;
    await expect(seal(chain)).rejects.toThrow("less than the round's min_loot");
    expect(chain.sent).toEqual([]);
  });

  it("knows a round with a person's mask from one of the arena's own", () => {
    const ours = ["nova.tinygif8324.testnet", "onyx.tinygif8324.testnet", "oracle.tinygif8324.testnet"];
    expect(sweepRuleOf(ours, ours)).toBe("all");
    expect(sweepRuleOf([...ours, "kira.masks.tinygif8324.testnet"], ours)).toBe("min_loot");
  });
});
