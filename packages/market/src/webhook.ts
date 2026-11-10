// The push channel: Agent Market POSTs signed events to the agent's `webhook_url`. We check the signature, answer 2xx
// at once and work the hire after the answer: a 2xx on `hire.created` already stamps the start, and an A2A caller is
// waiting on the line. The event says only that something happened; the assignment is read back before any work.
//
// `X-Market-Signature: sha256=<hex HMAC-SHA256(secret, "<X-Market-Timestamp>.<raw body>")>`.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { MarketClient } from "./client.ts";
import { type CheckFn, type Served, serveAssignment } from "./service.ts";

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

function isHireCreated(e: MarketEvent): e is HireCreatedEvent {
  const r = e as Record<string, unknown>;
  return r["event"] === "hire.created" && typeof r["assignment_id"] === "string" && typeof r["title"] === "string" && typeof r["description"] === "string";
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

export interface HireDeps {
  client: MarketClient;
  check: CheckFn;
  log?: (line: string) => void;
}

/** Works a `hire.created`: the assignment is read back from the API and worked only if it is still ours to work. */
export async function serveHire(event: HireCreatedEvent, deps: HireDeps): Promise<Served> {
  const list = await deps.client.assignments({ status: "in_progress", limit: 100 });
  const item = list.assignments.find((a) => a.assignment.assignmentId === event.assignment_id);
  if (!item) {
    deps.log?.(`skip    ${event.assignment_id}: no longer in progress`);
    return "skipped";
  }
  return serveAssignment(item, deps);
}

export interface WebhookOptions {
  secret: string;
  /** Works a new hire once the 2xx is out. Default: `serveHire` needs `client` and `check` instead. */
  onHire?: (event: HireCreatedEvent) => Promise<unknown>;
  client?: MarketClient;
  check?: CheckFn;
  /**
   * Keeps the work alive after the response: `after` in Next.js, `ctx.waitUntil` on a worker runtime. Without it the
   * work runs on in the same process, which suits a long-lived server only.
   */
  waitUntil?: (task: Promise<unknown>) => void;
  log?: (line: string) => void;
  now?: () => number;
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
      ? (event: HireCreatedEvent) => serveHire(event, { client, check, log })
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

    if (isHireCreated(event)) {
      log(`hire    ${event.assignment_id}: ${event.amount} ${event.token}`);
      const task = Promise.resolve()
        .then(() => onHire(event))
        .catch((error: unknown) => {
          log(`hire    ${event.assignment_id} failed: ${error instanceof Error ? error.message : String(error)}; the poll picks it up again`);
        });
      if (options.waitUntil) options.waitUntil(task);
    } else if (event.event === "hire.refunded") {
      const r = event as Record<string, unknown>;
      log(`refund  ${String(r["assignment_id"])}: ${String(r["reason"])}`);
    } else if (event.event !== "webhook.ping") {
      log(`event   ${event.event}`);
    }
    return reply(200, { ok: true });
  };
}
