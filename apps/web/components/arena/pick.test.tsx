// @vitest-environment happy-dom
// The pick block on the home page, in every state a round passes: the next round open for picks before it starts, the
// round open on chain until its first seal, a pick made and changed, picks closed by the first seal, the judge at
// work, the round called right or missed, the vault held, an old reading, nothing yet.
import type { Who } from '@maskwars/arena';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Entry, HELD, type PickView, type RoundBrief } from '@/lib/pick';
import { Pick, type PickMode, pickMode, shareText } from './Pick';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 12, 18, 4);
const who = (name: string): Who => ({ account: `${name.toLowerCase()}.maskwars.near`, slug: name.toLowerCase(), name, mask: true, model: null });
const ONYX = who('ONYX');
const ORACLE = who('ORACLE');
const NOVA = who('NOVA');
const MASKS = [ONYX, ORACLE, NOVA];
const ROUND_ID = 'r.bounty.maskwars.near.race-0002';

const empty: PickView = { window: null, mine: null, running: null, runningMine: null, last: null, lastMine: null, old: false };
/** The round is open on chain and no mask has sealed yet. */
const open: PickView = { ...empty, window: { key: ROUND_ID, closes: T0 + 45 * MIN, opens: null, masks: MASKS, prize: '1', race: 'race-0002' } };
/** Between rounds: the next round, due at 18:04 UTC, known by its scheduled time. */
const NEXT_KEY = `t.${T0}`;
const ahead: PickView = { ...empty, window: { key: NEXT_KEY, closes: T0 + 45 * MIN, opens: T0, masks: MASKS, prize: '1', race: null } };
const brief = (o: Partial<RoundBrief> = {}): RoundBrief => ({ id: 'race-0002', masks: MASKS, outcome: ORACLE.account, winner: ORACLE, breakMs: 984_000, takes: '1836000000000000000000000', judging: false, sealing: false, ...o });
const mine = (choice: string): Entry => ({ key: ROUND_ID, choice, at: T0 + MIN });

let root: Root;
let box: HTMLElement;
const fetchMock = vi.fn();
beforeEach(() => {
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
  vi.unstubAllGlobals();
});

const show = async (pick: PickView, now = T0 + 10 * MIN, onMode?: (m: PickMode) => void) => {
  await act(async () => root.render(<Pick pick={pick} now={now} rpId="maskwars.xyz" onMode={onMode} />));
};
const buttons = () => [...box.querySelectorAll('button')].map((b) => b.textContent?.trim());
const pressed = () => [...box.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent?.trim());

describe('before the round opens', () => {
  it('asks who breaks it, free, and says by when: the round’s start, the one time known ahead', async () => {
    const modes: PickMode[] = [];
    await show(ahead, T0 - 3 * 60 * MIN, (m) => modes.push(m));
    expect(box.textContent).toContain('Who breaks it?');
    expect(box.textContent).toContain('Free · by 18:04 UTC');
    // Not the end of the sealing window: by then the stage has shown who sealed first.
    expect(box.textContent).not.toContain('18:49');
    expect(box.textContent).not.toContain('first seal');
    expect(buttons()).toEqual(['ONYX', 'ORACLE', 'NOVA', 'Vault holds']);
    expect(modes.at(-1)).toBe('open');
  });

  it('with a pick in: it is lit, still theirs to change, and the line says when it locks', async () => {
    await show({ ...ahead, mine: { key: NEXT_KEY, choice: ORACLE.account, at: T0 - 4 * 60 * MIN } }, T0 - 3 * 60 * MIN);
    expect(pressed()).toEqual(['ORACLE']);
    expect(box.textContent).toContain('Your pick is in');
    expect(box.textContent).toContain('Locks after 18:04 UTC');
    expect(buttons()).toEqual(['ONYX', 'ORACLE', 'NOVA', 'Vault holds']);
  });

  it('past its minute and not on chain yet: no time is promised, picks close at the first seal', async () => {
    await show(ahead, T0 + MIN);
    expect(box.textContent).toContain('Free · closes at first seal');
    expect(box.textContent).not.toContain('18:04');
    expect(buttons()).toEqual(['ONYX', 'ORACLE', 'NOVA', 'Vault holds']);
  });
});

