// Recorded answers of testnet RPC and the indexer: the tests and local screenshots replay them byte for byte, so the
// arena is checked on real chain data without a network. `scripts/record.ts` refreshes them from testnet.

export interface Exchange {
  readonly url: string;
  /** The request body; for JSON-RPC without its `id`. */
  readonly request: unknown;
  readonly status: number;
  readonly response: unknown;
}

export interface Recording {
  /** When the answers were recorded, ms: the moment a replay reads the arena at. */
  readonly recordedAt: number;
  readonly exchanges: readonly Exchange[];
}

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== "id" || !("jsonrpc" in (v as Record<string, unknown>)))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sorted(x)]),
    );
  }
  return v;
}

function parseBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") return null;
  try {
    return sorted(JSON.parse(init.body));
  } catch {
    return init.body;
  }
}

const keyOf = (url: string, request: unknown) => `${url} ${JSON.stringify(request)}`;

/** A fetch that answers from a recording; a request nobody recorded fails like a network error. */
export function replayFetch(recording: Recording): typeof fetch {
  const answers = new Map<string, Exchange>();
  for (const e of recording.exchanges) answers.set(keyOf(e.url, e.request), e);
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const hit = answers.get(keyOf(url, parseBody(init)));
    if (!hit) throw new TypeError(`fetch failed (not recorded: ${url} ${typeof init?.body === "string" ? init.body.slice(0, 200) : ""})`);
    return new Response(JSON.stringify(hit.response), { status: hit.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/** A fetch that passes through and keeps every answer. */
export function recordFetch(inner: typeof fetch = fetch): { fetch: typeof fetch; exchanges: Exchange[] } {
  const exchanges: Exchange[] = [];
  const seen = new Set<string>();
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const res = await inner(input, init);
    const text = await res.clone().text();
    let response: unknown = text;
    try {
      response = JSON.parse(text);
    } catch {
      // kept as text
    }
    const request = parseBody(init);
    const key = keyOf(url, request);
    if (!seen.has(key)) {
      seen.add(key);
      exchanges.push({ url, request, status: res.status, response });
    }
    return res;
  }) as typeof fetch;
  return { fetch: wrapped, exchanges };
}
