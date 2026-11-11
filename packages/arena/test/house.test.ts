// The house's rounds on a made-up chain. The house opens one round a day on one safe, the vault, which deletes its own
// account once the round is over and is made again under the same name for the next one. So the arena reads a round
// whose safe is no longer on chain, tells two rounds on the same account apart by their time, and tells the home page
// when the next round opens only when it really will.
import { ChainError, type ChainReader } from "@maskwars/check";
import { describe, expect, it } from "vitest";
import { Arena, type House, type Indexer, type Tx } from "../src/index.ts";

const BOUNTY = "bounty.example.near";
const HOUSE = "house.example.near";
const VAULT = `vault.${HOUSE}`;
const NOVA = "nova.example.near";
const ORACLE = "oracle.example.near";
const NEAR = 10n ** 24n;
const MILLI = NEAR / 1000n;
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (iso: string) => Date.parse(iso);
const ns = (ms: number) => (BigInt(ms) * 1_000_000n).toString();
const CODE = "7Hq3rXbK9mP2vW5yZ8cD1fG4hJ6kL9nQ2sT5uV8wX1yA";
/** The judge the house opens its rounds with. */
const JUDGE = "1f".repeat(32);
/** Two days, two slots at 18:00 UTC, the house's step a few minutes after each. */
const DAY1 = at("2026-11-11T18:04:00Z");
const DAY2 = at("2026-11-12T18:04:00Z");

const house: House = {
  account: HOUSE,
  vault: VAULT,
  bounty: BOUNTY,
  target: "live-safe",
  safeCode: CODE,
  round: { live: true, judge: JUDGE, first_minute: 1080, every_minutes: 1440, safe: "1.93", stake: "1.65", deposit: "0.25", min_loot: "0.1", gas: "0.1", mask_keep: "0.4", hours: 4, commit_minutes: 45, reveal_minutes: 60 },
  masks: [NOVA, ORACLE],
};

const receipt = (id: string, from: string, to: string, when: number, transfer = 0n, method?: string, args: Record<string, unknown> = {}, deposit = 0n) => ({
  id,
  from,
  to,
  at: when,
  calls: method ? [{ method, args, deposit }] : [],
  transfer,
  logs: [],
  ok: true,
  value: undefined,
});

/** One day of the house on chain: the vault made in one transaction, the round opened, ORACLE's drain and the payout. */
function day(id: string, opened: number, tag: string): Tx[] {
  const create: Tx = {
    hash: `CREATE${tag}`,
    signer: HOUSE,
    receiver: VAULT,
    at: opened - MIN,
    height: 1,
    calls: [{ method: "new", args: { owner: VAULT }, deposit: 0n }],
    ok: true,
    receipts: [receipt(`c${tag}`, HOUSE, VAULT, opened - MIN, 1930n * MILLI, "new", { owner: VAULT })],
  };
  const open: Tx = {
    hash: `OPEN${tag}`,
    signer: HOUSE,
    receiver: BOUNTY,
    at: opened,
    height: 2,
    calls: [{ method: "open_safe", args: { id }, deposit: 250n * MILLI }],
    ok: true,
    receipts: [receipt(`o${tag}`, HOUSE, BOUNTY, opened, 0n, "open_safe", { id }, 250n * MILLI)],
  };
  const drain: Tx = {
    hash: `DRAIN${tag}`,
    signer: ORACLE,
    receiver: VAULT,
    at: opened + 46 * MIN,
    height: 3,
    calls: [{ method: "sweep", args: { to: ORACLE }, deposit: 0n }],
    ok: true,
    receipts: [receipt(`d${tag}`, ORACLE, VAULT, opened + 46 * MIN, 0n, "sweep"), receipt(`t${tag}`, VAULT, ORACLE, opened + 46 * MIN, 240n * MILLI)],
  };
  const claim: Tx = {
    hash: `CLAIM${tag}`,
    signer: ORACLE,
    receiver: BOUNTY,
    at: opened + 47 * MIN,
    height: 4,
    calls: [{ method: "claim_drain", args: { id }, deposit: 0n }],
    ok: true,
    receipts: [receipt(`j${tag}`, BOUNTY, BOUNTY, opened + 47 * MIN, 0n, "on_judged"), receipt(`p${tag}`, BOUNTY, ORACLE, opened + 47 * MIN, 110n * MILLI)],
  };
  return [create, open, drain, claim];
}

