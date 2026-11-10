import { describe, expect, it } from 'vitest';
import { mcpOf } from './feed';

/** A chain that does not answer, and every request asked of it. */
function offline() {
  const asked: string[] = [];
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    asked.push(typeof init?.body === 'string' ? init.body : '');
    throw new TypeError('fetch failed');
  }) as typeof globalThis.fetch;
  return { asked, fetch };
}

describe("the site's /mcp", () => {
  it('reads the bounty contracts MASKWARS_BOUNTY_CONTRACTS names: the arena tools and get_race the same', async () => {
    const chain = offline();
    const { config, feed } = mcpOf({ MASKWARS_BOUNTY_CONTRACTS: 'arena-a.testnet, arena-b.testnet' }, chain.fetch);
    expect(config.contracts).toEqual(['arena-a.testnet', 'arena-b.testnet']);
    await expect(feed.read(2_000)).rejects.toThrow(/^the chain could not be read/);
    expect(chain.asked.join('\n')).toContain('"account_id":"arena-a.testnet"');
    expect(chain.asked.join('\n')).not.toContain('tinygif8324');
  });

  it("without it, the arena's own contracts, newest first", () => {
    expect(mcpOf({}).config.contracts).toEqual(['bounty.tinygif8324.testnet', 'tinygif8324.testnet']);
  });

  it('replays ARENA_FIXTURE instead of the network: the recorded testnet, race-0003 first', async () => {
    const { feed } = mcpOf({ ARENA_FIXTURE: '../../packages/arena/test/fixtures/testnet.json' });
    const { view, stale } = await feed.read(5_000);
    expect(stale).toBe(false);
    expect(view.races[0]?.id).toBe('race-0003');
  });
});
