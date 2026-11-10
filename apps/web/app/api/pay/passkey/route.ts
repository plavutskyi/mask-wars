import { get, put } from '@vercel/blob';
import { keyBytes, sha256Hex } from '@maskwars/pay';
import { body, guard, isFixture, problem, reply } from '@/lib/pay';

// Which public key a passkey has, so a vault opens on a new device with one touch instead of two. A passkey shows its
// public key only once, when it is made; this keeps it, by credential id, and never changes an entry once written.
// Nothing here is secret and nothing here is trusted: the page uses a key only if the passkey's own signature holds
// for it, and recovers the key from two signatures otherwise.
export const dynamic = 'force-dynamic';

const memory = new Map<string, string>();
const useBlob = !isFixture && Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const pathOf = (id: string) => `pay/passkeys/${sha256Hex(id)}.json`;
const idOk = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{16,342}$/.test(id);

export async function GET(req: Request) {
  const no = guard(req, 'passkey', 30);
  if (no) return no;
  const id = new URL(req.url).searchParams.get('id');
  if (!idOk(id)) return problem('bad', 400);
  try {
    if (!useBlob) {
      const key = memory.get(id);
      return reply({ key: key ?? null });
    }
    const found = await get(pathOf(id), { access: 'private', useCache: false });
    if (!found || found.statusCode !== 200) return reply({ key: null });
    const saved = JSON.parse(await new Response(found.stream).text()) as { key?: unknown };
    return reply({ key: typeof saved.key === 'string' && keyBytes(saved.key) ? saved.key : null });
  } catch {
    // Not there, or the store is down: the page then recovers the key from the passkey itself.
    return reply({ key: null });
  }
}

export async function POST(req: Request) {
  const no = guard(req, 'passkey-save', 10);
  if (no) return no;
  const b = await body(req, 1_000);
  if (!b || !idOk(b.id) || typeof b.key !== 'string' || !keyBytes(b.key)) return problem('bad', 400);
  const { id, key } = b as { id: string; key: string };
  if (!useBlob) {
    if (!memory.has(id)) memory.set(id, key);
    return reply({ ok: true });
  }
  try {
    // Written once: a second write for the same passkey fails, whatever it says.
    await put(pathOf(id), JSON.stringify({ key, at: new Date().toISOString() }), {
      access: 'private',
      contentType: 'application/json',
      addRandomSuffix: false,
    });
  } catch {
    /* already there, or the store is down: the page can recover the key from the passkey itself */
  }
  return reply({ ok: true });
}
