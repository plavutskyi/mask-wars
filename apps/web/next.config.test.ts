import { afterEach, describe, expect, it, vi } from 'vitest';
import { siblingOf } from './lib/site';

// What the build is held to before anything is compiled: the network, and the other site's address.
const build = async (env: Record<string, string | undefined>) => {
  vi.resetModules();
  for (const name of ['MASKWARS_NETWORK', 'MASKWARS_SIBLING_URL', 'APP_ORIGIN']) vi.stubEnv(name, env[name] ?? '');
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