/** The vault retiring: the house's call, and the whole balance going home. */
const retire = (when: number, tag: string): Tx => ({
  hash: `RETIRE${tag}`,
  signer: HOUSE,
  receiver: VAULT,
  at: when,
  height: 9,
  calls: [{ method: "retire", args: {}, deposit: 0n }],
  ok: true,
  receipts: [receipt(`r${tag}`, HOUSE, VAULT, when, 0n, "retire"), receipt(`h${tag}`, VAULT, HOUSE, when, 1690n * MILLI)],
});

interface World {
  now: number;
  /** The rounds the bounty contract holds, by id. */
  rounds: Record<string, { opened: number; state: string; winner?: string; owner?: string }>;
  txs: Tx[];
  /** The accounts on chain: absent ones are not there. */
  house?: { amount: bigint } | null;
  vault?: { amount: bigint; lock: string | null; foreign?: boolean } | null;
  safeCodes?: string[];
  /** The judge the bounty contract opens new rounds with. */
  judge?: string;
  pending?: string;
  down?: boolean;
  /** Only the house's own account cannot be read: the rest of the chain answers. */
  houseDown?: boolean;
  asked?: string[];
}

function arena(w: World, h: House | null = house) {
  const asked = w.asked ?? [];
  const indexer = {
    accountTxs: async (a: string) =>
      w.txs
        .filter((t) => t.receiver === a || t.signer === a || t.receipts.some((r) => r.to === a))
        .map((t) => ({ hash: t.hash, height: t.height, at: t.at, call: t.receiver === a })),
    transactions: async (hashes: readonly string[]) => w.txs.filter((t) => hashes.includes(t.hash)),
  } as unknown as Indexer;
  const rpc = {
    account: async (a: string) => {
      asked.push(`account ${a}`);
      if (w.down || (w.houseDown && a === HOUSE)) throw new ChainError("rpc", "transport", "fetch failed");
      const acc = a === HOUSE ? w.house : a === VAULT ? w.vault : null;
      // The vault's storage: 164 KB of code and its state.
      return acc ? { amount: acc.amount.toString(), locked: "0", codeHash: CODE, storageUsage: a === VAULT ? 165_500 : 300, blockHeight: 1, blockHash: "h" } : null;
    },
    view: async (c: string, method: string, args: { id?: string }) => {
      asked.push(`view ${c} ${method}`);
      if (w.down) throw new ChainError("rpc", "transport", "fetch failed");
      if (c === VAULT) {
        if (!w.vault) throw new ChainError("rpc", "unknown_account", `account ${VAULT} does not exist while viewing`);
        if (w.vault.foreign) throw new ChainError("rpc", "contract", "MethodNotFound");
        if (method === "get_round") return w.vault.lock ? { arbiter: BOUNTY, bounty: w.vault.lock, opens_ns: "0", armed_ns: "0" } : null;
        if (method === "available") return (w.vault.amount - 1655n * MILLI).toString();
      }
      if (c === BOUNTY) {
        if (method === "governance") return { safe_codes: w.safeCodes ?? [CODE], judge: { version: w.judge ?? JUDGE }, pending: w.pending ? { change: { kind: w.pending } } : null };
        if (method === "judge") return { version: "ab".repeat(32) };
        const r = args.id ? w.rounds[args.id] : undefined;
        if (!r) return null;
        const status = r.winner ? { state: r.state, winner: r.winner, tx_hash: "DRAIN" } : { state: r.state };
        if (method === "get") return { owner: r.owner ?? HOUSE, amount: (110n * MILLI).toString(), target: VAULT, deadline_ns: ns(r.opened + 4 * HOUR), status };
        if (method === "get_safe") return { safe: VAULT, masks: [NOVA, ORACLE], min_loot: (100n * MILLI).toString(), opened_ns: ns(r.opened) };
        if (method === "get_round") return { commit_until: ns(r.opened + 45 * MIN), reveal_until: ns(r.opened + 105 * MIN), deadline_ns: ns(r.opened + 4 * HOUR), seals: [] };
      }
      return null;
    },
  } as unknown as ChainReader;
  const masks = [
    { slug: "nova", name: "NOVA", account: NOVA, model: "m" },
    { slug: "oracle", name: "ORACLE", account: ORACLE, model: "m" },
  ];
  return new Arena({ rpc, indexer, contracts: [BOUNTY], seasons: [], house: h, masks, teams: [HOUSE], now: () => w.now });
}

