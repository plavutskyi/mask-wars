// MASK CHECK: one question before an agent pays or calls a contract. In: an account. Out: allow, warn or block, with
// every reason and its evidence. Everything except the shared list is read from the chain at the moment of the check,
// on testnet or on mainnet. On mainnet two independent RPC providers answer every read and must agree.
//
// `allow` means only that no signal against the account was found. It says nothing about keys, servers or anything
// else that is not on the chain.
import { accountOk, isImplicit, isMainnetName, isTestnetName } from "./account.ts";
import type { ArenaEntry, Evidence, SharedList } from "./list.ts";
import { NETWORK, type Network } from "./network.ts";
import { type AccountInfo, type BlockInfo, ChainError, type ChainReader, NO_CODE, blockTime, hostOf } from "./rpc.ts";

export type Verdict = "allow" | "warn" | "block";
export type Level = "block" | "warn" | "info";

export type ReasonCode =
  | "no_account" // a named account that does not exist: a payment cannot arrive
  | "unused_implicit" // an implicit account nobody has used yet
  | "arena_drained" // a mask drained this safe on the arena and the judge confirmed it
  | "arena_taken_over" // a mask took the safe over through its hole; the drain may not be claimed yet
  | "arena_target" // the safe is in an open race right now
  | "arena_withstood" // the safe's race ended and nobody drained it
  | "arena_pending" // the list names a race the chain does not show yet
  | "arena_unreadable" // the bounty contract did not answer the arena's questions
  | "reported" // someone reported the account, with evidence
  | "young_account" // the account did not exist at the start of the window
  | "code_deployed" // a contract appeared on the account within the window
  | "code_changed" // the contract's code changed within the window
  | "account_age" // the account already existed at the start of the window
  | "contract" // the account holds a contract (its code hash)
  | "plain_account" // no contract code
  | "history_unavailable" // no node keeps the block at the start of the window
  | "rpc_agree" // cross-check: two independent RPC providers gave the same answer to every read
  | "rpc_single" // cross-check: some reads came from one provider only, the other was down or lacked the block
  | "rpc_disagree" // cross-check: the providers gave different answers to the same read; the check stopped there
  | "chain_unreadable"; // no RPC answered: nothing could be read

export interface Reason {
  code: ReasonCode;
  level: Level;
  text: string;
  evidence?: Record<string, string | number | Evidence[] | null>;
}

export interface CheckResult {
  account: string;
  network: Network;
  verdict: Verdict;
  /** One line a person or an agent can show as is. */
  summary: string;
  /** Strongest first. */
  reasons: Reason[];
  /** The final block every chain reading was taken at; `null` when the chain could not be read. */
  block: { height: number; hash: string; time: string } | null;
  checked_at: string;
  rpc: readonly string[];
}

export interface CheckOptions {
  /** A reader of `network` (`readerFor(network)`). */
  reader: ChainReader;
  /** The shared list of `network` (`sharedLists[network]`). */
  list: SharedList;
  /** The network to read. Default: the list's. */
  network?: Network;
  /** How far back the age and code-change signals look. Default 24 hours. */
  windowHours?: number;
  now?: () => Date;
}

export class InvalidAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAccountError";
  }
}

const RANK: Record<Level, number> = { block: 2, warn: 1, info: 0 };

interface BountyView {
  owner: string;
  amount: string;
  target: string;
  deadline_ns: string;
  status: { state: "open" | "judging" | "paid" | "refunded" | "drained"; winner?: string; tx_hash?: string; claimant?: string };
}

interface SafeRaceView {
  safe: string;
  masks: string[];
  min_loot: string;
  opened_ns: string;
}

