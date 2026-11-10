import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import { fromOwnSite, parseBreakRequest } from '@/lib/break';
import { callerOf, createLimiter } from '@/lib/limit';

// Each request becomes one private blob that only the team can read. Nothing here is shown back to the public.

// Every request is a write to Blob. A person sends one or two; a caller gets 5 a minute and an instance 60, so a script
// cannot run up the bill or bury the real ones (A11). The firewall rule on Vercel does the same across instances.
const perCaller = createLimiter({ perWindow: 5, windowMs: 60_000 });
const perInstance = createLimiter({ perWindow: 60, windowMs: 60_000 });

export async function POST(req: Request) {
  if (!fromOwnSite(req.headers)) return Response.json({ ok: false }, { status: 403 });
  const wait = perCaller.take(callerOf(req)) ?? perInstance.take('all');
  if (wait !== null) return Response.json({ ok: false }, { status: 429, headers: { 'retry-after': String(wait) } });
  const raw = await req.text();
  if (raw.length > 4_000) return Response.json({ ok: false }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }
  // Honeypot: people never see the `site` field, simple bots fill it.
  if (body && typeof body === 'object' && (body as Record<string, unknown>).site) return Response.json({ ok: true });
  const request = parseBreakRequest(body);
  if (!request) return Response.json({ ok: false }, { status: 422 });

  const at = new Date().toISOString();
  const entry = { ...request, at, country: req.headers.get('x-vercel-ip-country') ?? null };
  try {
    await put(`break/${at.slice(0, 10)}/${at.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`, JSON.stringify(entry), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
    });
  } catch {
    return Response.json({ ok: false }, { status: 503 });
  }
  return Response.json({ ok: true });
}
