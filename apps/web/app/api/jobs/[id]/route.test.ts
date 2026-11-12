// One job by its id: 404 when the board does not hold it, or `null` for a page that waits for a job it just signed.
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /api/jobs/<id>', () => {
  it('answers 404 for a job not on the board, and null with ?missing=null, never cached', async () => {
    vi.stubEnv('JOBS_FIXTURE', 'deployed');
    const { GET } = await import('./route');
    const params = Promise.resolve({ id: 'race-0004-abcdef' });
    const plain = await GET(new Request('https://maskwars.xyz/api/jobs/race-0004-abcdef'), { params });
    expect(plain.status).toBe(404);
    const soft = await GET(new Request('https://maskwars.xyz/api/jobs/race-0004-abcdef?missing=null&at=1'), { params: Promise.resolve({ id: 'race-0004-abcdef' }) });
    expect(soft.status).toBe(200);
    expect(await soft.json()).toBeNull();
    expect(soft.headers.get('cache-control')).toBe('no-store');
  });
});
