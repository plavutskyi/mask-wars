import { describe, expect, it, vi } from 'vitest';

// The route writes each request to Blob; here the write only counts.
const put = vi.fn(async () => ({}));
vi.mock('@vercel/blob', () => ({ put }));
const { POST } = await import('./route');

const send = (ip: string) =>
  POST(
    new Request('https://maskwars.xyz/api/break', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', 'x-real-ip': ip },
      body: JSON.stringify({ repo: 'github.com/you/vault', bounty: 500, contact: '@you' }),
    }),
  );

describe('POST /api/break (A11)', () => {
  it('takes a few requests from one caller a minute, then asks it to wait, and writes nothing more', async () => {
    for (let i = 0; i < 5; i++) expect((await send('1.2.3.4')).status).toBe(200);
    const sixth = await send('1.2.3.4');
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(put).toHaveBeenCalledTimes(5);
    // Another person is not held up by the first.
    expect((await send('5.6.7.8')).status).toBe(200);
    expect(put).toHaveBeenCalledTimes(6);
  });
});
