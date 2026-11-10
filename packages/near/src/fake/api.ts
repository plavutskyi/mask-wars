// Фейк Agent API у пам'яті за тими самими схемами. Детермінований: годинник і зерно передаються параметрами.
// Усі хеші починаються з FAKE-, походження доказу — fake: справжніми їх не видати.
import { createHash } from "node:crypto";
import type { AgentApiPort, Keyed } from "../api.ts";
import { BTC, DECIMALS, ETH, SOL, USDC, WNEAR } from "../assets.ts";
import type { Clock } from "../clock.ts";
import { AgentApiError } from "../errors.ts";
import type {
  AgentPage,
  AgentView,
  BalanceEntry,
  BalanceSource,
  BalancesView,
  BudgetView,
  DepositRequest,
  ExecutionDetails,
  ExecutionType,
  OperationProof,
  QuoteResponse,
  Status,
  StatusResponse,
  SwapRequest,
  TokenView,
  TransferRequest,
  WalletView,
  WithdrawRequest,
} from "../types.ts";
import { fakeError, type Scenario } from "./scenarios.ts";

export interface FakeToken {
  asset_id: string;
  symbol: string;
  decimals: number;
  blockchain: string;
  price: number;
  /** Вартість свопу з USDC у б.п., разом із 20 б.п. 1Click. */
  costBps: number;
}

/** Ціни умовні, лише для фейка. */
export const FAKE_TOKENS: readonly FakeToken[] = [
  { asset_id: USDC, symbol: "USDC", decimals: 6, blockchain: "near", price: 1, costBps: 2 },
  { asset_id: BTC, symbol: "BTC", decimals: 8, blockchain: "near", price: 100_000, costBps: 16 },
  { asset_id: ETH, symbol: "ETH", decimals: 18, blockchain: "near", price: 4_000, costBps: 15 },
  { asset_id: SOL, symbol: "SOL", decimals: 9, blockchain: "near", price: 200, costBps: 19 },
  { asset_id: WNEAR, symbol: "wNEAR", decimals: 24, blockchain: "near", price: 5, costBps: 20 },
];

export interface FakeAgentApiOptions {
  clock: Clock;
  seed?: number;
  tokens?: readonly FakeToken[];
  /** Custody-операцій на гаманець за ковзні 24 год (прод: 100 за дослідженням 01). */
  custodyLimit?: number;
  /** Скільки HTTP-запит свопу тримається відкритим, поки провайдер приймає. */
  dispatchMs?: number;
  /** Розрахунок після відправлення, мс: [від, до]. */
  settleMs?: readonly [number, number];
  /** Час від створення агента до ACTIVE. */
  activationMs?: number;
  /** Скільки UNCERTAIN триває до розв'язання. */
  uncertainMs?: number;
  /** Депозит оплачується сам через стільки мс після видачі адреси, на суму `amount` або `min_amount`. */
  autoPayDepositsMs?: number;
}

interface FakeAgent {
  view: AgentView;
  activeAt: number;
  balances: Map<string, bigint>;
  /** Грошовий HTTP-запит ще відкритий: інші отримають wallet_busy. */
  inFlight: boolean;
  custody: number[];
}

interface FakeOp {
  status: StatusResponse;
  scenario: Scenario;
  settleAt: number;
  uncertainUntil?: number;
  agentId: string;
  /** Що зарахувати на SUCCESS / повернути на REFUNDED. */
  credit?: { agentId: string; asset: string; amount: bigint };
  refund?: { asset: string; amount: bigint };
  deposit?: { asset: string; paid?: bigint };
  autoPayAt?: number;
  events: { action: string; at: number }[];
}

interface KeyEntry {
  body: string;
  result?: StatusResponse;
  error?: AgentApiError;
}

const WINDOW = 24 * 60 * 60 * 1000;

