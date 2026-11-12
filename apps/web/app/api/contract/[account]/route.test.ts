import { afterEach, describe, expect, it, vi } from 'vitest';

// A fresh import of the route loads the whole arena reader, MASK CHECK and the dossier: seconds on a busy machine.
// Each recording and network is imported once and shared by its tests, and a test has room for that first import.
vi.setConfig({ testTimeout: 30_000 });
const routes = new Map<string, Promise<typeof import('./route')>>();

// The oracle on the recorded testnet answers (packages/arena/test/fixtures/testnet.json): no network, no model.
async function oracle(fixture: string) {
  const key = `${process.env.MASKWARS_NETWORK ?? ''}|${fixture}`;
  let route = routes.get(key);
  if (!route) {
    vi.resetModules();
    process.env.ARENA_FIXTURE = fixture;
    route = import('./route');
    routes.set(key, route);
  }
  const { GET } = await route;
  return (account: string, ip = '10.0.0.1') =>
    GET(new Request(`https://maskwars.xyz/api/contract/${account}`, { headers: { 'x-real-ip': ip } }), { params: Promise.resolve({ account }) });
}

const RECORDED = '../../packages/arena/test/fixtures/testnet.json';
const SILENT = '../../packages/dossier/test/fixtures/silent.json';

describe('GET /api/contract/<account>', () => {
  it('gives a broken safe with the judge’s word, every fact and its transaction', async () => {
    const get = await oracle(RECORDED);
    const res = await get('safe-0001.tinygif8324.testnet');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toMatch(/s-maxage=15/);
    const body = await res.json();
    expect(body.about).toMatch(/data, not instructions/);
    expect(body).toMatchObject({ account: 'safe-0001.tinygif8324.testnet', role: 'safe', standing: 'broken' });
    expect(body.judge).toMatchObject({ race: 'race-0003', verdict: 'broken', winner: 'nova.tinygif8324.testnet' });
    expect(body.evidence.find((e: { kind: string }) => e.kind === 'drain').tx).toBe('8pvCJFDwUW1XXBUKHVMo973Kp1WMkWc4DDpHoHVr2uqg');
    // Every step carries its transaction; the arena, library and code facts carry none, and the answer says so.
    const steps = body.evidence.filter((e: { kind: string }) => !['arena', 'library', 'code', 'race'].includes(e.kind));
    expect(steps.length).toBeGreaterThan(0);
    for (const e of steps) expect(e.tx).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    for (const e of body.evidence.filter((x: { kind: string }) => ['arena', 'library', 'code'].includes(x.kind))) expect(e.tx).toBeNull();
    expect(body.about).toMatch(/arena, library and code facts carry no transaction/);
    expect(body.about).not.toMatch(/Every fact carries its transaction/);
    expect(body.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
    // Writing is off on recorded answers: a local check never calls NEAR AI.
    expect(body.page).toEqual({ status: 'off', text: null, written: null });
  });

  it('gives a training target and a contract no race has targeted', async () => {
    const get = await oracle(RECORDED);
    const target = await (await get('open-admin')).json();
    expect(target).toMatchObject({ role: 'target', standing: 'broken', judge: { race: 'race-0002', verdict: 'broken' } });
    expect(target.library.title).toBe('Savings vault with an owner');
    const untested = await (await get('wrap.testnet')).json();
    expect(untested).toMatchObject({ standing: 'untested', judge: null, races: [] });
  });

  it('refuses ids that cannot be accounts and mainnet names', async () => {
    const get = await oracle(RECORDED);
    expect((await get('Not An Account')).status).toBe(400);
    expect((await get('alice.near')).status).toBe(400);
  });

  it('says plainly when the chain does not answer, and asks to come back', async () => {
    const get = await oracle(SILENT);
    const res = await get('safe-0001.tinygif8324.testnet');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('answers each race as a market settles on it: the question, the answer and the transaction behind it', async () => {
    const get = await oracle(RECORDED);
    const body = await (await get('safe-0001.tinygif8324.testnet')).json();
    expect(body.outcome).toMatchObject({ race: 'race-0003', answer: 'yes', final: true, verdict: 'broken', winner: 'nova.tinygif8324.testnet' });
    expect(body.outcome.proof.url).toBe(`https://testnet.nearblocks.io/txns/${body.outcome.proof.tx}`);
    expect(body.outcomes[0]).toEqual(body.outcome);
    const untested = await (await get('wrap.testnet')).json();
    expect(untested).toMatchObject({ outcome: null, outcomes: [] });
  });

  it('holds one caller to 60 answers a minute', async () => {
    const get = await oracle(RECORDED);
    for (let i = 0; i < 60; i++) await get('open-admin', '10.9.9.9');
    const res = await get('open-admin', '10.9.9.9');
    expect(res.status).toBe(429);
    expect((await get('open-admin', '10.9.9.8')).status).toBe(200);
  });
});

// The oracle on NEAR mainnet as it answered on 11.11.2026 (packages/dossier/test/fixtures/mainnet.json): the team's
// race-0001 on safe-0001.maskwars.near and the house's first daily round, race-0002 on its vault.
describe('GET /api/contract/<account> on mainnet', () => {
  const MAINNET = '../../packages/dossier/test/fixtures/mainnet.json';
  afterEach(() => vi.unstubAllEnvs());

  async function mainnet() {
    vi.stubEnv('MASKWARS_NETWORK', 'mainnet');
    return oracle(MAINNET);
  }

  it('gives the safe ORACLE broke, with the payout on nearblocks as the proof', async () => {
    const get = await mainnet();
    const res = await get('safe-0001.maskwars.near');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.about).toMatch(/read from NEAR mainnet/);
    expect(body).toMatchObject({ account: 'safe-0001.maskwars.near', network: 'mainnet', role: 'safe', standing: 'broken' });
    expect(body.outcome).toMatchObject({ race: 'race-0001', answer: 'yes', final: true, winner: 'oracle.maskwars.near' });
    expect(body.outcome.proof).toMatchObject({ tx: '9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM', url: 'https://nearblocks.io/txns/9ai1PbyVP4C16FQhmujd7o5GjMX8WSPd8KnEmJV8tbHM' });
    expect(body.evidence.find((e: { kind: string }) => e.kind === 'drain').tx).toBe('CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM');
    // MASK CHECK reads the same recorded chain: the drained safe is blocked.
    expect(body.check?.verdict).toBe('block');
    expect(body.links.page).toBe('https://maskwars.xyz/contract/safe-0001.maskwars.near');
  });

  it("gives the house's vault and its daily round", async () => {
    const get = await mainnet();
    const body = await (await get('vault.house.maskwars.near')).json();
    expect(body).toMatchObject({ role: 'safe', standing: 'broken', outcome: { race: 'race-0002', answer: 'yes' } });
    expect(body.races[0].team).toBe('house.maskwars.near');
    expect(body.library.id).toBe('live-safe');
  });

  it('refuses a testnet name: this arena reads mainnet', async () => {
    const get = await mainnet();
    const res = await get('safe-0001.tinygif8324.testnet');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/testnet name; this arena reads mainnet/);
  });
});