/** Round race-0002 was won on day 1; what the house holds after it opened that round and got its reserve back. */
const afterDay1 = (patch: Partial<World> = {}): World => ({
  now: DAY1 + 6 * HOUR,
  rounds: { "race-0001": { opened: at("2026-11-10T15:14:00Z"), state: "drained", owner: "example.near" }, "race-0002": { opened: DAY1, state: "drained", winner: ORACLE } },
  txs: day("race-0002", DAY1, "1"),
  house: { amount: 1014n * MILLI },
  vault: { amount: 1690n * MILLI, lock: "race-0002" },
  ...patch,
});

describe("a round whose safe is no longer on chain", () => {
  it("reads as it happened: the vault retired, so it has no code and nothing in it, and the race keeps every event", async () => {
    const w = afterDay1({ now: DAY2 - 10 * MIN, vault: null, txs: [...day("race-0002", DAY1, "1"), retire(DAY2 - 20 * MIN, "1")] });
    const r = (await arena(w).view()).races.find((x) => x.id === "race-0002")!;
    expect(r).toMatchObject({ kind: "safe", state: "drained", phase: "broken", live: false, target: VAULT, team: HOUSE, official: true });
    // The account is gone: no code hash to show, and nothing a mask could take.
    expect(r.targetCode).toBeNull();
    expect(r.inSafe).toBeNull();
    expect(r.winner).toMatchObject({ account: ORACLE, name: "ORACLE" });
    expect(r.safeFunded).toBe((1930n * MILLI).toString());
    expect(r.loot).toBe((240n * MILLI).toString());
    expect(r.payout).toMatchObject({ amount: (110n * MILLI).toString(), tx: "CLAIM1" });
    expect(r.takes).toBe((350n * MILLI).toString());
    expect(r.breakMs).toBe(MIN);
    expect(r.events.map((e) => [e.kind, e.who?.account])).toEqual([
      ["fund", HOUSE],
      ["open", HOUSE],
      ["drain", ORACLE],
      ["claim", ORACLE],
      ["paid", ORACLE],
    ]);
    // The same round read alone says the same.
    expect(await arena(w).round("race-0002")).toEqual(r);
  });

  it("two rounds on the same account are told apart by their time: each keeps its own funding, drain and payout", async () => {
    const w: World = {
      now: DAY2 + 2 * HOUR,
      rounds: { "race-0002": { opened: DAY1, state: "drained", winner: ORACLE }, "race-0003": { opened: DAY2, state: "drained", winner: ORACLE } },
      txs: [...day("race-0002", DAY1, "1"), retire(DAY2 - 3 * MIN, "1"), ...day("race-0003", DAY2, "2")],
      house: { amount: 628n * MILLI },
      vault: { amount: 1690n * MILLI, lock: "race-0003" },
    };
    const races = (await arena(w).view()).races;
    expect(races.map((r) => r.id)).toEqual(["race-0003", "race-0002"]);
    for (const [r, tag] of [[races[1]!, "1"], [races[0]!, "2"]] as const) {
      expect(r.events.map((e) => e.tx), r.id).toEqual([`CREATE${tag}`, `OPEN${tag}`, `DRAIN${tag}`, `CLAIM${tag}`, `CLAIM${tag}`]);
      expect(r.safeFunded, r.id).toBe((1930n * MILLI).toString());
      expect(r.loot, r.id).toBe((240n * MILLI).toString());
      expect(r.txs, r.id).toEqual({ open: `OPEN${tag}`, drain: `DRAIN${tag}`, payout: `CLAIM${tag}` });
    }
    // The vault's going home between them is no event of either race.
    expect(races.flatMap((r) => r.events.map((e) => e.tx))).not.toContain("RETIRE1");
  });
});