export class FakeAgentApi implements AgentApiPort {
  readonly clock: Clock;
  readonly #tokens: Map<string, FakeToken>;
  readonly #agents = new Map<string, FakeAgent>();
  readonly #ops = new Map<string, FakeOp>();
  readonly #keys = new Map<string, KeyEntry>();
  readonly #scenarios: Scenario[] = [];
  readonly #errors: { code: string; times: number; availableAt?: string }[] = [];
  #mode: Scenario = "ok";
  #rand: () => number;
  #seq = 0;
  readonly #o: Required<Omit<FakeAgentApiOptions, "clock" | "seed" | "tokens" | "autoPayDepositsMs">> & { autoPayDepositsMs?: number };
  /** Лічильник викликів, щоб тести бачили, що пішло в API. */
  readonly calls: { method: string; agentId?: string; key?: string }[] = [];

  constructor(options: FakeAgentApiOptions) {
    this.clock = options.clock;
    this.#rand = mulberry32(options.seed ?? 1);
    this.#tokens = new Map((options.tokens ?? FAKE_TOKENS).map((t) => [t.asset_id, t]));
    this.#o = {
      custodyLimit: options.custodyLimit ?? 100,
      dispatchMs: options.dispatchMs ?? 1_500,
      settleMs: options.settleMs ?? [7_000, 13_000],
      activationMs: options.activationMs ?? 4_000,
      uncertainMs: options.uncertainMs ?? 45_000,
      ...(options.autoPayDepositsMs !== undefined ? { autoPayDepositsMs: options.autoPayDepositsMs } : {}),
    };
  }

  // ——— Керування фейком (не частина AgentApiPort) ———

  /** Постійний режим для всіх наступних грошових операцій. */
  setMode(mode: Scenario): void {
    this.#mode = mode;
  }

  /** Сценарій лише для наступної грошової операції. */
  next(...scenarios: Scenario[]): void {
    this.#scenarios.push(...scenarios);
  }

  /** Наступні `times` грошових викликів отримають помилку `code`. */
  failNext(code: string, times = 1, availableAt?: string): void {
    this.#errors.push({ code, times, ...(availableAt ? { availableAt } : {}) });
  }

  createAgent(name: string, options: { nearAccountId?: string; externalUserId?: string } = {}): AgentView {
    const n = ++this.#seq;
    const id = `agt_fake${String(n).padStart(4, "0")}`;
    const near = options.nearAccountId ?? createHash("sha256").update(id).digest("hex");
    const view: AgentView = {
      id,
      name,
      external_user_id: options.externalUserId ?? null,
      status: "PENDING",
      archived: false,
      deleted: false,
      owner: { type: "near", account_id: "maskwars.near", public_key: "ed25519:FAKE" },
      owner_account: null,
      wallet: { wallet_id: `wal_fake${String(n).padStart(4, "0")}`, near_account_id: near, evm_account_id: null, solana_account_id: null },
      created_at: iso(this.clock.now()),
      cooldowns: { policy_change_available_at: null, unfreeze_available_at: null },
    };
    this.#agents.set(id, { view, activeAt: this.clock.now() + this.#o.activationMs, balances: new Map(), inFlight: false, custody: [] });
    return structuredClone(view);
  }

  fund(agentId: string, asset: string, amountRaw: string): void {
    const agent = this.#agent(agentId);
    agent.balances.set(asset, (agent.balances.get(asset) ?? 0n) + BigInt(amountRaw));
  }

  /** Платник надіслав кошти на адресу депозиту. */
  payDeposit(correlationId: string, amountRaw: string): void {
    const op = this.#op(correlationId);
    if (!op.deposit || op.status.status !== "PENDING_DEPOSIT") throw new Error(`${correlationId} is not an open deposit`);
    op.deposit.paid = BigInt(amountRaw);
    op.status.status = "PROCESSING";
    op.status.details.deposit_seen_at = iso(this.clock.now());
    op.status.updated_at = iso(this.clock.now());
    op.settleAt = this.clock.now() + this.#settleDelay(op.scenario);
    op.credit = { agentId: op.agentId, asset: op.deposit.asset, amount: op.deposit.paid };
    op.events.push({ action: "deposit_seen", at: this.clock.now() });
  }

  // ——— AgentApiPort ———

  async getTokens(): Promise<TokenView[]> {
    this.calls.push({ method: "getTokens" });
    const now = iso(this.clock.now());
    return [...this.#tokens.values()].map((t) => ({
      asset_id: t.asset_id,
      symbol: t.symbol,
      decimals: t.decimals,
      blockchain: t.blockchain,
      price: t.price,
      price_updated_at: now,
      price_expires_at: iso(this.clock.now() + 60_000),
    }));
  }

  async listAgents(query: { external_user_id?: string; cursor?: string } = {}): Promise<AgentPage> {
    this.calls.push({ method: "listAgents" });
    const data = [...this.#agents.keys()].map((id) => this.#viewNow(id)).filter((v) => !query.external_user_id || v.external_user_id === query.external_user_id);
    return { data, next_cursor: null };
  }

  async getAgent(agentId: string): Promise<AgentView> {
    this.calls.push({ method: "getAgent", agentId });
    return this.#viewNow(agentId);
  }

  async getWallet(agentId: string): Promise<WalletView> {
    this.calls.push({ method: "getWallet", agentId });
    const view = this.#viewNow(agentId);
    if (!view.wallet) throw fakeError("agent_not_found");
    return view.wallet;
  }

  async getBalances(agentId: string, query: { source?: BalanceSource; asset?: string } = {}): Promise<BalancesView> {
    this.calls.push({ method: "getBalances", agentId });
    const agent = this.#agent(agentId);
    const source = query.source ?? "public";
    const balances: BalanceEntry[] = source === "confidential" ? [] : [...agent.balances.entries()]
      .filter(([asset]) => !query.asset || asset === query.asset)
      .map(([asset, raw]) => {
        const t = this.#tokens.get(asset);
        const decimals = t?.decimals ?? DECIMALS[asset] ?? null;
        return {
          asset_id: asset,
          symbol: t?.symbol ?? null,
          decimals,
          blockchain: t?.blockchain ?? null,
          price: t?.price ?? null,
          price_updated_at: iso(this.clock.now()),
          price_expires_at: iso(this.clock.now() + 60_000),
          balance_raw: raw.toString(),
          balance: decimals === null ? null : decimal(raw, decimals),
          available_raw: raw.toString(),
          available: decimals === null ? null : decimal(raw, decimals),
        };
      });
    return { near_account_id: agent.view.wallet!.near_account_id, source, balances };
  }

  async quoteSwap(agentId: string, body: Omit<SwapRequest, "dry">): Promise<QuoteResponse> {
    this.calls.push({ method: "quoteSwap", agentId });
    this.#active(agentId);
    const { out, feeUsd, costBps, inUsd } = this.#price(body.origin_asset, body.destination_asset, BigInt(body.amount));
    const agent = this.#agent(agentId);
    const have = agent.balances.get(body.origin_asset) ?? 0n;
    const warnings: QuoteResponse["warnings"] =
      have < BigInt(body.amount)
        ? [{ code: "insufficient_balance", detail: "balance is lower than amount", available_amount: have.toString() }]
        : [];
    return {
      dry: true,
      type: "swap",
      quote: { amount_in: body.amount, amount_out: out.toString(), min_amount_out: body.min_amount_out ?? null, time_estimate: 10, fake: true },
      spend: { amount_usd: inUsd.toFixed(2), budget: emptyBudget() },
      owner_approval: false,
      fee: { amount_usd: feeUsd.toFixed(6), percent: (costBps / 100).toFixed(4) },
      warnings,
    };
  }

  async swap(agentId: string, body: Omit<SwapRequest, "dry">, keyed: Keyed): Promise<StatusResponse> {
    return this.#money("swap", agentId, body, keyed, () => {
      const amount = BigInt(body.amount);
      const { out } = this.#price(body.origin_asset, body.destination_asset, amount);
      this.#debit(agentId, body.origin_asset, amount, keyed.idempotencyKey);
      return {
        details: {
          action: "swap",
          request: { ...body },
          confidential: body.confidential ?? false,
          expected_amount_out: out.toString(),
          requested_min_amount_out: body.min_amount_out ?? "0",
        },
        credit: { agentId, asset: body.destination_asset, amount: out },
        refund: { asset: body.origin_asset, amount },
      };
    });
  }

  async transfer(agentId: string, body: TransferRequest, keyed: Keyed): Promise<StatusResponse> {
    return this.#money("transfer", agentId, body, keyed, () => {
      const target = [...this.#agents.values()].find((a) => a.view.wallet?.near_account_id === body.recipient);
      if (!target && !/^[0-9a-f]{64}$/.test(body.recipient)) throw fakeError("invalid_address", { detail: "named recipient does not exist" }, keyed.idempotencyKey);
      const amount = BigInt(body.amount);
      this.#debit(agentId, body.asset, amount, keyed.idempotencyKey);
      return {
        details: { action: "transfer", request: { ...body }, confidential: body.confidential ?? false },
        ...(target ? { credit: { agentId: target.view.id, asset: body.asset, amount } } : {}),
        refund: { asset: body.asset, amount },
      };
    });
  }

  async withdraw(agentId: string, body: WithdrawRequest, keyed: Keyed): Promise<StatusResponse | QuoteResponse> {
    if (body.dry) {
      this.calls.push({ method: "withdrawPreview", agentId, key: keyed.idempotencyKey });
      this.#active(agentId);
      this.#takeCustody(agentId, keyed.idempotencyKey);
      return {
        dry: true,
        type: "withdraw",
        quote: { amount_in: body.amount, fake: true },
        spend: { amount_usd: null, budget: emptyBudget() },
        owner_approval: false,
        fee: null,
        warnings: [],
      };
    }
    return this.#money("withdraw", agentId, body, keyed, () => {
      const amount = BigInt(body.amount);
      this.#debit(agentId, body.asset, amount, keyed.idempotencyKey);
      return { details: { action: "withdraw", request: { ...body }, chain: body.chain, confidential: body.confidential ?? false }, refund: { asset: body.asset, amount } };
    });
  }

  async deposit(agentId: string, body: DepositRequest, keyed: Keyed): Promise<StatusResponse> {
    this.calls.push({ method: "deposit", agentId, key: keyed.idempotencyKey });
    this.#active(agentId);
    const replay = this.#replay(keyed.idempotencyKey, body);
    if (replay) return replay;
    const correlationId = this.#nextOpId();
    const now = this.clock.now();
    const min = body.amount ?? "1000000";
    const status = this.#newStatus(correlationId, agentId, "deposit", "PENDING_DEPOSIT", {
      action: "deposit",
      request: { ...body },
      deposit_address: `FAKE-deposit-${correlationId}`,
      memo: null,
      min_amount: min,
      expires_at: iso(now + (body.amount ? 24 : 72) * 3_600_000),
      refund_to: this.#agent(agentId).view.wallet!.near_account_id,
      confidential: body.confidential ?? false,
    });
    const op: FakeOp = {
      status,
      scenario: this.#takeScenario(),
      settleAt: Number.POSITIVE_INFINITY,
      agentId,
      deposit: { asset: body.destination_asset ?? body.origin_asset },
      events: [{ action: "deposit_address_issued", at: now }],
    };
    this.#ops.set(correlationId, op);
    this.#keys.set(keyed.idempotencyKey, { body: JSON.stringify(body), result: status });
    if (this.#o.autoPayDepositsMs !== undefined) op.autoPayAt = now + this.#o.autoPayDepositsMs;
    return structuredClone(status);
  }

  async getStatus(correlationId: string, options: { waitMs?: number; refresh?: boolean } = {}): Promise<StatusResponse> {
    this.calls.push({ method: "getStatus" });
    const op = this.#op(correlationId);
    this.#advance(op);
    const wait = Math.min(options.waitMs ?? 0, 30_000);
    if (wait > 0 && !["SUCCESS", "REFUNDED", "FAILED", "NEEDS_REVIEW", "PENDING_SIGNATURE"].includes(op.status.status)) {
      const nextChange = this.#nextChange(op);
      await this.clock.sleep(Math.min(wait, Math.max(0, nextChange - this.clock.now())));
      this.#advance(op);
    }
    return structuredClone(op.status);
  }

  async getOperationProof(agentId: string, correlationId: string): Promise<OperationProof> {
    this.calls.push({ method: "getOperationProof", agentId });
    const op = this.#op(correlationId);
    if (op.agentId !== agentId) throw fakeError("operation_not_found");
    return {
      agent_id: agentId,
      correlation_id: correlationId,
      origin: "fake.agentsonintents.local/log",
      checkpoint: null,
      consistency: null,
      notary: null,
      events: op.events.map((e) => ({ action: e.action, created_at: iso(e.at), status: "UNLOGGED", proof: null, evidence: null })),
    };
  }

  // ——— Нутрощі ———

  async #money(
    type: ExecutionType,
    agentId: string,
    body: object,
    keyed: Keyed,
    admit: () => { details: ExecutionDetails; credit?: FakeOp["credit"]; refund?: FakeOp["refund"] },
  ): Promise<StatusResponse> {
    this.calls.push({ method: type, agentId, key: keyed.idempotencyKey });
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(keyed.idempotencyKey)) throw fakeError("validation_failed", { detail: "Idempotency-Key" });
    const replay = this.#replay(keyed.idempotencyKey, body);
    if (replay) return replay;
    this.#active(agentId);
    const agent = this.#agent(agentId);
    const now = this.clock.now();

    const injected = this.#errors[0];
    if (injected) {
      if (--injected.times <= 0) this.#errors.shift();
      const error = fakeError(injected.code, injected.availableAt ? { availableAt: injected.availableAt } : {}, keyed.idempotencyKey);
      if (injected.code === "wallet_busy") this.#keys.set(keyed.idempotencyKey, { body: JSON.stringify(body), error });
      throw error;
    }

    const scenario = this.#takeScenario();
    if (scenario === "busy" || agent.inFlight) {
      const error = fakeError("wallet_busy", { detail: "another money request is running on this wallet" }, keyed.idempotencyKey);
      this.#keys.set(keyed.idempotencyKey, { body: JSON.stringify(body), error });
      throw error;
    }
    if (scenario === "quota") throw fakeError("provider_limit_reached", { availableAt: iso(now + WINDOW) }, keyed.idempotencyKey);
    this.#takeCustody(agentId, keyed.idempotencyKey);

    const admitted = admit();
    const correlationId = this.#nextOpId();
    const status = this.#newStatus(correlationId, agentId, type, "PROCESSING", { ...admitted.details, near_account_id: agent.view.wallet!.near_account_id, provider_request_id: `FAKE-prq-${correlationId}` });
    this.#keys.set(keyed.idempotencyKey, { body: JSON.stringify(body), result: status });

    // HTTP тримається відкритим, поки провайдер приймає: гаманець зайнятий.
    agent.inFlight = true;
    try {
      await this.clock.sleep(this.#o.dispatchMs);
    } finally {
      agent.inFlight = false;
    }
    status.dispatch_committed_at = iso(this.clock.now());
    status.updated_at = iso(this.clock.now());

    const op: FakeOp = {
      status,
      scenario,
      settleAt: this.clock.now() + this.#settleDelay(scenario),
      agentId,
      ...(admitted.credit ? { credit: admitted.credit } : {}),
      ...(admitted.refund ? { refund: admitted.refund } : {}),
      events: [
        { action: "admitted", at: now },
        { action: "dispatched", at: this.clock.now() },
      ],
    };
    this.#ops.set(correlationId, op);
    return structuredClone(status);
  }

  #advance(op: FakeOp): void {
    const now = this.clock.now();
    if (op.deposit && op.status.status === "PENDING_DEPOSIT" && op.autoPayAt !== undefined && now >= op.autoPayAt) {
      this.payDeposit(op.status.correlation_id, op.status.details.min_amount ?? "1000000");
    }
    const s = op.status;
    if (s.status !== "PROCESSING" && s.status !== "UNCERTAIN") return;
    if (now < op.settleAt) return;

    if (op.scenario === "uncertain") {
      op.uncertainUntil ??= op.settleAt + this.#o.uncertainMs;
      if (now < op.uncertainUntil) {
        this.#set(op, "UNCERTAIN", "provider_answer_lost");
        return;
      }
    }

    const hash = (tag: string) => `FAKE-${createHash("sha256").update(`${tag}:${s.correlation_id}`).digest("hex").slice(0, 40)}`;
    switch (op.scenario) {
      case "refunded":
        if (op.refund) this.#credit(op.agentId, op.refund.asset, op.refund.amount);
        s.details.refund_tx_hash = hash("refund");
        s.details.tx_hash = hash("tx");
        this.#set(op, "REFUNDED", "route_refunded");
        return;
      case "failed":
        if (op.refund) this.#credit(op.agentId, op.refund.asset, op.refund.amount);
        s.details.never_executed = true;
        this.#set(op, "FAILED", "route_failed");
        return;
      case "needs_review":
        s.details.reason = "amount_out_below_minimum";
        s.details.tx_hash = hash("tx");
        this.#set(op, "NEEDS_REVIEW", "amount_out_below_minimum");
        return;
      default:
        if (op.credit) this.#credit(op.credit.agentId, op.credit.asset, op.credit.amount);
        s.details.tx_hash = hash("tx");
        if (s.type === "swap") {
          s.details.intent_hash = hash("intent");
          s.details.amount_out = op.credit?.amount.toString() ?? null;
        }
        if (s.type === "withdraw") s.details.destination_tx_hash = hash("dest");
        if (s.type === "deposit") s.details.delivered = op.credit?.amount.toString() ?? null;
        s.details.provider_status = "SUCCESS";
        this.#set(op, "SUCCESS", null);
    }
  }

  #set(op: FakeOp, status: Status, failure: string | null): void {
    if (op.status.status === status) return;
    op.status.status = status;
    op.status.failure_code = failure;
    op.status.updated_at = iso(this.clock.now());
    op.events.push({ action: status.toLowerCase(), at: this.clock.now() });
  }

  #nextChange(op: FakeOp): number {
    if (op.status.status === "PENDING_DEPOSIT") return op.autoPayAt ?? Number.POSITIVE_INFINITY;
    if (op.status.status === "UNCERTAIN") return op.uncertainUntil ?? op.settleAt;
    return op.settleAt;
  }

  #settleDelay(scenario: Scenario): number {
    const [lo, hi] = this.#o.settleMs;
    const base = Math.round(lo + (hi - lo) * this.#rand());
    return scenario === "slow" ? base * 6 : base;
  }

  #takeScenario(): Scenario {
    return this.#scenarios.shift() ?? this.#mode;
  }

  #takeCustody(agentId: string, key: string): void {
    const agent = this.#agent(agentId);
    const now = this.clock.now();
    agent.custody = agent.custody.filter((t) => t > now - WINDOW);
    if (agent.custody.length >= this.#o.custodyLimit) {
      throw fakeError("provider_limit_reached", { availableAt: iso(agent.custody[0]! + WINDOW) }, key);
    }
    agent.custody.push(now);
  }

  #replay(key: string, body: object): StatusResponse | undefined {
    const entry = this.#keys.get(key);
    if (!entry) return undefined;
    if (entry.body !== JSON.stringify(body)) throw fakeError("idempotency_conflict", {}, key);
    if (entry.error) throw entry.error;
    const op = entry.result ? this.#ops.get(entry.result.correlation_id) : undefined;
    if (op) this.#advance(op);
    return structuredClone(op?.status ?? entry.result);
  }

  #price(from: string, to: string, amount: bigint): { out: bigint; feeUsd: number; costBps: number; inUsd: number } {
    const a = this.#tokens.get(from);
    const b = this.#tokens.get(to);
    if (!a || !b) throw fakeError("unsupported_token");
    if (from === to) throw fakeError("validation_failed", { detail: "assets must differ" });
    const costBps = Math.max(a.costBps, b.costBps);
    // Ціни як цілі мікродолари, щоб не губити точність у bigint.
    const pa = BigInt(Math.round(a.price * 1e6));
    const pb = BigInt(Math.round(b.price * 1e6));
    const gross = (amount * pa * 10n ** BigInt(b.decimals)) / (pb * 10n ** BigInt(a.decimals));
    const out = (gross * BigInt(10_000 - costBps)) / 10_000n;
    const inUsd = (Number(amount) / 10 ** a.decimals) * a.price;
    return { out, feeUsd: (inUsd * costBps) / 10_000, costBps, inUsd };
  }

  #debit(agentId: string, asset: string, amount: bigint, key: string): void {
    const agent = this.#agent(agentId);
    const have = agent.balances.get(asset) ?? 0n;
    if (amount <= 0n) throw fakeError("validation_failed", { detail: "amount must be greater than zero" }, key);
    if (have < amount) throw fakeError("insufficient_balance", { availableAmount: have.toString() }, key);
    agent.balances.set(asset, have - amount);
  }

  #credit(agentId: string, asset: string, amount: bigint): void {
    const agent = this.#agent(agentId);
    agent.balances.set(asset, (agent.balances.get(asset) ?? 0n) + amount);
  }

  #newStatus(correlationId: string, agentId: string, type: ExecutionType, status: Status, details: ExecutionDetails): StatusResponse {
    const now = iso(this.clock.now());
    return {
      correlation_id: correlationId,
      agent_id: agentId,
      status,
      failure_code: null,
      created_at: now,
      updated_at: now,
      dispatch_committed_at: null,
      grant: type === "deposit" ? null : { id: "grt_fake", label: "fake" },
      type,
      details,
    };
  }

  #nextOpId(): string {
    return `op_fake${String(++this.#seq).padStart(6, "0")}`;
  }

  #viewNow(agentId: string): AgentView {
    const agent = this.#agent(agentId);
    if (agent.view.status === "PENDING" && this.clock.now() >= agent.activeAt) agent.view.status = "ACTIVE";
    return structuredClone(agent.view);
  }

  #active(agentId: string): void {
    if (this.#viewNow(agentId).status !== "ACTIVE") throw new AgentApiError(409, { errors: [{ status: "409", code: "agent_not_bound", layer: "request", title: "Agent not bound" }], meta: {} });
  }

  #agent(agentId: string): FakeAgent {
    const agent = this.#agents.get(agentId);
    if (!agent) throw fakeError("agent_not_found");
    return agent;
  }

  #op(correlationId: string): FakeOp {
    const op = this.#ops.get(correlationId);
    if (!op) throw fakeError("operation_not_found");
    return op;
  }
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function decimal(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${raw / base}${frac ? `.${frac}` : ""}`;
}

function emptyBudget(): BudgetView {
  const w = { limit_usd: null, spent_usd: null, remaining_usd: null, resets_at: null };
  return { daily: { ...w }, weekly: { ...w }, monthly: { ...w } };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