describe('the round open, no seal yet', () => {
  it('asks who breaks it: the three masks in the stage order and the vault, free, closing at the first seal', async () => {
    const modes: PickMode[] = [];
    await show(open, T0 + 10 * MIN, (m) => modes.push(m));
    expect(box.textContent).toContain('Who breaks it?');
    expect(box.textContent).toContain('Free · closes at first seal');
    // No clock time: nobody knows the minute of the first seal ahead, and the window's end is not the close.
    expect(box.textContent).not.toContain('UTC');
    expect(buttons()).toEqual(['ONYX', 'ORACLE', 'NOVA', 'Vault holds']);
    expect(modes.at(-1)).toBe('open');
  });

  it('one tap files the pick with the server and lights it; another tap changes it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ pick: mine(ORACLE.account) }), { status: 200 }));
    await show(open);
    await act(async () => (box.querySelectorAll('button')[1] as HTMLButtonElement).click());
    expect(fetchMock).toHaveBeenCalledWith('/api/pick', expect.objectContaining({ method: 'POST', body: JSON.stringify({ key: ROUND_ID, choice: ORACLE.account }) }));
    expect(pressed()).toEqual(['ORACLE']);
    expect(box.textContent).toContain('Your pick is in');
    expect(box.textContent).toContain('Locks at the first seal');
    expect(box.textContent).not.toContain('UTC');

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ pick: mine(HELD) }), { status: 200 }));
    await act(async () => (box.querySelectorAll('button')[3] as HTMLButtonElement).click());
    expect(pressed()).toEqual(['Vault holds']);
  });

  it('a pick made before the round opened is still lit once it is open', async () => {
    await show({ ...open, mine: { key: NEXT_KEY, choice: NOVA.account, at: T0 - 60 * MIN } }, T0 + 2 * MIN);
    expect(pressed()).toEqual(['NOVA']);
    expect(box.textContent).toContain('Locks at the first seal');
  });

  it('a pick the server refuses is not shown as made', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'closed' }), { status: 409 }));
    await show(open);
    await act(async () => (box.querySelectorAll('button')[0] as HTMLButtonElement).click());
    expect(pressed()).toEqual([]);
    expect(box.textContent).toContain('Picks just closed');
  });

  it('a pick that came after the first seal is refused, and the line says why', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'closed', why: 'seal', at: T0 + 7 * MIN }), { status: 409 }));
    await show(open);
    await act(async () => (box.querySelectorAll('button')[0] as HTMLButtonElement).click());
    expect(pressed()).toEqual([]);
    expect(box.textContent).toContain('First seal is in');
    expect(box.textContent).not.toContain('Your pick is in');
  });
});

describe('picks closed', () => {
  it('after the first seal, with a pick: it is locked in, no buttons, though the masks still seal', async () => {
    const modes: PickMode[] = [];
    await show({ ...empty, running: brief({ outcome: null, sealing: true }), runningMine: mine(NOVA.account) }, T0 + 8 * MIN, (m) => modes.push(m));
    expect(buttons()).toEqual([]);
    expect(box.textContent).toContain('Your pick');
    expect(box.textContent).toContain('NOVA');
    expect(box.textContent).toContain('Locked in');
    expect(modes.at(-1)).toBe('locked');
  });

  it('after the first seal, with no pick: no buttons, and picks open again next round', async () => {
    await show({ ...empty, running: brief({ outcome: null, sealing: true }) }, T0 + 8 * MIN);
    expect(buttons()).toEqual([]);
    expect(box.textContent).toContain('Picks closed');
    expect(box.textContent).toContain('Open again next round');
    // The masks have not played yet: nothing says they do.
    expect(box.textContent).not.toContain('playing');
    expect(box.textContent).not.toContain('Who breaks it?');
  });

  it('once the masks play, with no pick: picks closed, the masks are playing', async () => {
    await show({ ...empty, running: brief({ outcome: null }) }, T0 + 60 * MIN);
    expect(buttons()).toEqual([]);
    expect(box.textContent).toContain('Picks closed');
    expect(box.textContent).toContain('The masks are playing');
  });

  it('a round nobody sealed, past the end of its sealing window: the pick is locked in', async () => {
    await show({ ...open, mine: mine(NOVA.account) }, T0 + 46 * MIN);
    expect(buttons()).toEqual([]);
    expect(box.textContent).toContain('Your pick');
    expect(box.textContent).toContain('NOVA');
    expect(box.textContent).toContain('Locked in');
  });

  it('the judge on the claim: the pick waits for the chain', async () => {
    await show({ ...empty, running: brief({ outcome: null, judging: true }), runningMine: mine(ORACLE.account) });
    expect(box.textContent).toContain('Judge checking');
    expect(box.textContent).not.toContain('Called it');
  });

  it('over an old reading: picks are paused, nothing is said to happen now', async () => {
    await show({ ...empty, running: brief({ outcome: null }), old: true });
    expect(box.textContent).toContain('Picks paused');
    expect(box.textContent).toContain('The chain is quiet');
  });
});

