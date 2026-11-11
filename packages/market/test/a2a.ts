// A stand-in for the marketplace's side of a paid call, built from its docs and from live recordings. In production
// this half is Agent Market's own code: it is the A2A server on `https://<handle>.market.near.ai/a2a/v1`, it answers
// 402 with the price, checks the caller's x402 payment, holds it, opens the hire, signs the webhook, and settles when
// the agent delivers. Our agent never sees the caller or the payment; it sees a signed event and its own assignments.
//
// - the 402 body: `recorded/quote-live.json`, a live quote of a real agent, and `/skill/x402-caller/SKILL.md`;
// - the payees: `recorded/x402-recipients.json`, live from `/.well-known/x402`;
// - the hire, the webhook and its signature: `/skill/flows/a2a-x402.md`, `/skill/reference/webhooks.md`;
// - the worker endpoints: `openapi.subset.json`.
//
// A real payment is one NEP-366 signed delegate action (`ft_transfer` of USDC to the treasury). Here a wallet is an
// ed25519 key the stand-in knows, and the signed bytes are the transfer as JSON: enough to tell a payment that is
// valid, forged, altered or used twice.
import { type KeyObject, createHmac, generateKeyPairSync, randomUUID, sign as edSign, verify as edVerify } from "node:crypto";
import type { JobAssignment, MyAssignmentItem, X402Recipient } from "../src/api.ts";
import { atomicUsdc } from "../src/profile.ts";

/** What the marketplace adds to the job's window for the payment's validity: 10 minutes. */
export const PAYMENT_GRACE_SECONDS = 600;

/** One row of `accepts[]`, field for field as the marketplace sends it. */
export interface AcceptRow {
  amount: string;
  asset: string;
  maxTimeoutSeconds: number;
  network: string;
  payTo: string;
  scheme: "exact";
}

export interface Challenge {
  accepts: AcceptRow[];
  error: string;
  x402Version: 2;
}

/** The row the marketplace quotes for a plan: the price in atomic USDC, valid for the job's window plus 10 minutes. */
export function quoteRow(priceAmount: string, slaSeconds: number, recipient: X402Recipient): AcceptRow {
  return { amount: atomicUsdc(priceAmount), asset: recipient.asset, maxTimeoutSeconds: slaSeconds + PAYMENT_GRACE_SECONDS, network: recipient.network, payTo: recipient.payTo, scheme: "exact" };
}

export interface Wallet {
  account: string;
  key: KeyObject;
}

interface Transfer {
  sender: string;
  receiver_id: string;
  ft_transfer: { receiver_id: string; amount: string };
  nonce: string;
}

export interface TaskView {
  id: string;
  contextId: string;
  status: { state: "TASK_STATE_SUBMITTED" | "TASK_STATE_WORKING" | "TASK_STATE_COMPLETED" | "TASK_STATE_REJECTED" | "TASK_STATE_FAILED" | "TASK_STATE_CANCELED"; timestamp: string };
  artifacts?: Array<{ artifactId: string; name: string; parts: Array<{ text: string }> }>;
}

export interface CallAnswer {
  status: number;
  body: { result?: { task: TaskView }; error?: unknown; accepts?: AcceptRow[]; x402Version?: number; jsonrpc?: string; id?: number };
}

interface Hire {
  item: MyAssignmentItem;
  task: TaskView;
  payer: string;
  amount: string;
}

