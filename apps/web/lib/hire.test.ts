import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwapStatus } from '@maskwars/pay';
import type { Ticket } from './hire';

/** NEAR's RPC answering view_access_key: a full-access key, a function-call key, no such key, or nothing useful. */
function rpc(answer: 'full' | 'call' | 'unknown' | 'down') {
  const asked: string[] = [];
  const f: typeof fetch = async (_input, init) => {
    asked.push(JSON.parse(String(init?.body)).params.request_type);
    if (answer === 'down') return new Response('', { status: 502 });
    if (answer === 'unknown') return Response.json({ jsonrpc: '2.0', id: 'maskwars', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCESS_KEY' } } });
    const permission = answer === 'full' ? 'FullAccess' : { FunctionCall: { allowance: null, receiver_id: 'app.near', method_names: [] } };
    return Response.json({ jsonrpc: '2.0', id: 'maskwars', result: { nonce: 1, permission, block_height: 1, block_hash: 'x' } });
  };
  return { f, asked };
}
const KEY = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('whether a NEAR wallet’s key can act for the vault it signed for', () => {
  it('takes a full-access key on the account, as the chain says', async () => {
    const { keyHolds } = await import('./hire');
    expect(await keyHolds('acme-full.near', KEY, rpc('full').f, async () => false)).toBe(true);
  });

  it('takes a key NEAR Intents already lets sign for the vault, and nothing less', async () => {
    const { keyHolds } = await import('./hire');
    expect(await keyHolds('acme-call.near', KEY, rpc('call').f, async () => true)).toBe(true);
    expect(await keyHolds('acme-call2.near', KEY, rpc('call').f, async () => false)).toBe(false);
    expect(await keyHolds('acme-none.near', KEY, rpc('unknown').f, async () => false)).toBe(false);
  });

  it('says it does not know when the chain cannot be reached, rather than guessing', async () => {
    const { keyHolds } = await import('./hire');
    const { f, asked } = rpc('down');
    expect(
      await keyHolds('acme-quiet.near', KEY, f, async () => {
        throw new Error('down');
      }),
    ).toBeNull();
    expect(asked).toEqual(['view_access_key', 'view_access_key']);
  });
});

const ticket = (n: number, page: string | null, closes: string): Ticket => ({
  job: {
    id: `job-0123456789${String(n).padStart(2, '0')}`.slice(0, 16),
    hash: '0'.repeat(64),
    text: 'Attack my vault before launch',
    target: 'vault.acme.near',
    team: 'acme.near',
  },
  network: 'mainnet',
  usd: 250,
  page,
  proof: 'passkey',
  from: { chain: 'sol', symbol: 'USDC', assetId: 'nep141:sol-usdc' },
  quote: {
    correlationId: `c${n}`,
    depositAddress: `Dep${n}osit`,
    depositMemo: null,
    amountIn: '1',
    amountOut: '1',
    minAmountOut: '1',
    deadline: closes,
    closes,
  },
  at: new Date().toISOString(),
});

describe('where a job’s ticket is kept', () => {
  beforeEach(() => {
    vi.stubEnv('PAY_FIXTURE', '1');
  });

  it('never only in one instance’s memory in production: no store there means no address', async () => {
    vi.stubEnv('PAY_FIXTURE', '');
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('BLOB_READ_WRITE_TOKEN', '');
    const { keepTicket } = await import('./hire');
    expect(await keepTicket(ticket(1, null, '2026-11-09T13:00:00Z'))).toBe('down');
  });

  // The finding: tickets were written without a limit and never went away.
  it('once per deposit address, and no more than a page’s share of an hour, counted in the store', async () => {
    const { BUDGET, keepTicket, openTicket } = await import('./hire');
    const closes = new Date(Date.now() + 3600_000).toISOString();
    expect(await keepTicket(ticket(1, 'https://a.example', closes))).toBe('kept');
    expect(await keepTicket(ticket(1, 'https://b.example', closes))).toBe('down');
    expect(await openTicket('Dep1osit', null)).toMatchObject({ page: 'https://a.example' });
    for (let i = 2; i <= BUDGET.address.page; i++) expect(await keepTicket(ticket(i, 'https://a.example', closes))).toBe('kept');
    expect(await keepTicket(ticket(999, 'https://a.example', closes))).toBe('full');
    expect(await keepTicket(ticket(999, 'https://b.example', closes))).toBe('kept');
  });

  it('is swept once its address closes: kept as funded if the money landed, gone if nothing was paid', async () => {
    const { keepTicket, memoryStore, sweep, keepRelay } = await import('./hire');
    const now = Date.now();
    const past = new Date(now - 3600_000).toISOString();
    const statuses: Record<string, SwapStatus> = { Dep1osit: 'PENDING_DEPOSIT', Dep2osit: 'SUCCESS', Dep3osit: 'PROCESSING', Dep4osit: 'REFUNDED' };
    for (const n of [1, 2, 3, 4]) expect(await keepTicket(ticket(n, null, past))).toBe('kept');
    expect(await keepTicket(ticket(5, null, new Date(now + 3600_000).toISOString()))).toBe('kept');
    await keepRelay('d'.repeat(64), { proof: {} as never, vault: 'acme.near' });
    const asked: string[] = [];
    const out = await sweep({ force: true, now, status: async (a) => (asked.push(a), statuses[a]!) });
    expect(out).toEqual({ funded: 1, removed: 2 });
    // The open address was not asked about; the one still swapping stays.
    expect(asked.sort()).toEqual(['Dep1osit', 'Dep2osit', 'Dep3osit', 'Dep4osit']);
    const left = [...memoryStore.keys()];
    expect(left.filter((p) => p.startsWith('hire/open/'))).toHaveLength(2);
    expect(left.filter((p) => p.startsWith('hire/funded/'))).toHaveLength(1);
    // A proof nobody picked up goes after an hour.
    expect(left.some((p) => p.startsWith('hire/relay/'))).toBe(true);
    await sweep({ force: true, now: now + 2 * 3600_000, status: async () => 'PROCESSING' });
    expect([...memoryStore.keys()].some((p) => p.startsWith('hire/relay/'))).toBe(false);
  });
});
