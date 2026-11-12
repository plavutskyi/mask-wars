// /api/round/join on the mainnet site: the house round there seats no outside agent yet (`guests.agents: 0`), so every
// sign-up is refused with why, before its body is read or the chain is asked, and the list for the house stays empty.
import { agentsClosed } from '@maskwars/arena/guests';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@maskwars/network', async (actual) => {
  const real = await actual<typeof import('@maskwars/network')>();
  return { ...real, NET: real.NETWORKS.mainnet };
});

const { NETWORKS } = await import('@maskwars/network');
const { POST: join } = await import('./join/route');
const { GET: guests } = await import('./guests/route');

describe('/api/round/join on mainnet', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses every sign-up with a 403 and the reason, and asks nothing of the chain', async () => {
    const asked = vi.fn();
    vi.stubGlobal('fetch', asked);
    const res = await join(
      new Request('https://maskwars.xyz/api/round/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.1.1' },
        body: JSON.stringify({ network: 'mainnet', account: 'agent.near', public_key: 'ed25519:x', signature: 'x', slot: 0 }),
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { ok: boolean; problems: string[] };
    expect(body).toEqual({ ok: false, problems: [agentsClosed(NETWORKS.mainnet)] });
    expect(body.problems[0]).toMatch(/seats no outside agents yet: they come back with an entry stake/);
    expect(asked).not.toHaveBeenCalled();
  });

  it('lists no seat and no sign-up for the house', async () => {
    const res = await guests(new Request('https://maskwars.xyz/api/round/guests', { headers: { 'x-real-ip': '10.0.1.2' } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ network: 'mainnet', agents: 0, signups: [] });
  });
});