export interface FakeMarketplaceOptions {
  /** The agent's default plan. */
  price: string;
  slaSeconds: number;
  recipient: X402Recipient;
  /** The agent's `aat_` token: the worker endpoints answer to nothing else. */
  token: string;
  /** The secret beside the agent's `webhook_url`. */
  secret: string;
  now: () => number;
  /**
   * The facilitator refuses to hold the payment after the hire opened, and the marketplace cancels the hire: `at_once`,
   * right after the event went out, or `before_submit`, when the agent has already done the work.
   */
  holdRefused?: "at_once" | "before_submit";
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeMarketplace {
  readonly hires = new Map<string, Hire>();
  /** Money that moved: one row per delivered call. */
  readonly settled: Array<{ assignmentId: string; payer: string; amount: string }> = [];
  /** Every webhook the marketplace sent, with the status our handler answered. */
  readonly deliveries: Array<{ event: string; delivery: string; status: number }> = [];
  /** Every worker call our agent made. */
  readonly calls: string[] = [];
  readonly #o: FakeMarketplaceOptions;
  readonly #wallets = new Map<string, KeyObject>();
  readonly #spent = new Set<string>();
  #hook: (request: Request) => Promise<Response> = async () => json(503, {});
  #idle: () => Promise<unknown> = async () => {};

  constructor(options: FakeMarketplaceOptions) {
    this.#o = options;
  }

  /** The agent's `webhook_url`, and a way to wait until its work after the 2xx is done. */
  connect(hook: (request: Request) => Promise<Response>, idle: () => Promise<unknown>): void {
    this.#hook = hook;
    this.#idle = idle;
  }

  /** Resolves when the agent has finished whatever it took on after its last 2xx. */
  async idle(): Promise<void> {
    await this.#idle();
  }

  get row(): AcceptRow {
    return quoteRow(this.#o.price, this.#o.slaSeconds, this.#o.recipient);
  }

  /** A wallet with USDC: its public key is on the chain the stand-in reads. */
  wallet(account: string): Wallet {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    this.#wallets.set(account, publicKey);
    return { account, key: privateKey };
  }

  /** The `X-PAYMENT` header a caller builds from a quoted row: the row as received, and the signed transfer. */
  pay(wallet: Wallet, row: AcceptRow, nonce: string = randomUUID()): string {
    const transfer: Transfer = { sender: wallet.account, receiver_id: row.asset, ft_transfer: { receiver_id: row.payTo, amount: row.amount }, nonce };
    const bytes = Buffer.from(JSON.stringify(transfer));
    const signedDelegateAction = Buffer.from(JSON.stringify({ transfer, signature: edSign(null, bytes, wallet.key).toString("base64") })).toString("base64");
    return Buffer.from(JSON.stringify({ x402Version: 2, accepted: row, payload: { signedDelegateAction } })).toString("base64");
  }

  /** Why the facilitator would not take this header, or the payer it is good for. */
  #verify(header: string): { ok: true; payer: string } | { ok: false; why: string } {
    let parsed: { x402Version?: unknown; accepted?: unknown; payload?: { signedDelegateAction?: unknown } };
    let signed: { transfer?: Transfer; signature?: string };
    try {
      parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as typeof parsed;
      signed = JSON.parse(Buffer.from(String(parsed.payload?.signedDelegateAction ?? ""), "base64").toString("utf8")) as typeof signed;
    } catch {
      return { ok: false, why: "malformed x-payment header" };
    }
    const row = this.row;
    if (parsed.x402Version !== 2 || JSON.stringify(parsed.accepted) !== JSON.stringify(row)) return { ok: false, why: "accepted does not match the quoted row" };
    const t = signed.transfer;
    const key = t ? this.#wallets.get(t.sender) : undefined;
    if (!t || !key || !signed.signature) return { ok: false, why: "payment signature is not valid" };
    if (!edVerify(null, Buffer.from(JSON.stringify(t)), key, Buffer.from(signed.signature, "base64"))) return { ok: false, why: "payment signature is not valid" };
    if (t.receiver_id !== row.asset || t.ft_transfer.receiver_id !== row.payTo || t.ft_transfer.amount !== row.amount) return { ok: false, why: "payment does not match the quoted row" };
    if (this.#spent.has(header)) return { ok: false, why: "payment was already used" };
    return { ok: true, payer: t.sender };
  }

  #challenge(error: string): CallAnswer {
    const body: Challenge = { accepts: [this.row], error, x402Version: 2 };
    return { status: 402, body };
  }

  async #deliver(event: string, body: Record<string, unknown>, delivery: string = randomUUID()): Promise<number> {
    const raw = JSON.stringify({ event, ...body });
    const timestamp = String(Math.floor(this.#o.now() / 1000));
    // As the marketplace documents it: HMAC-SHA256 over `<timestamp>.<raw body>`.
    const signature = `sha256=${createHmac("sha256", this.#o.secret).update(`${timestamp}.`).update(raw).digest("hex")}`;
    const res = await this.#hook(
      new Request("https://agent.example/api/market/hook", {
        method: "POST",
        headers: { "content-type": "application/json", "x-market-event": event, "x-market-delivery": delivery, "x-market-timestamp": timestamp, "x-market-signature": signature },
        body: raw,
      }),
    );
    this.deliveries.push({ event, delivery, status: res.status });
    return res.status;
  }

  /** Sends the `hire.created` of an assignment again, as a retry of one delivery or as a new one. */
  async redeliver(assignmentId: string, delivery?: string): Promise<number> {
    const hire = this.hires.get(assignmentId);
    if (!hire) throw new Error(`no hire ${assignmentId}`);
    const status = await this.#deliver("hire.created", this.#hireCreated(hire), delivery);
    await this.#idle();
    return status;
  }

  #hireCreated(hire: Hire): Record<string, unknown> {
    const a = hire.item.assignment;
    return {
      job_id: a.jobId,
      assignment_id: a.assignmentId,
      bid_id: null,
      hire_id: hire.task.contextId,
      title: hire.item.job.title,
      description: hire.item.job.description,
      tags: [],
      amount: this.#o.price,
      token: "USDC",
      sla_seconds: a.slaSeconds,
      sla_deadline_at: a.slaDeadlineAt,
      attachments: [],
      kind: "instant",
    };
  }

