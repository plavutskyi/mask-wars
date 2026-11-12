import { describe, expect, it } from 'vitest';
import type { Dossier } from '@maskwars/dossier';
import { checkWord, displayName, numberLine, span, standingLine } from './show';

describe('a contract as its page names it', () => {
  it('names the arena’s own safe short, and any other account whole', () => {
    expect(displayName({ account: 'safe-0001.tinygif8324.testnet', role: 'safe' })).toBe('safe-0001');
    expect(displayName({ account: 'safe-0001.someone.testnet', role: 'safe' })).toBe('safe-0001.someone.testnet');
    expect(displayName({ account: 'open-admin', role: 'target' })).toBe('open-admin');
    expect(displayName({ account: 'a'.repeat(64), role: 'account' })).toBe('aaaaaaaa…aaaaaaaa');
    // The house's vault, made again under the same name for each daily round.
    expect(displayName({ account: 'vault.house.tinygif8324.testnet', role: 'safe' })).toBe('vault');
    expect(displayName({ account: 'vault.someone.testnet', role: 'safe' })).toBe('vault.someone.testnet');
  });

  it('says how long it held the way a person reads it', () => {
    expect(span(86_399_999)).toBe('1 day');
    expect(span(3 * 86_400_000 + 5 * 3_600_000)).toBe('3 days');
    expect(span(5 * 3_600_000)).toBe('5 h');
    expect(span(40 * 60_000)).toBe('40 min');
  });
});

describe('the line under the number', () => {
  const who = (name: string) => ({ account: `${name.toLowerCase()}.tinygif8324.testnet`, slug: name.toLowerCase(), name, mask: true, model: null });
  const dossier = (broken: NonNullable<Dossier['headline']['broken']>) =>
    ({ races: [], headline: { standing: 'broken', amount: '150000000000000000000000', amountIs: 'taken', heldMs: null, masks: 2, races: 2, broken, live: false, closesAt: null } }) as unknown as Dossier;

  it('names one mask only when one mask took it all', () => {
    expect(numberLine(dossier({ race: 'race-0003', by: who('NOVA'), breakMs: 493_503, at: 1, count: 1, oneWinner: true, confirmed: true, pending: false }))).toBe('taken by NOVA');
    expect(numberLine(dossier({ race: 'race-0005', by: who('ONYX'), breakMs: 60_000, at: 2, count: 2, oneWinner: false, confirmed: true, pending: false }))).toBe('taken in 2 breaks · last by ONYX');
    expect(numberLine(dossier({ race: 'race-0005', by: who('NOVA'), breakMs: 60_000, at: 2, count: 2, oneWinner: true, confirmed: true, pending: false }))).toBe('taken in 2 breaks · all by NOVA');
    expect(numberLine(dossier({ race: 'race-0003', by: who('NOVA'), breakMs: 493_503, at: 1, count: 1, oneWinner: true, confirmed: false, pending: false }))).toBe('drained by NOVA · not confirmed by the judge · race 0003');
    expect(numberLine(dossier({ race: 'race-0003', by: who('NOVA'), breakMs: 493_503, at: 1, count: 1, oneWinner: true, confirmed: false, pending: true }))).toBe('drained by NOVA · with the judge · race 0003');
  });

  it('says a race that has just opened is under fire, not that it held a minute', () => {
    const d = { races: [], headline: { standing: 'under_fire', amount: '1', amountIs: 'on_the_line', heldMs: 0, masks: 3, races: 1, broken: null, live: true, closesAt: 1, judging: false } } as unknown as Dossier;
    expect(standingLine(d).text).toBe('Under fire');
    const past = (judging: boolean) => ({ ...d, headline: { ...d.headline, closesAt: null, judging } }) as unknown as Dossier;
    expect(numberLine(past(true))).toBe('on the line · with the judge');
    expect(numberLine(past(false))).toBe('on the line · deadline passed, bounty not back yet');
  });
});

describe('a contract that held', () => {
  it('names a race only when the number is that race alone', () => {
    const held = (races: number) =>
      ({ races: [{ id: 'race-0009' }, { id: 'race-0004' }], headline: { standing: 'held', amount: '1', amountIs: 'held', heldMs: 1, masks: 3, races, newest: 'race-0004', broken: null, live: false, closesAt: null } }) as unknown as Dossier;
    expect(numberLine(held(1))).toBe('on the line, back to the team · race 0004');
    expect(numberLine(held(2))).toBe('on the line in 2 races, back to the team');
  });
});

describe('a hold of unknown length', () => {
  it('says held, and no minute it cannot know', () => {
    const d = { races: [], headline: { standing: 'held', amount: '1', amountIs: 'held', heldMs: null, masks: 0, races: 1, newest: 'race-0001', broken: null, live: false, closesAt: null, judging: false } } as unknown as Dossier;
    expect(standingLine(d).text).toBe('Held');
  });
});

describe("MASK CHECK's word on the page", () => {
  const block = { height: 1, hash: 'h', time: '2026-11-12T00:00:00Z' };
  const check = (verdict: 'allow' | 'warn' | 'block', ...reasons: [string, 'block' | 'warn' | 'info'][]): NonNullable<Dossier['check']> => ({
    verdict,
    reasons: reasons.map(([code, level]) => ({ code, level })),
    block,
    checkedAt: block.time,
  });

  it("names the house's vault an arena target, never a bare warning", () => {
    expect(checkWord(check('warn', ['arena_target', 'warn'], ['young_account', 'info']))).toBe('target');
  });

  it('keeps the verdict for everything else: a drain blocks, any other warning warns', () => {
    expect(checkWord(check('block', ['arena_drained', 'block'], ['arena_target', 'warn']))).toBe('block');
    expect(checkWord(check('warn', ['young_account', 'warn']))).toBe('warn');
    expect(checkWord(check('allow', ['contract', 'info']))).toBe('allow');
  });
});
