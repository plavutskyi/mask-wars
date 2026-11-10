// Фейк Agent API по HTTP: ті самі шляхи, заголовки й коди, що в проду. Для HttpAgentApi, двигуна й `pnpm demo`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AgentApiError } from "../errors.ts";
import type { FakeAgentApi } from "./api.ts";
import { errorDocument } from "./scenarios.ts";

export interface FakeServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export async function serveFake(fake: FakeAgentApi, options: { port?: number; host?: string } = {}): Promise<FakeServer> {
  const server = createServer((req, res) => {
    handle(fake, req, res).catch((error: unknown) => send(res, 500, errorDocument("internal_error", { detail: String(error) })));
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function handle(fake: FakeAgentApi, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://fake");
  const method = req.method ?? "GET";
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const key = header(req, "idempotency-key");
  const body = method === "POST" ? await readJson(req) : undefined;

  try {
    if (parts[0] !== "v1") return send(res, 404, errorDocument("not_found"));
    if (method === "GET" && parts[1] === "tokens") return send(res, 200, { data: await fake.getTokens() });
    if (!header(req, "x-api-key")) return send(res, 401, errorDocument("invalid_api_key"));

    if (method === "GET" && parts[1] === "status") {
      const id = url.searchParams.get("correlation_id") ?? "";
      const waitMs = Number(url.searchParams.get("wait_ms") ?? 0);
      return send(res, 200, await fake.getStatus(id, { waitMs }));
    }
    if (parts[1] !== "agents") return send(res, 404, errorDocument("not_found"));
    if (parts.length === 2 && method === "GET") {
      const query: { external_user_id?: string } = {};
      const ext = url.searchParams.get("external_user_id");
      if (ext) query.external_user_id = ext;
      return send(res, 200, await fake.listAgents(query));
    }
    const agentId = parts[2]!;
    const action = parts[3];
    if (method === "GET") {
      if (action === undefined) return send(res, 200, await fake.getAgent(agentId));
      if (action === "wallet") return send(res, 200, await fake.getWallet(agentId));
      if (action === "balances") {
        const source = url.searchParams.get("source");
        const asset = url.searchParams.get("asset");
        return send(res, 200, await fake.getBalances(agentId, { ...(source === "public" || source === "confidential" ? { source } : {}), ...(asset ? { asset } : {}) }));
      }
      if (action === "operations" && parts[5] === "proof") return send(res, 200, await fake.getOperationProof(agentId, parts[4]!));
      return send(res, 404, errorDocument("not_found"));
    }

    const b = (body ?? {}) as Record<string, unknown>;
    if (action === "swap" && b["dry"] === true) {
      const { dry: _dry, ...rest } = b;
      return send(res, 200, await fake.quoteSwap(agentId, rest as never));
    }
    if (action === "deposit") {
      if (!key) return send(res, 400, errorDocument("idempotency_key_required"));
      return send(res, 202, await fake.deposit(agentId, b as never, { idempotencyKey: key }));
    }
    if (action === "swap" || action === "transfer" || action === "withdraw") {
      if (!key) return send(res, 400, errorDocument("idempotency_key_required"));
      if (!header(req, "x-grant-token")) return send(res, 403, errorDocument("agent_grant_required"));
      const keyed = { idempotencyKey: key };
      if (action === "swap") return send(res, 202, await fake.swap(agentId, b as never, keyed));
      if (action === "transfer") return send(res, 202, await fake.transfer(agentId, b as never, keyed));
      const result = await fake.withdraw(agentId, b as never, keyed);
      return send(res, "dry" in result ? 200 : 202, result);
    }
    return send(res, 404, errorDocument("not_found"));
  } catch (error) {
    if (error instanceof AgentApiError) {
      const doc = errorDocument(error.code, {
        detail: error.message,
        retryable: error.retryable,
        ...(error.availableAt ? { availableAt: error.availableAt } : {}),
        ...(error.availableAmount ? { availableAmount: error.availableAmount } : {}),
      });
      return send(res, error.status, doc, error.retryAfterSeconds);
    }
    throw error;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown, retryAfter?: number): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (retryAfter !== undefined) headers["retry-after"] = String(retryAfter);
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}