  /** `POST https://<handle>.<marketplace>/a2a/v1`, method `SendMessage`: the text of the message, and the header if any. */
  async call(text: string, xPayment?: string): Promise<CallAnswer> {
    if (xPayment === undefined) return this.#challenge("x-payment header is required");
    const verified = this.#verify(xPayment);
    if (!verified.ok) return this.#challenge(verified.why);
    this.#spent.add(xPayment);

    const at = new Date(this.#o.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const [title = "", ...rest] = text.split("\n");
    const assignmentId = randomUUID();
    const jobId = randomUUID();
    const assignment: JobAssignment = {
      assignmentId,
      jobId,
      workerAgentId: "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      bidId: null,
      status: "in_progress",
      escrowAmount: `${Number(this.#o.price).toFixed(12)}`,
      escrowToken: "USDC",
      slaSeconds: this.#o.slaSeconds,
      slaDeadlineAt: new Date(this.#o.now() + this.#o.slaSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      acceptanceWindowDays: 3,
      startedAt: null,
      submittedAt: null,
      deliverableUrl: null,
      deliverableHash: null,
      cancelReason: null,
      cancelDetail: null,
      finalizedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    const hire: Hire = {
      item: { assignment, job: { jobId, title, description: rest.join("\n"), tags: [], jobKind: "instant", status: "in_progress", entriesCloseAt: null, attachments: [] }, latestMessage: null, autoAcceptAt: null },
      task: { id: randomUUID(), contextId: randomUUID(), status: { state: "TASK_STATE_SUBMITTED", timestamp: at } },
      payer: verified.payer,
      amount: this.row.amount,
    };
    this.hires.set(assignmentId, hire);

    // The event is recorded when the hire opens; the hold comes after it and may be refused.
    const answered = await this.#deliver("hire.created", this.#hireCreated(hire));
    if (this.#o.holdRefused === "at_once") await this.#refuseHold(hire);
    else if (answered >= 200 && answered < 300) assignment.startedAt ??= at; // a 2xx on hire.created stamps the start
    // The call waits on the connection while the agent works.
    await this.#idle();
    return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { task: hire.task } } };
  }

  /** A refused hold cancels the hire: nothing is owed either way, and the agent is told with `hire.refunded`. */
  async #refuseHold(hire: Hire): Promise<void> {
    const a = hire.item.assignment;
    if (a.status !== "in_progress") return;
    a.status = "cancelled";
    a.cancelReason = "buyer_cancelled";
    hire.task.status = { state: "TASK_STATE_CANCELED", timestamp: a.createdAt };
    await this.#deliver("hire.refunded", { job_id: a.jobId, assignment_id: a.assignmentId, amount: this.#o.price, token: "USDC", reason: "buyer_cancelled" });
  }

  /** `GetTask`: free, by the task id alone. */
  task(id: string): TaskView | null {
    for (const h of this.hires.values()) if (h.task.id === id) return h.task;
    return null;
  }

  /** The REST API as the agent's client calls it. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${this.#o.token}`) return json(401, { error: "unauthorized", message: "unauthorized" });
    if (method === "GET" && url.pathname === "/v1/agents/me/assignments") {
      const status = url.searchParams.get("status") ?? "in_progress";
      return json(200, { assignments: [...this.hires.values()].map((h) => h.item).filter((i) => status === "all" || i.assignment.status === status) });
    }
    const m = /^\/v1\/assignments\/([0-9a-f-]{36})\/(start|submit|decline)$/.exec(url.pathname);
    const hire = m ? this.hires.get(m[1] as string) : undefined;
    if (method !== "POST" || !m) return json(404, { error: "not_found", message: "not found" });
    if (!hire) return json(404, { error: "not_found", message: "not found" });
    const a = hire.item.assignment;
    const at = new Date(this.#o.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const moved = (to: string) => json(400, { error: "invalid_state_transition", message: `cannot transition from '${a.status}' to '${to}'` });
    if (m[2] === "start") {
      if (a.status !== "in_progress") return moved("in_progress");
      a.startedAt ??= at;
      return json(200, { startedAt: a.startedAt });
    }
    if (m[2] === "submit") {
      if (this.#o.holdRefused === "before_submit") await this.#refuseHold(hire);
      if (a.status !== "in_progress") return moved("submitted");
      const markdown = body["deliverableMarkdown"];
      if (typeof markdown !== "string" || markdown.length === 0) return json(400, { error: "invalid_deliverable", message: "empty" });
      // An A2A job: the submit is accepted at once, and the caller's payment settles then.
      a.status = "accepted";
      a.submittedAt = at;
      a.finalizedAt = at;
      this.settled.push({ assignmentId: a.assignmentId, payer: hire.payer, amount: hire.amount });
      hire.task.status = { state: "TASK_STATE_COMPLETED", timestamp: at };
      hire.task.artifacts = [{ artifactId: randomUUID(), name: "answer", parts: [{ text: markdown }] }];
      return json(200, a);
    }
    if (a.status !== "in_progress") return moved("cancelled");
    a.status = "cancelled";
    a.cancelReason = String(body["reason"] ?? "");
    a.cancelDetail = typeof body["detail"] === "string" ? body["detail"] : null;
    hire.task.status = { state: body["reason"] === "rejected" ? "TASK_STATE_REJECTED" : "TASK_STATE_FAILED", timestamp: at };
    return json(200, a);
  };
}
