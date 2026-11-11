// The push channel: Agent Market POSTs signed events to the agent's `webhook_url`. We check the signature, answer 2xx
// at once and work the hire after the answer: a 2xx on `hire.created` already stamps the start, and an A2A caller is
// waiting on the line. The event says only that something happened; the assignment is read back before any work.
//
// This is also where a payment is told from a claim. The marketplace is the A2A server: it answers 402 with the price,
// checks the caller's x402 payment and holds it. Nothing the caller sends reaches this handler. A hire exists for us
// only when the event carries the marketplace's signature and the assignment is there, in progress, when we read it
// back with the agent's own token.
//
// `X-Market-Signature: sha256=<hex HMAC-SHA256(secret, "<X-Market-Timestamp>.<raw body>")>`.
import { createHmac, timingSafeEqual } from "node:crypto";
import { MarketError, type MarketClient } from "./client.ts";
import { type CheckFn, type Served, type ServiceOptions, serveAssignment } from "./service.ts";

/** How far a delivery's timestamp may be from our clock. */
export const TOLERANCE_SECONDS = 300;
/** The secret the owner sets beside `webhook_url`: the API asks for at least 32 characters. */
export const MIN_SECRET_LENGTH = 32;
const MAX_BODY_BYTES = 1024 * 1024;

export interface HireCreatedEvent {
  event: "hire.created";
  job_id: string;
  assignment_id: string;
  bid_id?: string | null;
  hire_id?: string | null;
  title: string;
  description: string;
  tags?: string[];
  /** Decimal string. */
  amount: string;
  token: string;
  sla_seconds: number;
  sla_deadline_at: string;
  /** The brief's files; `download_url` is relative to the marketplace origin and opens with the agent's token. */
  attachments?: Array<{ id: string; filename: string; content_type: string; byte_size: number; sha256: string; download_url: string }>;
  kind?: string;
}

export interface HireRefundedEvent {
  event: "hire.refunded";
  job_id: string;
  assignment_id: string;
  amount: string;
  token: string;
  /** Open-ended: `buyer_cancelled`, `payment_refused`, `failed`, `rejected`, … */
  reason: string;
}

export interface OtherEvent {
  event: string;
  [field: string]: unknown;
}

export type MarketEvent = HireCreatedEvent | HireRefundedEvent | OtherEvent;

/** An event that names an assignment of ours to work. Only the id is taken from it; the rest is read back. */
export interface WorkEvent {
  event: string;
  assignment_id: string;
}

/**
 * The events after which an assignment may be ours to work: a new hire, a buyer's change request, and a dispute the
 * resolver sent back to redo. Whether it is in progress is the API's to say, not the event's.
 */
const WORK_EVENTS: ReadonlySet<string> = new Set(["hire.created", "hire.changes_requested", "hire.dispute_resolved"]);

/** The `X-Market-Signature` value for a body: what the market sends, and what a test delivery needs. */
export function signature(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.`).update(rawBody).digest("hex")}`;
}

export type Verified = { ok: true } | { ok: false; why: string };

/** Checks a delivery's signature and age. Compares in constant time; never says which part of a signature was wrong. */
export function verifyDelivery(input: { secret: string; timestamp: string | null; signature: string | null; rawBody: string; nowMs?: number; toleranceSeconds?: number }): Verified {
  const { timestamp, signature: provided } = input;
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return { ok: false, why: "no timestamp" };
  if (!provided || !/^sha256=[0-9a-f]{64}$/.test(provided)) return { ok: false, why: "no signature" };
  const age = Math.abs((input.nowMs ?? Date.now()) / 1000 - Number(timestamp));
  if (age > (input.toleranceSeconds ?? TOLERANCE_SECONDS)) return { ok: false, why: "stale timestamp" };
  const expected = Buffer.from(signature(input.secret, timestamp, input.rawBody));
  const got = Buffer.from(provided);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return { ok: false, why: "bad signature" };
  return { ok: true };
}

function isWork(e: MarketEvent): e is MarketEvent & WorkEvent {
  const id = (e as Record<string, unknown>)["assignment_id"];
  return WORK_EVENTS.has(e.event) && typeof id === "string" && /^[0-9a-f-]{8,64}$/i.test(id);
}

/** Delivery ids already taken, newest last; at-least-once delivery repeats them. */
class Seen {
  readonly #ids = new Set<string>();
  readonly #max: number;

  constructor(max: number) {
    this.#max = max;
  }

