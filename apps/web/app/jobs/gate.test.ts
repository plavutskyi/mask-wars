import { NETWORKS } from '@maskwars/network';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The jobs section stands only where its contracts are on chain. Where they are not (mainnet today), the menu leaves
// Jobs out once the chain says so, and /jobs and every job page are not found; /api/jobs stays open data. Each case
// reads a board with no network: JOBS_FIXTURE `undeployed` (no jobs account) or `deployed` (the jobs and crews
// contracts on chain with no job).
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

const NOT_FOUND = { digest: expect.stringMatching(/;404$/) };

describe('where the jobs contracts are not on chain', () => {
  it('/api/jobs-open says so, and is asked again within a minute', async () => {
    vi.stubEnv('JOBS_FIXTURE', 'undeployed');
    const { GET } = await import('../api/jobs-open/route');
    const res = await GET();
    expect(await res.json()).toEqual({ open: false, contract: NETWORKS.testnet.jobs, network: 'testnet' });
    expect(res.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=60, stale-while-revalidate=300');
  });

  it('/jobs is not found: no empty board stands for a contract that is not there', async () => {
    vi.stubEnv('JOBS_FIXTURE', 'undeployed');
    const page = await import('./page');
    await expect(page.default()).rejects.toMatchObject(NOT_FOUND);
    expect(await page.generateMetadata()).toMatchObject({ robots: { index: false } });
  });

  it('no job page is found, whatever its id', async () => {
    vi.stubEnv('JOBS_FIXTURE', 'undeployed');
    const job = await import('./[id]/page');
    for (const id of ['crew-drain-0001', 'job-0001']) await expect(job.default({ params: Promise.resolve({ id }) })).rejects.toMatchObject(NOT_FOUND);
  });

  it('/api/jobs still answers, as open data: the contract is not deployed and no job is made up', async () => {
    vi.stubEnv('JOBS_FIXTURE', 'undeployed');
    const { GET } = await import('../api/jobs/route');
    const res = await GET(new Request('https://maskwars.xyz/api/jobs'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deployed: false, contract: NETWORKS.testnet.jobs, jobs: [], open: 0 });
  });
});

describe('where the jobs and crews contracts are on chain', () => {
  it('/api/jobs-open says so, and the answer is kept for minutes', async () => {
    vi.stubEnv('JOBS_FIXTURE', 'deployed');
    const { GET } = await import('../api/jobs-open/route');
    const res = await GET();
    expect(await res.json()).toEqual({ open: true, contract: NETWORKS.testnet.jobs, network: 'testnet' });
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=300, stale-while-revalidate=3600');
  });

  it('/jobs shows the board, even with no job on it yet', async () => {
    vi.stubEnv('JOBS_FIXTURE', 'deployed');
    const page = await import('./page');
    expect(await page.default()).toBeTruthy();
  });

  it('says nothing when no RPC answers, so the menu keeps to what the network states', async () => {
    vi.stubEnv('JOBS_FIXTURE', '');
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed (no network in this test)');
    });
    try {
      const { GET } = await import('../api/jobs-open/route');
      const res = await GET();
      expect(await res.json()).toMatchObject({ open: null });
      expect(res.headers.get('cache-control')).toBe('no-store');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
