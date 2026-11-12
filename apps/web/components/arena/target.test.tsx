// @vitest-environment happy-dom
// The safe said plainly beside it: who funds it, who can open it, where the rest goes, its code and its record on
// chain. Every fact from the race as the chain gave it: the recorded testnet's race-0003, and the same race as the
// house's daily round on its vault.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Arena, Indexer, type NextRace, type Race, RPCS } from '@maskwars/arena';
import { accountUrl, HOUSE, SEASONS, txUrl } from '@maskwars/arena/config';
import { type Recording, replayFetch } from '@maskwars/arena/replay';
import { ChainReader } from '@maskwars/check';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEAMS } from '@/lib/show';
import { ArenaTarget, nextTargetOf, roundLinks, SAFE_SOURCE, safeTargetOf, TARGET_LINE, targetOf, targetRows } from './Target';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let race: Race;
/** race-0003 as a round of the house: the house opens it on its vault and funds it. */
let vault: Race;
beforeAll(async () => {
  const recording = JSON.parse(readFileSync(resolve(__dirname, '../../../../packages/arena/test/fixtures/testnet.json'), 'utf8')) as Recording;
  const fetch = replayFetch(recording);
  const view = await new Arena({ rpc: new ChainReader({ endpoints: RPCS, fetch }), indexer: new Indexer({ fetch }), now: () => recording.recordedAt }).view();
  race = view.races.find((r) => r.id === 'race-0003')!;
  const house = { account: HOUSE.account, slug: null, name: HOUSE.account, mask: false, model: null };
  vault = {
    ...race,
    team: HOUSE.account,
    target: HOUSE.vault,
    events: race.events.map((e) => (e.kind === 'fund' || e.kind === 'open' ? { ...e, who: house } : e)),
  };
});

const next = (season: string): NextRace => ({
  season,
  at: Date.UTC(2026, 10, 12, 18, 0),
  n: 4,
  target: 'live-safe',
  targetCode: 'x',
  inSafe: '280000000000000000000000',
  locked: '127600000000000000000000',
  prize: '407600000000000000000000',
  minLoot: '100000000000000000000000',
  masks: race.masks,
  sealMinutes: 45,
  hours: 4,
  funded: true,
});