function iso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function near(yocto: string): string {
  const n = BigInt(yocto);
  const whole = n / 10n ** 24n;
  const frac = ((n % 10n ** 24n) / 10n ** 21n).toString().padStart(3, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** The closest block at or below `height` that the nodes still have, trying a few heights for skipped ones. */
async function blockAtOrBelow(reader: ChainReader, height: number): Promise<BlockInfo | null> {
  for (let h = height; h > height - 4 && h > 0; h--) {
    const b = await reader.block(h);
    if (b) return b;
  }
  return null;
}

async function arenaReasons(reader: ChainReader, entry: ArenaEntry, at: { block_id: number }, explorer: string): Promise<Reason[]> {
  const where = { contract: entry.contract, race: entry.race };
  let bounty: BountyView | null;
  let race: SafeRaceView | null;
  try {
    bounty = await reader.view<BountyView | null>(entry.contract, "get", { id: entry.race }, at);
    race = bounty ? await reader.view<SafeRaceView | null>(entry.contract, "get_safe", { id: entry.race }, at) : null;
  } catch (error) {
    if (error instanceof ChainError && error.kind === "contract") {
      return [{ code: "arena_unreadable", level: "info", text: `The arena contract ${entry.contract} did not answer for ${entry.race}: ${error.message}`, evidence: where }];
    }
    throw error;
  }
  if (!bounty) {
    return [{ code: "arena_pending", level: "info", text: `Listed for ${entry.race} on the arena, but that race is not open on chain yet.`, evidence: where }];
  }
  if (!race || race.safe !== entry.safe) {
    return [{ code: "arena_pending", level: "info", text: `${entry.race} on chain is not a live race on this safe.`, evidence: { ...where, safe_on_chain: race?.safe ?? null } }];
  }
  const s = bounty.status;
  if (s.state === "drained") {
    return [
      {
        code: "arena_drained",
        level: "block",
        text: `Drained on the MASK WARS arena: mask ${s.winner} took the safe through its planted hole in ${entry.race}, and the judge confirmed the drain on chain. Whoever controls it now is not its original owner.`,
        evidence: { ...where, winner: s.winner ?? null, tx_hash: s.tx_hash ?? null, tx: s.tx_hash ? `${explorer}/txns/${s.tx_hash}` : null },
      },
    ];
  }
  const owner = await reader.view<string>(entry.safe, "get_owner", {}, at).catch((error: unknown) => {
    if (error instanceof ChainError && error.kind === "contract") return null;
    throw error;
  });
  const out: Reason[] = [];
  if (owner && owner !== entry.owner_at_open) {
    out.push({
      code: "arena_taken_over",
      level: "block",
      text: `Taken over on the MASK WARS arena: the safe's owner is now ${owner}, not ${entry.owner_at_open}. A mask got in through the planted hole in ${entry.race}; the drain is not judged yet.`,
      evidence: { ...where, owner, owner_at_open: entry.owner_at_open },
    });
  }
  if (s.state === "open" || s.state === "judging") {
    out.push({
      code: "arena_target",
      level: "warn",
      text: `A live target on the MASK WARS arena right now: ${race.masks.length} masks race to drain it in ${entry.race} (a training safe with a planted hole). Bounty ${near(bounty.amount)} NEAR.`,
      evidence: { ...where, masks: race.masks.join(", "), deadline: iso(new Date(Number(BigInt(bounty.deadline_ns) / 1_000_000n))) },
    });
  } else if (s.state === "refunded") {
    out.push({ code: "arena_withstood", level: "info", text: `Withstood ${entry.race} on the MASK WARS arena: no mask drained it before the deadline.`, evidence: where });
  }
  return out;
}

async function historyReasons(reader: ChainReader, accountId: string, head: BlockInfo, now: AccountInfo, windowHours: number): Promise<Reason[]> {
  // Block time drifts, so measure it on the last 10 000 blocks and step back that many blocks for the window.
  const sample = await blockAtOrBelow(reader, head.height - 10_000);
  const nsPerBlock = sample ? Number(head.timestampNs - sample.timestampNs) / (head.height - sample.height) : 0;
  const ref = nsPerBlock > 0 ? await blockAtOrBelow(reader, head.height - Math.ceil((windowHours * 3_600e9) / nsPerBlock)) : null;
  if (!ref) {
    return [{ code: "history_unavailable", level: "info", text: `No RPC node keeps the block from ${windowHours} h ago; age and code changes were not checked.` }];
  }
  const since = { block_height: ref.height, block_time: iso(blockTime(ref)) };
  let then: AccountInfo | null;
  try {
    then = await reader.account(accountId, { block_id: ref.height });
  } catch (error) {
    if (error instanceof ChainError && error.kind === "unknown_block") {
      return [{ code: "history_unavailable", level: "info", text: `No RPC node keeps the state from ${windowHours} h ago; age and code changes were not checked.` }];
    }
    throw error;
  }
  if (!then) {
    return [{ code: "young_account", level: "warn", text: `New account: it did not exist ${windowHours} h ago (block ${ref.height}, ${since.block_time}).`, evidence: since }];
  }
  const out: Reason[] = [{ code: "account_age", level: "info", text: `The account already existed ${windowHours} h ago (block ${ref.height}, ${since.block_time}).`, evidence: since }];
  if (then.codeHash !== now.codeHash) {
    if (then.codeHash === NO_CODE) {
      out.unshift({ code: "code_deployed", level: "warn", text: `A contract was deployed here within the last ${windowHours} h.`, evidence: { ...since, code_hash: now.codeHash } });
    } else if (now.codeHash === NO_CODE) {
      out.unshift({ code: "code_changed", level: "warn", text: `The contract's code was removed within the last ${windowHours} h.`, evidence: { ...since, code_hash_before: then.codeHash, code_hash_now: now.codeHash } });
    } else {
      out.unshift({ code: "code_changed", level: "warn", text: `The contract's code changed within the last ${windowHours} h.`, evidence: { ...since, code_hash_before: then.codeHash, code_hash_now: now.codeHash } });
    }
  }
  return out;
}

/** How the providers answered, on a network read with cross-check. Nothing on a network read with failover. */
function rpcReasons(reader: ChainReader): Reason[] {
  const t = reader.tally;
  if (!reader.crossCheck || !t || t.reads === 0) return [];
  const hosts = reader.endpoints.map(hostOf);
  const evidence = { rpc: hosts.join(", "), reads: t.reads, cross_checked: t.agreed };
  if (hosts.length < 2) {
    return [{ code: "rpc_single", level: "info", text: `Read from one RPC provider only, ${hosts[0]}: nothing was cross-checked.`, evidence }];
  }
  if (t.agreed === t.reads) {
    return [{ code: "rpc_agree", level: "info", text: `Two independent RPC providers, ${hosts.join(" and ")}, gave the same answer to all ${t.reads} reads.`, evidence }];
  }
  const why = [...t.missing].map(([endpoint, said]) => `${hostOf(endpoint)}: ${said.replace(/^\S+: /, "")}`).join("; ");
  return [
    {
      code: "rpc_single",
      level: "info",
      text: `${t.reads - t.agreed} of ${t.reads} reads came from one RPC provider only and were not cross-checked (${why}).`,
      evidence,
    },
  ];
}

function summarize(verdict: Verdict, reasons: Reason[]): string {
  if (verdict === "allow") return "No signals against this account were found.";
  const top = reasons.filter((r) => r.level === verdict).map((r) => r.text);
  return `${verdict.toUpperCase()}: ${top.join(" ")}`;
}

/** Asks the chain and the shared list about one account. Throws only on an account id that cannot exist. */
export async function maskCheck(accountId: string, options: CheckOptions): Promise<CheckResult> {
  const id = accountId.trim().toLowerCase();
  const network = options.network ?? options.list.network;
  if (!accountOk(id)) throw new InvalidAccountError(`not a NEAR account id: ${accountId}`);
  if (network === "testnet" && isMainnetName(id)) throw new InvalidAccountError(`${id} is a mainnet name; this check reads testnet`);
  if (network === "mainnet" && isTestnetName(id)) throw new InvalidAccountError(`${id} is a testnet name; this check reads mainnet`);
  if (options.list.network !== network) throw new Error(`the shared list is for ${options.list.network}, not ${network}`);
  const { list } = options;
  // One tally per check: what each provider answered is this check's, not another one's running at the same time.
  const reader = options.reader.tracked();
  const windowHours = options.windowHours ?? 24;
  const now = options.now ?? (() => new Date());

  const reasons: Reason[] = [];
  for (const r of list.reports.filter((r) => r.account === id)) {
    reasons.push({ code: "reported", level: r.level, text: r.reason, evidence: { reported_by: r.reported_by, added: r.added, evidence: r.evidence } });
  }

  let block: CheckResult["block"] = null;
  try {
    const head = await reader.head();
    block = { height: head.height, hash: head.hash, time: iso(blockTime(head)) };
    const at = { block_id: head.height };
    const account = await reader.account(id, at);
    if (!account) {
      reasons.push(
        isImplicit(id)
          ? { code: "unused_implicit", level: "warn", text: "An implicit account nobody has used yet: no history at all." }
          : { code: "no_account", level: "block", text: `No such account on ${network}: a payment cannot arrive.` },
      );
    } else {
      for (const entry of list.arena.filter((e) => e.safe === id)) reasons.push(...(await arenaReasons(reader, entry, at, NETWORK[network].explorer)));
      reasons.push(...(await historyReasons(reader, id, head, account, windowHours)));
      reasons.push(
        account.codeHash === NO_CODE
          ? { code: "plain_account", level: "info", text: "A plain account: no contract code." }
          : { code: "contract", level: "info", text: `A contract, code hash ${account.codeHash}.`, evidence: { code_hash: account.codeHash } },
      );
    }
    reasons.push(...rpcReasons(reader));
  } catch (error) {
    if (!(error instanceof ChainError)) throw error;
    if (error.kind === "disagree") {
      reasons.push({
        code: "rpc_disagree",
        level: "warn",
        text: `Two RPC providers gave different answers to the same read, so the check stopped there and nothing after it was read: ${error.message.replace(/^rpc: /, "")}`,
        evidence: { rpc: reader.endpoints.map(hostOf).join(", ") },
      });
    } else {
      reasons.push({ code: "chain_unreadable", level: "warn", text: `The chain could not be read, so nothing on chain was checked: ${error.message}` });
    }
  }

  reasons.sort((a, b) => RANK[b.level] - RANK[a.level]);
  const top = reasons[0]?.level ?? "info";
  const verdict: Verdict = top === "block" ? "block" : top === "warn" ? "warn" : "allow";
  return {
    account: id,
    network,
    verdict,
    summary: summarize(verdict, reasons),
    reasons,
    block,
    checked_at: iso(now()),
    rpc: reader.endpoints,
  };
}
