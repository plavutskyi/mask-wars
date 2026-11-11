// @vitest-environment happy-dom
// The home stage and the race page over a reading of now and over one the chain could not renew: LIVE and every
// running clock belong to the first alone. The race is the recorded testnet's race-0003, as it stood while the masks
// raced.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Arena, Indexer, type NextRace, type Race, RPCS } from '@maskwars/arena';
import { type Recording, replayFetch } from '@maskwars/arena/replay';
import { ChainReader } from '@maskwars/check';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RacePage } from './RacePage';
import { Stage } from './Stage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// One router for the page's life, as Next.js gives it.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
const refresh = router.refresh;
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/' }));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/link', () => ({ default: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) => <a href={href} className={className}>{children}</a> }));
vi.mock('@/components/Mark', () => ({ Mark: () => null }));
vi.mock('./Menu', () => ({ Menu: () => null, Net: () => null }));
vi.mock('../arena3d/sound', () => ({
  ArenaAudio: class {
    on = false;
    setHidden() {}
    dispose() {}
    disable() {}
    async enable() {}
  },
}));

let racing: Race;
let broken: Race;
beforeAll(async () => {
  const recording = JSON.parse(readFileSync(resolve(__dirname, '../../../../packages/arena/test/fixtures/testnet.json'), 'utf8')) as Recording;
  const fetch = replayFetch(recording);
  const view = await new Arena({ rpc: new ChainReader({ endpoints: RPCS, fetch }), indexer: new Indexer({ fetch }), now: () => recording.recordedAt }).view();
  broken = view.races.find((r) => r.id === 'race-0003')!;
  racing = { ...broken, phase: 'racing', live: true, state: 'open', winner: null, brokeAt: null, breakMs: null, loot: null, payout: null, takes: null, inSafe: broken.safeFunded, events: broken.events.filter((e) => e.kind === 'fund' || e.kind === 'open') };
});

let root: Root;
let box: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  refresh.mockClear();
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
  vi.useRealTimers();
});

const show = (ui: ReactNode) => act(() => root.render(ui));
const head = () => box.querySelector('header')!;
const badge = () => head().querySelector('[role="status"]')?.textContent ?? null;
const button = () => box.querySelector('footer a')?.textContent ?? null;
const spoken = () => box.querySelector('[aria-live="polite"]')?.textContent ?? null;

describe('the stage over a race in motion', () => {
  it('a reading of now: LIVE, the race clock running, the page asking the chain every few seconds', () => {
    const now = racing.startsAt! + 5 * 60_000;
    vi.setSystemTime(now);
    show(<Stage race={racing} serverNow={now} asOf={null} />);
    expect(badge()).toBe('Live');
    expect(head().textContent).toContain('05:00');
    expect(head().textContent).not.toContain('As of');
    expect(button()).toBe('Watch live');
    expect(spoken()).toContain('is live');
    act(() => void vi.advanceTimersByTime(5_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(head().textContent).toContain('05:05');
  });

  it('a reading the chain could not renew: no LIVE and no clock that runs, the time it was read at, the same race', () => {
    const now = racing.startsAt! + 5 * 60_000;
    const readAt = Date.UTC(2026, 10, 11, 13, 0, 12);
    vi.setSystemTime(now);
    show(<Stage race={racing} serverNow={now} asOf={readAt} />);
    expect(badge()).toBeNull();
    expect(head().textContent).toContain('As of');
    expect(head().textContent).toContain('13:00 UTC');
    expect(head().textContent).not.toMatch(/[0-9]{2}:[0-9]{2}(?! UTC)/);
    expect(button()).toBe('See the race');
    expect(spoken()).toBe('');
    // The race itself is still on the door: what was read stands, it is only not said to be happening now.
    expect(box.textContent).toContain('NEAR');
    // The chain is asked again soon, and not every few seconds.
    act(() => void vi.advanceTimersByTime(5_000));
    expect(refresh).not.toHaveBeenCalled();
    expect(head().textContent).toContain('13:00 UTC');
    act(() => void vi.advanceTimersByTime(15_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('the race page over a race in motion', () => {
  it('counts down to the close on a reading of now, and says when an old reading was taken', () => {
    const now = racing.startsAt! + 5 * 60_000;
    vi.setSystemTime(now);
    show(<RacePage race={racing} prev={null} next={null} />);
    expect(badge()).toBe('Live');
    expect(box.textContent).toContain('closes in');
    expect(box.textContent).not.toContain('as of');

    // The server hands an old reading over with nothing LIVE in it (lib/arena) and the time it was taken at.
    show(<RacePage race={{ ...racing, live: false }} prev={null} next={null} asOf={Date.UTC(2026, 10, 11, 13, 0, 12)} />);
    expect(badge()).toBeNull();
    expect(box.textContent).toContain('as of 13:00 UTC');
    expect(box.textContent).not.toContain('closes in');
  });
});

describe('the stage between races', () => {
  const next = (at: number): NextRace => ({
    season: 'season.tinygif8324.testnet',
    at,
    n: 4,
    target: 'live-safe',
    targetCode: 'x',
    inSafe: '1',
    locked: '1',
    prize: '2',
    minLoot: '1',
    masks: [],
    sealMinutes: 10,
    hours: 4,
    funded: true,
  });

  it('counts down to the next round on a reading of now, and only names the last one on an old reading', () => {
    const now = broken.deadline + 3_600_000;
    vi.setSystemTime(now);
    show(<Stage race={broken} next={next(now + 90 * 60_000)} serverNow={now} asOf={null} />);
    expect(head().textContent).toContain('Next round');
    expect(head().textContent).toContain('01:30:00');
    expect(badge()).toBeNull();

    show(<Stage race={broken} next={next(now + 90 * 60_000)} serverNow={now} asOf={now - 10 * 60_000} />);
    expect(head().textContent).not.toContain('Next round');
    expect(head().textContent).not.toContain('01:30:00');
    expect(head().textContent).toContain('Last race');
    // The result stays whole: who broke it and what it took.
    expect(box.textContent).toContain('NOVA');
    expect(button()).toBe('See the break');
  });
});