describe('what the line stands for', () => {
  it('the house’s vault: funded by the house alone, open to the masks of the round, everything back to the house', () => {
    const t = targetOf(vault)!;
    const fund = vault.events.filter((e) => e.kind === 'fund');
    expect(fund.length).toBeGreaterThan(0);
    expect(t.safe).toBe(HOUSE.vault);
    expect(t.funder).toBe(HOUSE.account);
    expect(t.funded).toEqual({ amount: fund.reduce((s, e) => s + BigInt(e.amount!), 0n).toString(), tx: fund[0]!.tx });
    expect(t.masks.map((m) => m.account)).toEqual(race.masks.map((m) => m.account));
    expect(t.retires).toBe(true);

    const rows = targetRows(t);
    expect(rows.map((r) => r.label)).toEqual(['Funded by', 'Put in', 'Who can open it', ...race.masks.map((m) => m.name), 'After the round', 'The code', 'On chain']);
    expect(rows[0]).toEqual({ label: 'Funded by', value: HOUSE.account, href: accountUrl(HOUSE.account) });
    expect(rows[1]!.href).toBe(txUrl(fund[0]!.tx));
    expect(rows[2]!.value).toBe('Only the masks of this round');
    for (const m of race.masks) expect(rows.find((r) => r.label === m.name)).toEqual({ label: m.name, value: m.account, href: accountUrl(m.account) });
    expect(rows.find((r) => r.label === 'After the round')!.value).toBe(`On retire, everything goes back to ${HOUSE.account}`);
    expect(rows.find((r) => r.label === 'The code')!.href).toBe(SAFE_SOURCE);
    expect(SAFE_SOURCE).toBe('https://github.com/plavutskyi/mask-wars/blob/main/contracts/challenges/live-safe/src/lib.rs');
    // The safe's own transactions on the network's explorer.
    expect(rows.find((r) => r.label === 'On chain')).toEqual({ label: 'On chain', value: HOUSE.vault, href: accountUrl(HOUSE.vault) });
  });

  it('the round’s own steps, as far as the chain has them: opened, drained, paid', () => {
    const links = roundLinks(targetOf(race)!);
    expect(links.map((l) => l.text)).toEqual(['Opened', 'Drained', 'Paid']);
    expect(links.map((l) => l.href)).toEqual([txUrl(race.txs.open!), txUrl(race.txs.drain!), txUrl(race.txs.payout!)]);
    const held = targetOf({ ...race, txs: { open: race.txs.open, drain: null, payout: null }, refund: { amount: '1', at: 1, tx: 'BackTx' } })!;
    expect(roundLinks(held)).toEqual([
      { text: 'Opened', href: txUrl(race.txs.open!) },
      { text: 'Refunded', href: txUrl('BackTx') },
    ]);
  });

  it('only what the team itself put in is the arena’s money: a transfer anyone else sent the safe is not', () => {
    const fund = race.events.find((e) => e.kind === 'fund')!;
    const stranger = { account: 'someone.testnet', slug: null, name: 'someone.testnet', mask: false, model: null };
    const t = targetOf({ ...race, events: [...race.events, { ...fund, tx: 'StrangerTx', who: stranger, amount: '5000000000000000000000000' }] })!;
    expect(t.funded).toEqual(targetOf(race)!.funded);
  });

  it('a safe that is not the house’s vault says nothing of retire: its code is not the vault’s', () => {
    const t = targetOf(race)!;
    expect(t.retires).toBe(false);
    expect(targetRows(t).some((r) => r.label === 'After the round')).toBe(false);
  });

  it('no line for a safe the arena does not fund: another team’s safe, a training target', () => {
    expect(targetOf({ ...race, official: false })).toBeNull();
    expect(targetOf({ ...race, kind: 'sandbox' })).toBeNull();
  });

  it('the next round, before its safe holds anything: the house’s vault, or a season’s own safe', () => {
    const house = nextTargetOf(next(HOUSE.account));
    expect(house).toMatchObject({ safe: HOUSE.vault, funder: HOUSE.account, funded: null, retires: true });
    expect(targetRows(house).some((r) => r.label === 'Put in')).toBe(false);
    expect(roundLinks(house)).toEqual([]);
    const season = nextTargetOf(next(SEASONS[0]!));
    expect(season.safe).toBe(`s0004.${SEASONS[0]}`);
    expect(season.retires).toBe(false);
  });

  it('a safe’s own page: its newest round, when one of the arena’s teams opened it', () => {
    expect(safeTargetOf(race.target, race.targetCode, race, TEAMS)).toEqual(targetOf(race));
    expect(safeTargetOf(race.target, race.targetCode, { ...race, team: 'someone.testnet' }, TEAMS)).toBeNull();
    expect(safeTargetOf(race.target, race.targetCode, undefined, TEAMS)).toBeNull();
  });
});

describe('the line and its «i»', () => {
  let root: Root;
  let box: HTMLElement;
  beforeEach(() => {
    box = document.createElement('div');
    document.body.append(box);
    root = createRoot(box);
  });
  afterEach(() => {
    act(() => root.unmount());
    box.remove();
  });

  it('one line, then the whole story one tap away, and away again', () => {
    act(() => root.render(<ArenaTarget target={targetOf(vault)!} />));
    const button = box.querySelector<HTMLButtonElement>('button[aria-label="The arena target"]')!;
    const words = box.querySelector('p')!.cloneNode(true) as HTMLElement;
    words.querySelector('button')?.remove();
    expect(words.textContent).toBe(TARGET_LINE);
    expect(TARGET_LINE).toBe('Arena target. MASK WARS funds it, the masks break it.');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(box.querySelector('[role="dialog"]')).toBeNull();
    // On a wide screen the sheet opens from the whole line, not from the «i» at its end.
    expect(button.parentElement?.getAttribute('data-anchor')).toBe('line');

    act(() => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const sheet = document.querySelector('[role="dialog"][aria-label="The arena target"]')!;
    const links = [...sheet.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toContainEqual([HOUSE.account, accountUrl(HOUSE.account)]);
    expect(links).toContainEqual(['live-safe/src/lib.rs', SAFE_SOURCE]);
    expect(links).toContainEqual([HOUSE.vault, accountUrl(HOUSE.vault)]);
    for (const m of race.masks) expect(links).toContainEqual([m.account, accountUrl(m.account)]);
    expect(links).toContainEqual(['Opened', txUrl(race.txs.open!)]);
    expect(links).toContainEqual(['Drained', txUrl(race.txs.drain!)]);
    expect(links).toContainEqual(['Paid', txUrl(race.txs.payout!)]);
    expect(sheet.textContent).toContain(`On retire, everything goes back to ${HOUSE.account}`);
    // Every link leaves for the chain or the code in a tab of its own.
    for (const a of sheet.querySelectorAll('a')) expect(a.getAttribute('target')).toBe('_blank');

    act(() => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
