/**
 * Everything a pass of the masks at work asked the chain, and what the chain answered, in order: the arena's reader
 * and every signed call go through one `fetch`, so one tape holds both. A recording on a local sandbox becomes the
 * test's chain: the replay answers each request with the answer recorded for it, the same request asked again with the
 * next answer recorded for it (a view asked before and after a call answers differently), and a request nobody
 * recorded fails like a network error. Signing is deterministic (ed25519, the nonce and block hash come from the tape),
 * so a replayed pass sends byte for byte the transactions the recorded one sent.
 */
export interface TapeEntry {
  readonly url: string;
  /** The request body as sent, keys sorted, the JSON-RPC `id` left out. */
  readonly request: unknown;
  readonly status: number;
  readonly response: unknown;
}

export interface Tape {
  /** What the recording was made on, for people: `sandbox`, the contracts, the masks. */
  readonly about: Readonly<Record<string, unknown>>;
  readonly entries: readonly TapeEntry[];
}

function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(o)
        .filter(([k]) => k !== "id" || !("jsonrpc" in o))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sorted(x)]),
    );
  }
  return v;
}

function bodyOf(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") return null;
  try {
    return sorted(JSON.parse(init.body));
  } catch {
    return init.body;
  }
}

const keyOf = (url: string, request: unknown) => `${url} ${JSON.stringify(request)}`;

/**
 * A view's answer carries its JSON as an array of byte values (`"result":[123,34,…]`), four times the text. On the tape
 * it is kept as base64 (`result_b64`) and given back as the array, so a replay answers exactly what the chain did.
 */
export function packed(response: unknown): unknown {
  const r = (response as { result?: { result?: unknown } } | null)?.result;
  if (!r || !Array.isArray(r.result) || !r.result.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) return response;
  const { result: bytes, ...rest } = r as { result: number[] };
  return { ...(response as object), result: { ...rest, result_b64: Buffer.from(bytes).toString("base64") } };
}

export function unpacked(response: unknown): unknown {
  const r = (response as { result?: { result_b64?: unknown } } | null)?.result;
  if (!r || typeof r.result_b64 !== "string") return response;
  const { result_b64, ...rest } = r as { result_b64: string };
  return { ...(response as object), result: { ...rest, result: [...Buffer.from(result_b64, "base64")] } };
}
const urlOf = (input: string | URL | Request) => String(input instanceof Request ? input.url : input);

/** A fetch that passes through and writes every exchange down, in the order the answers came. */
export function recordingFetch(inner: typeof fetch = fetch): { fetch: typeof fetch; entries: TapeEntry[] } {
  const entries: TapeEntry[] = [];
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await inner(input, init);
    const text = await res.clone().text();
    let response: unknown = text;
    try {
      response = JSON.parse(text);
    } catch {
      // kept as text
    }
    entries.push({ url: urlOf(input), request: bodyOf(init), status: res.status, response: packed(response) });
    return res;
  }) as typeof fetch;
  return { fetch: wrapped, entries };
}

/**
 * A fetch that answers from a tape: the n-th time a request is asked, with the n-th answer recorded for it. Asked more
 * often than recorded, it fails. `unasked()` lists the recorded requests nobody asked for.
 */
export function replayingFetch(tape: Tape): { fetch: typeof fetch; unasked: () => string[] } {
  const queues = new Map<string, TapeEntry[]>();
  for (const e of tape.entries) {
    const k = keyOf(e.url, e.request);
    queues.set(k, [...(queues.get(k) ?? []), e]);
  }
  const asked = new Map<string, number>();
  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    const k = keyOf(url, bodyOf(init));
    const i = asked.get(k) ?? 0;
    const hit = queues.get(k)?.[i];
    if (!hit) throw new TypeError(`fetch failed (not recorded: ${url} ${typeof init?.body === "string" ? init.body.slice(0, 300) : ""})`);
    asked.set(k, i + 1);
    const body = typeof hit.response === "string" ? hit.response : JSON.stringify(unpacked(hit.response));
    return new Response(body, { status: hit.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const unasked = () => [...queues.entries()].flatMap(([k, q]) => Array.from({ length: q.length - (asked.get(k) ?? 0) }, () => k.slice(0, 200)));
  return { fetch: wrapped, unasked };
}
