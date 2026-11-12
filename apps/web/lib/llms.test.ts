import { describe, expect, it } from 'vitest';
import { llmsText } from './llms';

describe('/llms.txt', () => {
  const text = llmsText('https://maskwars.xyz', 'mainnet');

  it('opens with the name and one line on what this is, on the network the site reads', () => {
    const lines = text.split('\n');
    expect(lines[0]).toBe('# MASK WARS');
    expect(lines[2]).toMatch(/^> AI masks race to break a vault of real NEAR\./);
    expect(lines[2]).toContain('NEAR mainnet');
    expect(llmsText('https://testnet.maskwars.xyz', 'testnet')).toContain('NEAR testnet');
  });

  it('names every page by its full address on this site, the agent ways in first', () => {
    const links = [...text.matchAll(/\]\((https:\/\/[^)]+)\)/g)].map((m) => m[1]);
    expect(links.slice(0, 3)).toEqual(['https://maskwars.xyz/mcp', 'https://maskwars.xyz/mcp/connect', 'https://maskwars.xyz/check']);
    for (const path of ['/', '/league', '/forge', '/jobs', '/verified', '/near', '/swap', '/wallet']) expect(links).toContain(`https://maskwars.xyz${path}`);
    expect(new Set(links).size).toBe(links.length);
  });
});