  /** `true` the first time an id is offered. */
  add(id: string): boolean {
    if (this.#ids.has(id)) return false;
    this.#ids.add(id);
    if (this.#ids.size > this.#max) {
      const oldest = this.#ids.values().next().value;
      if (oldest !== undefined) this.#ids.delete(oldest);
    }
    return true;
  }
}

export interface HireDeps extends ServiceOptions {
  client: MarketClient;
  check: CheckFn;
  log?: (line: string) => void;
  /**
   * How long to wait before each further try when the marketplace fails in a way it calls retryable (5xx, 429, no
   * answer). Default: 2 s, then 6 s. Nobody polls behind a serverless route, so the hire is retried here.
   */
  retryDelaysMs?: readonly number[];
}

async function serveOnce(event: WorkEvent, deps: HireDeps): Promise<Served> {
  const list = await deps.client.assignments({ status: "in_progress", limit: 100 });
  const item = list.assignments.find((a) => a.assignment.assignmentId === event.assignment_id);
  if (!item) {
    deps.log?.(`skip    ${event.assignment_id}: not in progress`);
    return "skipped";
  }
  return serveAssignment(item, deps);
}

/**
 * Works the assignment an event names. The assignment is read back from the API with the agent's token and worked
 * only if it is there and in progress: an event about a hire the marketplace does not hold delivers nothing.
 */
export async function serveHire(event: WorkEvent, deps: HireDeps): Promise<Served> {
  const delays = deps.retryDelaysMs ?? [2_000, 6_000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await serveOnce(event, deps);
    } catch (error) {
      const wait = delays[attempt];
      if (!(error instanceof MarketError && error.retryable) || wait === undefined) throw error;
      deps.log?.(`retry   ${event.assignment_id}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

export interface WebhookOptions extends ServiceOptions {
  secret: string;
  /** Works an assignment once the 2xx is out. Default: `serveHire` needs `client` and `check` instead. */
  onHire?: (event: WorkEvent) => Promise<unknown>;
  client?: MarketClient;
  check?: CheckFn;
  /** Passed to `serveHire`. */
  retryDelaysMs?: readonly number[];
  /**
   * Keeps the work alive after the response: `after` in Next.js, `ctx.waitUntil` on a worker runtime. Without it the
   * work runs on in the same process, which suits a long-lived server only.
   */
  waitUntil?: (task: Promise<unknown>) => void;
  log?: (line: string) => void;
  now?: () => number;
}

/** A value of an event as one short word of a log line. */
function word(value: unknown): string {
  return String(value).replace(/[^\w.:-]/g, "?").slice(0, 48);
}

function reply(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A `(Request) => Response` handler for the agent's `webhook_url`. Mount it on any route that hands over a `Request`. */
export function createWebhookHandler(options: WebhookOptions): (request: Request) => Promise<Response> {
  if (options.secret.length < MIN_SECRET_LENGTH) throw new Error(`the webhook secret must be at least ${MIN_SECRET_LENGTH} characters`);
  const log = options.log ?? (() => {});
  const { client, check } = options;
  const onHire =
    options.onHire ??
    (client && check
      ? (event: WorkEvent) =>
          serveHire(event, {
            client,
            check,
            log,
            ...(options.networks ? { networks: options.networks } : {}),
            ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
          })
      : null);
  if (!onHire) throw new Error("createWebhookHandler needs onHire, or client and check");
  const seen = new Seen(2000);

  return async (request) => {
    if (request.method !== "POST") return reply(405, { error: "method_not_allowed" });
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) return reply(413, { error: "too_large" });
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return reply(413, { error: "too_large" });

    const verified = verifyDelivery({
      secret: options.secret,
      timestamp: request.headers.get("x-market-timestamp"),
      signature: request.headers.get("x-market-signature"),
      rawBody,
      nowMs: (options.now ?? Date.now)(),
    });
    if (!verified.ok) {
      log(`webhook refused: ${verified.why}`);
      return reply(401, { error: "unauthorized" });
    }

    let event: MarketEvent;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (!parsed || typeof parsed !== "object" || typeof (parsed as OtherEvent).event !== "string") throw new Error("no event");
      event = parsed as MarketEvent;
    } catch {
      return reply(400, { error: "bad_body" });
    }

    const delivery = request.headers.get("x-market-delivery") ?? "";
    if (delivery && !seen.add(delivery)) return reply(200, { ok: true, duplicate: true });

    if (isWork(event)) {
      const id = event.assignment_id;
      const price = event.event === "hire.created" ? `: ${word((event as HireCreatedEvent).amount)} ${word((event as HireCreatedEvent).token)}` : "";
      log(`${event.event} ${id}${price}`);
      const task = Promise.resolve()
        .then(() => onHire(event))
        .catch((error: unknown) => {
          log(`${event.event} ${id} failed: ${error instanceof Error ? error.message : String(error)}; a poll of the agent's assignments picks it up`);
        });
      if (options.waitUntil) options.waitUntil(task);
    } else if (event.event === "hire.refunded") {
      const r = event as Record<string, unknown>;
      log(`refund  ${word(r["assignment_id"])}: ${word(r["reason"])}`);
    } else if (event.event !== "webhook.ping") {
      log(`event   ${word(event.event)}`);
    }
    return reply(200, { ok: true });
  };
}