describe('after the round', () => {
  it('called right: the verdict, the run from the server, the share', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Guest 7F3A', linked: false, me: { streak: 3, best: 3, right: 3, calls: 3, last: { race: 'race-0002', choice: ORACLE.account, right: true } }, share: 'token.mac' }), { status: 200 }));
    await show({ ...empty, last: brief(), lastMine: mine(ORACLE.account) });
    expect(fetchMock).toHaveBeenCalledWith('/api/pick?race=race-0002', expect.anything());
    expect(box.textContent).toContain('Called it');
    expect(box.textContent).toContain('3 in a row');
    const share = box.querySelector('button[aria-label="Share your call on X"]') as HTMLButtonElement;
    expect(share.disabled).toBe(false);
  });

  it('one right call is not a run yet', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ me: { streak: 1, best: 1, right: 1, calls: 1, last: { race: 'race-0002', choice: ORACLE.account, right: true } }, share: 't.m', name: null, linked: false }), { status: 200 }));
    await show({ ...empty, last: brief(), lastMine: mine(ORACLE.account) });
    expect(box.textContent).toContain('Called it');
    expect(box.textContent).not.toContain('in a row');
  });

  it('missed: what they picked, the share still there, no run', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ me: null, share: 't.m', name: null, linked: false }), { status: 200 }));
    await show({ ...empty, last: brief(), lastMine: mine(NOVA.account) });
    expect(box.textContent).toContain('Missed');
    expect(box.textContent).toContain('NOVA');
    expect(box.textContent).not.toContain('in a row');
  });

  it('no pick on it: the last round, and when picks open again', async () => {
    await show({ ...empty, last: brief({ outcome: HELD, winner: null }) });
    expect(box.textContent).toContain('Vault held');
    expect(box.textContent).toContain('Picks open next round');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with the next round open: the call first, the next pick one tap behind it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ me: null, share: null, name: null, linked: false }), { status: 200 }));
    await show({ ...open, window: { ...open.window!, key: 't.1794500000000', race: null }, last: brief(), lastMine: mine(ORACLE.account) });
    expect(box.textContent).toContain('Called it');
    const next = [...box.querySelectorAll('button')].find((b) => b.textContent?.includes('Pick the next breaker'))!;
    await act(async () => next.click());
    expect(buttons()).toEqual(['ONYX', 'ORACLE', 'NOVA', 'Vault holds']);
  });

  it('nothing at all yet: no block', async () => {
    await show(empty);
    expect(box.textContent).toBe('');
    expect(pickMode(empty, T0, null, false)).toBe('none');
  });
});

describe('the words shared', () => {
  it('every number is the round’s own', () => {
    expect(shareText(brief(), ORACLE.account, 3)).toBe('Called it. ORACLE broke Race 0002 of MASK WARS in 16:24 and took 1.836 NEAR. 3 in a row.');
    expect(shareText(brief(), NOVA.account, null)).toBe('I picked NOVA. ORACLE broke Race 0002 of MASK WARS in 16:24 and took 1.836 NEAR. Running it back.');
    expect(shareText(brief({ outcome: HELD, winner: null }), HELD, 1)).toBe('Called it. The vault held in Race 0002 of MASK WARS. Nobody got through.');
  });
});
