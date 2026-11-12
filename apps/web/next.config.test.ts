import { afterEach, describe, expect, it, vi } from 'vitest';
import { siblingOf } from './lib/site';

// What the build is held to before anything is compiled: the network, and the other site's address.
const build = async (env: Record<string, string | undefined>) => {
  vi.resetModules();
  for (const name of ['MASKWARS_NETWORK', 'MASKWARS_SIBLING_URL', 'APP_ORIGIN', 'NEXT_PUBLIC_PAY_TEST', 'NEXT_PUBLIC_JOBS_TEST', 'VERCEL_ENV']) vi.stubEnv(name, env[name] ?? '');
  return (await import('./next.config')).default;
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('MASKWARS_NETWORK at build', () => {
  it('is testnet unless it says mainnet, and nothing else builds', async () => {
    expect((await build({})).env).toMatchObject({ MASKWARS_NETWORK: 'testnet' });
    expect((await build({ MASKWARS_NETWORK: 'mainnet' })).env).toMatchObject({ MASKWARS_NETWORK: 'mainnet' });
    await expect(build({ MASKWARS_NETWORK: 'main' })).rejects.toThrow('MASKWARS_NETWORK');
  });
});

describe('MASKWARS_SIBLING_URL at build', () => {
  it('unset: the site is built as a single site, exactly as before', async () => {
    expect((await build({ MASKWARS_NETWORK: 'mainnet' })).env).toEqual({ MASKWARS_NETWORK: 'mainnet', MASKWARS_SIBLING_URL: '' });
    expect((await build({})).env).toEqual({ MASKWARS_NETWORK: 'testnet', MASKWARS_SIBLING_URL: '' });
  });

  it('the two deployments: each names the other', async () => {
    const main = await build({ MASKWARS_NETWORK: 'mainnet', MASKWARS_SIBLING_URL: 'https://testnet.maskwars.xyz' });
    expect(main.env).toEqual({ MASKWARS_NETWORK: 'mainnet', MASKWARS_SIBLING_URL: 'https://testnet.maskwars.xyz' });
    const test = await build({ MASKWARS_NETWORK: 'testnet', MASKWARS_SIBLING_URL: 'https://maskwars.xyz', APP_ORIGIN: 'https://testnet.maskwars.xyz' });
    expect(test.env).toEqual({ MASKWARS_NETWORK: 'testnet', MASKWARS_SIBLING_URL: 'https://maskwars.xyz' });
  });

  it('holds the build to the rule the site reads it by: an https origin, plain http only for a local run', async () => {
    const values = [
      'https://testnet.maskwars.xyz',
      ' https://testnet.maskwars.xyz ',
      'http://localhost:3101',
      'http://127.0.0.1:3101',
      'https://testnet.maskwars.xyz/',
      'https://testnet.maskwars.xyz/forge',
      'https://testnet.maskwars.xyz?x=1',
      'http://testnet.maskwars.xyz',
      'testnet.maskwars.xyz',
      'https://user@testnet.maskwars.xyz',
      'javascript:alert(1)',
    ];
    for (const value of values) {
      let read: string | null | Error;
      try {
        read = siblingOf(value);
      } catch (e) {
        read = e as Error;
      }
      const built = build({ MASKWARS_NETWORK: 'mainnet', MASKWARS_SIBLING_URL: value });
      if (read instanceof Error) await expect(built, value).rejects.toThrow('MASKWARS_SIBLING_URL: an https origin');
      else expect((await built).env?.MASKWARS_SIBLING_URL, value).toBe(read);
    }
  });

  it('does not build a second site that names itself as its sibling', async () => {
    // The testnet site that forgot APP_ORIGIN would ship as maskwars.xyz: canonical links and the vault's API with it.
    await expect(build({ MASKWARS_NETWORK: 'testnet', MASKWARS_SIBLING_URL: 'https://maskwars.xyz' })).rejects.toThrow('set APP_ORIGIN');
    await expect(build({ MASKWARS_NETWORK: 'mainnet', MASKWARS_SIBLING_URL: 'https://testnet.maskwars.xyz', APP_ORIGIN: 'https://testnet.maskwars.xyz/' })).rejects.toThrow('set APP_ORIGIN');
  });
});

describe('NEXT_PUBLIC_PAY_TEST at build', () => {
  it('builds a test wallet anywhere but production, and stops a production build that carries it', async () => {
    await expect(build({ MASKWARS_NETWORK: 'mainnet', NEXT_PUBLIC_PAY_TEST: '1' })).resolves.toBeTruthy();
    await expect(build({ MASKWARS_NETWORK: 'mainnet', NEXT_PUBLIC_PAY_TEST: '1', VERCEL_ENV: 'preview' })).resolves.toBeTruthy();
    await expect(build({ MASKWARS_NETWORK: 'mainnet', VERCEL_ENV: 'production' })).resolves.toBeTruthy();
    for (const value of ['1', '0', 'true']) {
      await expect(build({ MASKWARS_NETWORK: 'mainnet', NEXT_PUBLIC_PAY_TEST: value, VERCEL_ENV: 'production' }), value).rejects.toThrow('NEXT_PUBLIC_PAY_TEST');
    }
  });
});

describe('NEXT_PUBLIC_JOBS_TEST at build', () => {
  it('builds the stand-in signer of "Post a job" anywhere but production, and stops a production build that carries it', async () => {
    await expect(build({ MASKWARS_NETWORK: 'mainnet', NEXT_PUBLIC_JOBS_TEST: '1' })).resolves.toBeTruthy();
    await expect(build({ MASKWARS_NETWORK: 'mainnet', NEXT_PUBLIC_JOBS_TEST: '1', VERCEL_ENV: 'preview' })).resolves.toBeTruthy();
    for (const value of ['1', '0', 'true']) {
      await expect(build({ MASKWARS_NETWORK: 'mainnet', NEXT_PUBLIC_JOBS_TEST: value, VERCEL_ENV: 'production' }), value).rejects.toThrow('NEXT_PUBLIC_JOBS_TEST');
    }
  });
});

describe('headers on every page', () => {
  it('no page may be framed by another site but the hire checkout, and none lets a browser guess a type', async () => {
    const rules = await (await build({ MASKWARS_NETWORK: 'mainnet' })).headers!();
    const of = (source: string) => Object.fromEntries(rules.find((r) => r.source === source)!.headers.map((h) => [h.key, h.value]));
    expect(of('/:path*')).toEqual({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    });
    const unframed = rules.find((r) => r.headers.some((h) => h.key === 'x-frame-options'))!;
    expect(Object.fromEntries(unframed.headers.map((h) => [h.key, h.value]))).toEqual({ 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" });
    // The rule's own pattern: everything but /hire/embed, which <mask-wars-hire> opens in a frame on a host's page.
    const pattern = new RegExp(`^${unframed.source}$`);
    for (const path of ['/', '/forge', '/swap', '/hire', '/hire/prove', '/api/forge']) expect(pattern.test(path), path).toBe(true);
    for (const path of ['/hire/embed', '/hire/embed?job=x']) expect(pattern.test(path.split('?')[0]!), path).toBe(false);
  });
});