describe("the house's next round", () => {
  it("is told with its time, number and sums once the round before it is won and the house can pay", async () => {
    const next = (await arena(afterDay1()).view()).next!;
    expect(next).toMatchObject({
      season: HOUSE,
      at: at("2026-11-12T18:00:00Z"),
      n: 3,
      target: "live-safe",
      targetCode: CODE,
      // What a mask can take: the vault's NEAR less the stake its code locks.
      inSafe: (280n * MILLI).toString(),
      // The bounty: the 0.25 deposit less the reserve the contract keeps for two masks, (240 + 4000 × 2) bytes at 1e19
      // yocto a byte, 0.0824 NEAR, which goes back to the house: 0.1676 NEAR. With the loot, 0.4476.
      locked: "167600000000000000000000",
      prize: "447600000000000000000000",
      minLoot: (100n * MILLI).toString(),
      sealMinutes: 45,
      hours: 4,
      funded: true,
    });
    expect(next.masks.map((m) => m.name)).toEqual(["NOVA", "ORACLE"]);
    // Read alone it is the same, and asks nothing about the races.
    const asked: string[] = [];
    expect(await arena(afterDay1({ asked })).next()).toEqual(next);
    expect(asked.sort()).toEqual([`account ${HOUSE}`, `account ${VAULT}`, `view ${BOUNTY} get`, `view ${BOUNTY} get_round`, `view ${BOUNTY} get_safe`, `view ${BOUNTY} governance`, `view ${VAULT} get_round`]);
  });

  it("before the first round ever: the house is on chain with enough, no vault yet", async () => {
    const w: World = { now: at("2026-11-11T12:00:00Z"), rounds: { "race-0001": { opened: at("2026-11-10T15:14:00Z"), state: "drained", owner: "example.near" } }, txs: [], house: { amount: 3080n * MILLI }, vault: null };
    expect(await arena(w).next()).toMatchObject({ at: at("2026-11-11T18:00:00Z"), n: 2, funded: true });
  });

  it("is told for tomorrow while today's round is still on, and after a round nobody won", async () => {
    // Sealing now: tomorrow's slot comes after its deadline and its claim grace, whoever wins.
    const on = afterDay1({ now: DAY1 + 20 * MIN, rounds: { "race-0002": { opened: DAY1, state: "open" } }, vault: { amount: 1930n * MILLI, lock: "race-0002" }, house: { amount: 900n * MILLI } });
    expect(await arena(on).next()).toMatchObject({ at: at("2026-11-12T18:00:00Z"), n: 3 });
    // Nobody won: the bounty is refunded tomorrow morning, well before the slot.
    const held = afterDay1({ now: DAY1 + 10 * HOUR, rounds: { "race-0002": { opened: DAY1, state: "open" } }, vault: { amount: 1930n * MILLI, lock: "race-0002" }, house: { amount: 900n * MILLI } });
    expect(await arena(held).next()).toMatchObject({ at: at("2026-11-12T18:00:00Z"), n: 3 });
  });

  it("stays on today's slot, already past, until today's round opens: no time is promised for tomorrow meanwhile", async () => {
    // 18:02: the slot has come, the vault still holds yesterday's finished round, the step is on its way.
    const w = afterDay1({ now: DAY2 - 2 * MIN });
    expect((await arena(w).next())!.at).toBe(at("2026-11-12T18:00:00Z"));
    // Nine hours later nobody opened it: a round opened now could not be over before the next slot, so the next is tomorrow's.
    expect((await arena(afterDay1({ now: DAY2 + 9 * HOUR })).next())!.at).toBe(at("2026-11-13T18:00:00Z"));
  });

  it("tells the bounty the winner can get: the deposit less the contract's storage reserve for the round's masks", async () => {
    // Mainnet's three masks: (240 + 4000 × 3) bytes × 1e19 = 0.1224 NEAR stays with the contract and goes home after.
    const three = { ...house, masks: [NOVA, ORACLE, "onyx.example.near"] };
    expect(await arena(afterDay1(), three).next()).toMatchObject({ locked: "127600000000000000000000", prize: "407600000000000000000000" });
  });

  it("is not told until the owner turns the round on, or while the bounty contract judges with another judge", async () => {
    const asked: string[] = [];
    expect(await arena(afterDay1({ asked }), { ...house, round: { ...house.round, live: false } }).next()).toBeNull();
    // Off, nothing is even asked: the chain may show a house that could pay, but nobody signs for it on schedule.
    expect(asked).toEqual([]);
    // The step would not open a round under another judge (packages/race house.ts), so no time is promised for one.
    expect(await arena(afterDay1({ judge: "ab".repeat(32) })).next()).toBeNull();
    expect(await arena(afterDay1({ judge: JUDGE })).next()).not.toBeNull();
  });

  it("is not told while the vault's code is not known, or the bounty contract does not list it or opens no bounty", async () => {
    expect(await arena(afterDay1(), { ...house, safeCode: null }).next()).toBeNull();
    expect(await arena(afterDay1({ safeCodes: ["11111111111111111111111111111111"] })).next()).toBeNull();
    expect(await arena(afterDay1({ pending: "code" })).next()).toBeNull();
    // A safe code or a judge waiting on the contract stops no bounty.
    expect(await arena(afterDay1({ pending: "allow_safe" })).next()).not.toBeNull();
    // No house is read at all when the reader is given none.
    const asked: string[] = [];
    expect(await arena(afterDay1({ asked }), null).next()).toBeNull();
    expect(asked).toEqual([]);
  });

  it("is not told while the house is not on chain, or cannot pay for the round", async () => {
    expect(await arena(afterDay1({ house: null })).next()).toBeNull();
    // 0.5 free and 1.69 coming back with the vault: less than the 2.28 a round needs.
    expect(await arena(afterDay1({ house: { amount: 503n * MILLI } })).next()).toBeNull();
    expect(await arena(afterDay1({ house: { amount: 593n * MILLI } })).next()).not.toBeNull();
    // While a mask can still win today's round, only the stake it cannot take counts as coming back.
    const on = { now: DAY1 + 20 * MIN, rounds: { "race-0002": { opened: DAY1, state: "open" } }, vault: { amount: 1930n * MILLI, lock: "race-0002" } };
    expect(await arena(afterDay1({ ...on, house: { amount: 600n * MILLI } })).next()).toBeNull();
    expect(await arena(afterDay1({ ...on, house: { amount: 630n * MILLI } })).next()).not.toBeNull();
  });

  it("is not told while the round before it cannot be over by then", async () => {
    // Opened late, by hand, and nobody won it yet: its masks can claim until after tomorrow's slot.
    const late = at("2026-11-12T04:00:00Z");
    const w = afterDay1({ now: late + HOUR, rounds: { "race-0002": { opened: late, state: "open" } }, vault: { amount: 1930n * MILLI, lock: "race-0002" }, house: { amount: 900n * MILLI } });
    expect(await arena(w).next()).toBeNull();
    // Once a mask won it, the vault retires after its deadline, in time.
    w.rounds["race-0002"] = { opened: late, state: "drained", winner: ORACLE };
    expect(await arena(w).next()).toMatchObject({ at: at("2026-11-12T18:00:00Z") });
  });

  it("is not told when something else stands on the vault's name", async () => {
    expect(await arena(afterDay1({ vault: { amount: NEAR, lock: null, foreign: true } })).next()).toBeNull();
    // A vault made and never opened is the house's own: the round opens on it.
    expect(await arena(afterDay1({ vault: { amount: 1930n * MILLI, lock: null }, house: { amount: 400n * MILLI } })).next()).toMatchObject({ n: 3 });
  });

  it("a chain that does not answer about the house tells no next round on the home page, and says so when asked alone", async () => {
    await expect(arena(afterDay1({ down: true })).next()).rejects.toBeInstanceOf(ChainError);
    // The whole arena reads on without it: the races are told, and no time is promised.
    const asked: string[] = [];
    const a = arena(afterDay1({ houseDown: true, asked }));
    const view = await a.view();
    expect(view.races.map((r) => r.id)).toEqual(["race-0002"]);
    expect(view.next).toBeNull();
    await expect(a.next()).rejects.toThrow(/fetch failed/);
    // The failed reading is not kept: the same reader asks the chain again.
    expect(asked.filter((x) => x === `account ${HOUSE}`).length).toBeGreaterThanOrEqual(2);
  });

  it("is read once a minute at most, however often the arena is read", async () => {
    const asked: string[] = [];
    const w = afterDay1({ asked });
    const a = arena(w);
    await a.next();
    w.now += 30_000;
    await a.next();
    expect(asked.filter((x) => x === `account ${HOUSE}`)).toHaveLength(1);
    w.now += 31_000;
    await a.next();
    expect(asked.filter((x) => x === `account ${HOUSE}`)).toHaveLength(2);
  });
});
