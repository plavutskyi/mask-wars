// Open data: any site or agent may read the arena. Answers are cached at the edge for a few seconds and may be served
// a little stale while a fresh reading is taken.
const HEADERS = {
  'cache-control': 'public, max-age=0, s-maxage=5, stale-while-revalidate=30',
  'access-control-allow-origin': '*',
};

export function ok(body: unknown): Response {
  return Response.json(body, { headers: HEADERS });
}

export function missing(what: string): Response {
  return Response.json({ error: `${what} not found` }, { status: 404, headers: HEADERS });
}

export function down(error: unknown): Response {
  const why = error instanceof Error ? error.message : String(error);
  return Response.json({ error: 'the arena could not be read from the chain', why }, { status: 503, headers: { ...HEADERS, 'cache-control': 'no-store', 'retry-after': '5' } });
}

export function options(): Response {
  return new Response(null, { status: 204, headers: { ...HEADERS, 'access-control-allow-methods': 'GET, OPTIONS' } });
}
