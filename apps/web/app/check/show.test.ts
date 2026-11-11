// What /check shows of MASK CHECK's answers, over what mainnet and testnet RPC really answered.
import { readFileSync } from 'node:fs';
import type { CheckResult } from '@maskwars/check';
import { describe, expect, it } from 'vitest';
import { EXAMPLE, hostsOf, lineOf, partsOf, proofOf, readAt, refusalOf, restOf, txOf } from './show';

type Vector = { name: string; expect: CheckResult };
const vectors = (JSON.parse(readFileSync(new URL('../../../../packages/check/test/vectors.json', import.meta.url), 'utf8')) as { vectors: Vector[] }).vectors;
const answer = (name: string) => vectors.find((v) => v.name === name)!.expect;

const drained = answer(`testnet, as recorded: ${EXAMPLE}`);
const intents = answer('mainnet, as recorded: intents.near');
const lookalike = answer('mainnet, as recorded: treasury.intents.near');

describe('the line under the verdict', () => {
  it("is the strongest reason's own words, without the word the stamp already says", () => {
    expect(drained.verdict).toBe('block');
    expect(lineOf(drained)).toMatch(/^Drained on the MASK WARS arena: mask nova\.tinygif8324\.testnet took the safe/);
    expect(lineOf(lookalike)).toBe('No such account on mainnet: a payment cannot arrive.');
    expect(lineOf(intents)).toBe('No signals against this account were found.');
  });

  it('falls back to the summary without its prefix', () => {
    expect(lineOf({ verdict: 'warn', summary: 'WARN: Something.', reasons: [] })).toBe('Something.');
  });
});

describe('Details', () => {
  it('lists every reason but the one already shown, and links its transaction', () => {
    expect(restOf(drained).map((r) => r.code)).toEqual(['account_age', 'contract']);
    expect(proofOf(drained)).toMatch(/^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]+$/);
    expect(restOf(intents).map((r) => r.code)).toEqual(['account_age', 'contract', 'rpc_agree']);
    expect(proofOf(intents)).toBeNull();
    expect(proofOf(lookalike)).toBeNull();
  });

  it('follows a link only to a transaction on NEAR explorer', () => {
    const tx = (url: unknown) => txOf({ evidence: { tx: url as string } });
    expect(tx('https://nearblocks.io/txns/9fWpu8aYc4ZbbGAfRRaRjP8dsRj3wvJZXzW7dG8u4nyH')).not.toBeNull();
    for (const bad of ['https://nearblocks.io.evil.example/txns/9fWpu8aYc4ZbbGAfRRaRjP8dsRj3wvJZXzW7dG8u4nyH', 'javascript:alert(1)', 'https://nearblocks.io/txns/x?next=evil', null, 7]) {
      expect(tx(bad)).toBeNull();
    }
    expect(txOf({})).toBeNull();
  });

  it('says when and from where the chain was read', () => {
    expect(readAt(intents)).toEqual(['Block 223,685,290', '8 Nov 2026, 23:30 UTC']);
    expect(readAt({ block: null })).toBeNull();
    expect(hostsOf(intents)).toEqual(['rpc.mainnet.fastnear.com', 'near.drpc.org']);
  });

  it('reads a time inside a reason as a date that stays on one line', () => {
    const parts = partsOf('The account already existed 24 h ago (block 276821384, 2026-11-08T19:56:02Z).');
    expect(parts).toEqual([
      { text: 'The account already existed 24 h ago (block 276821384, ', keep: false },
      { text: '8 Nov 2026, 19:56 UTC', keep: true },
      { text: ').', keep: false },
    ]);
    expect(partsOf('A plain account: no contract code.')).toEqual([{ text: 'A plain account: no contract code.', keep: false }]);
  });
});

describe('when no verdict comes', () => {
  it('says why in the words of the page', () => {
    expect(refusalOf(400, null)).toBe('Not a NEAR account. Try alice.near or alice.testnet.');
    expect(refusalOf(429, '12')).toBe('Too many checks. Try again in 12 s.');
    expect(refusalOf(429, null)).toBe('Too many checks. Try again in 5 s.');
    expect(refusalOf(500, null)).toBe('No answer this time. Try again.');
    expect(refusalOf(0, null)).toBe('No answer this time. Try again.');
  });
});

describe('the account the field opens on', () => {
  it('is the arena’s first safe on the network the site is built for, named from that network’s settings', async () => {
    const { vi } = await import('vitest');
    for (const [network, account] of [
      ['testnet', 'safe-0001.tinygif8324.testnet'],
      ['mainnet', 'safe-0001.maskwars.near'],
    ] as const) {
      vi.stubEnv('MASKWARS_NETWORK', network);
      vi.resetModules();
      const show = await import('./show');
      expect(show.EXAMPLE).toBe(account);
    }
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
