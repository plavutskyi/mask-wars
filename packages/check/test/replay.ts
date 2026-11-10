// What NEAR RPC answered MASK CHECK on real accounts (test/recorded/*.json, `pnpm --filter @maskwars/check record`),
// served back without a network. A request is matched by its endpoint, method and params; the JSON-RPC id is ignored.

export interface Exchange {
  url: string;
  method: string;
  params: unknown;
  status: number;
  response: unknown;
}

export interface RecordedCheck {
  account: string;
  verdict: string;
  codes: string[];
}

export interface Recording {
  network: "testnet" | "mainnet";
  /** When the answers were recorded, ISO time. */
  recorded_at: string;
  about: string;
  endpoints: string[];
  /** What each check answered live, for the replay to match. */
  checks: RecordedCheck[];
  exchanges: Exchange[];
}

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)]));
  }
  return v;
}

export const keyOf = (url: string, method: string, params: unknown) => `${url} ${method} ${JSON.stringify(sorted(params))}`;

export function bodyOf(init?: RequestInit): { method: string; params: unknown } {
  return JSON.parse(String(init?.body)) as { method: string; params: unknown };
}

/** A fetch that answers from a recording; a request nobody recorded fails like a network error. */
export function replayFetch(rec: Recording): { fetch: typeof fetch; requests: { url: string; method: string; params: Record<string, unknown> }[] } {
  const answers = new Map(rec.exchanges.map((e) => [keyOf(e.url, e.method, e.params), e]));
  const requests: { url: string; method: string; params: Record<string, unknown> }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const { method, params } = bodyOf(init);
    requests.push({ url, method, params: params as Record<string, unknown> });
    const hit = answers.get(keyOf(url, method, params));
    if (!hit) throw new TypeError(`fetch failed (not recorded: ${url} ${method} ${JSON.stringify(params)})`);
    return new Response(JSON.stringify(hit.response), { status: hit.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: f, requests };
}
