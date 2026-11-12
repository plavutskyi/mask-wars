import { body, fixtureSend, guard, isFixture, problem, reply } from '@/lib/pay';

// PAY_FIXTURE=1 only, never in production: a NEAR wallet in a test browser sends its transactions here, and the factory
// and NEAR Intents in memory apply them as the chain would. Everywhere else this route does not exist (404).
export const dynamic = 'force-dynamic';

const ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export async function POST(req: Request) {
  if (!isFixture) return new Response(null, { status: 404 });
  const no = guard(req, 'fixture', 60);
  if (no) return no;
  const b = await body(req, 16_000);
  if (!b || typeof b.signer !== 'string' || !ACCOUNT.test(b.signer) || !Array.isArray(b.txs) || b.txs.length > 8) return problem('bad', 400);
  const outcomes = await fixtureSend(b.signer, b.txs as Parameters<typeof fixtureSend>[1]);
  return outcomes ? reply({ outcomes }) : new Response(null, { status: 404 });
}
