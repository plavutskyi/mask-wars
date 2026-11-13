// @vitest-environment happy-dom
// The home stage over a round with guests beside the arena's three: masks people forged, later agents from outside.
// The three keep the stage; every other mask of the round stands in the row under it with its face, its name and the
// word the three get, up to three of them, the rest one count. A guest that breaks the vault takes the result whole:
// its face, its name, the money, and the visitor's pick line says it broke it. The race is the recorded testnet's
// race-0003, with guests added.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Arena, Indexer, type Race, type RaceEvent, RPCS, type Who } from '@maskwars/arena';
import { type Recording, replayFetch } from '@maskwars/arena/replay';
import { ChainReader } from '@maskwars/check';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { briefOf, type PickView } from '@/lib/pick';
import type { Faces } from '@/lib/show';
import { Stage } from './Stage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock('next/navigation', () => ({ useRouter: () => router, usePathname: () => '/' }));
// The art stays in the page as its source, so a test can tell whose face is drawn.
vi.mock('next/image', () => ({ default: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt ?? ''} /> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/link', () => ({
  default: ({ href, className, children, ...rest }: { href: string; className?: string; children?: ReactNode; 'aria-label'?: string }) => (
    <a href={href} className={className} aria-label={rest['aria-label']}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/Mark', () => ({ Mark: () => <svg data-mark="" /> }));
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

const MIN = 60_000;
const FACTORY = 'masks.tinygif8324.testnet';
const forged = (name: string): Who => ({ account: `${name}.${FACTORY}`, slug: name, name: name.toUpperCase(), mask: true, model: null });
const DMYTRO = forged('dmytro');
const KIRA = forged('kira');
const NIGHTJAR = forged('nightjarseven');
const VOLTA = forged('volta');
const ZED = forged('zed');
const FACES: Faces = {
  [DMYTRO.account]: { art: '/art/wraith.webp', tone: 'ice' },
  [KIRA.account]: { art: '/art/ronin.webp', tone: 'ember' },
  [NIGHTJAR.account]: { art: '/art/volt.webp', tone: 'violet' },
  [VOLTA.account]: { art: '/art/wraith.webp', tone: 'ice' },
  [ZED.account]: { art: '/art/ronin.webp', tone: 'ember' },
};

let broken: Race;
let house: Who[];
beforeAll(async () => {
  const recording = JSON.parse(readFileSync(resolve(__dirname, '../../../../packages/arena/test/fixtures/testnet.json'), 'utf8')) as Recording;
  const fetch = replayFetch(recording);
  const view = await new Arena({ rpc: new ChainReader({ endpoints: RPCS, fetch }), indexer: new Indexer({ fetch }), now: () => recording.recordedAt }).view();
  broken = view.races.find((r) => r.id === 'race-0003')!;
  house = [...broken.masks];
});

let root: Root;
let box: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ me: null, share: null, name: null, linked: false }), { status: 200 })));
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const show = (ui: ReactNode) => act(() => root.render(ui));
const step = (kind: RaceEvent['kind'], at: number, who: Who, o: Partial<RaceEvent> = {}): RaceEvent => ({ kind, at, tx: `${kind}-${at}`, who, amount: null, ok: true, ...o });

/** The round as it seals, ten minutes before its start: the arena's three and `guests`, `seals` in that order. */
function sealing(guests: Who[], seals: Who[]): Race {
  const startsAt = broken.openedAt! + 60 * MIN;
  return {
    ...broken,
    phase: 'sealing',
    live: true,
    state: 'open',
    startsAt,
    sealUntil: startsAt,
    winner: null,
    brokeAt: null,
    breakMs: null,
    loot: null,
    payout: null,
    takes: null,
    masks: [...house, ...guests],
    events: [...broken.events.filter((e) => e.kind === 'fund' || e.kind === 'open'), ...seals.map((who, seq) => step('seal', broken.openedAt! + (seq + 1) * MIN, who, { seq }))],
  };
}

/** The round `winner` broke and was paid for: its calls on the vault, the drain, its claim confirmed, the payout. */
function brokenBy(winner: Who, guests: Who[]): Race {
  const at = broken.brokeAt!;
  return {
    ...broken,
    masks: [...house, ...guests],
    winner,
    events: [
      ...broken.events.filter((e) => e.kind === 'fund' || e.kind === 'open'),
      step('move', at - 9000, winner, { method: 'set_owner' }),
      step('drain', at, winner, { method: 'sweep', amount: broken.loot }),
      step('reveal', at + 4000, winner),
      step('claim', at + 8000, winner, { verdict: 'paid' }),
      step('paid', broken.payout!.at!, winner, { amount: broken.payout!.amount }),
    ],
  };
}

const stageNames = () => [...box.querySelectorAll('ol[aria-label="Masks in the race"] > li')].map((li) => li.querySelector('a span:nth-child(2)')?.textContent);
const wings = () => box.querySelector('ul[aria-label="More masks in the round"]');
const guests = () => [...(wings()?.querySelectorAll(':scope > li') ?? [])];
/** A guest as the row reads it: its name, and the word under it when it has one. */
const guest = (li: Element | undefined) => [li?.querySelector('a span:nth-child(2) > span:first-child')?.textContent, li?.querySelector('a span:nth-child(2) > span:nth-child(2)')?.textContent].filter(Boolean).join(' ');
/** The words of a line as they read, piece by piece. */
function words(el: Element | undefined | null): string {
  const out: string[] = [];
  const walk = (n: Node) => (n.nodeType === 3 ? out.push(n.textContent ?? '') : n.childNodes.forEach(walk));
  if (el) walk(el);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}
/** The result on the stage: the money and whom it went to. */
const result = () => [...box.querySelectorAll('[role="status"]')].find((el) => el.textContent?.includes('NEAR')) ?? null;

describe('the round’s other masks on the home stage', () => {
  it('one guest while the round seals: the three keep the stage, the guest stands under it with its face, name and word', () => {
    const race = sealing([DMYTRO], [house[0]!, DMYTRO]);
    const now = race.startsAt! - 10 * MIN;
    vi.setSystemTime(now);
    show(<Stage race={race} serverNow={now} asOf={null} faces={FACES} />);
    expect(stageNames()).toEqual(['ONYX', 'ORACLE', 'NOVA']);
    expect(guests()).toHaveLength(1);
    const [dmytro] = guests();
    expect(guest(dmytro)).toBe('DMYTRO Sealed #2');
    expect(dmytro!.querySelector('a')?.getAttribute('href')).toBe('/mask/dmytro');
    expect(dmytro!.querySelector('a')?.getAttribute('aria-label')).toBe('DMYTRO: Sealed #2');
    // The face of the look it was forged with, in the light of its eyes; never the mark while the factory gave one.
    expect(dmytro!.querySelector('img')?.getAttribute('src')).toBe('/art/wraith.webp');
    expect(dmytro!.getAttribute('data-tone')).toBe('ice');
    expect(dmytro!.querySelector('[data-mark]')).toBeNull();
    // The deck keeps the row's height, so the arena composes above it.
    expect(box.querySelector('main')?.getAttribute('data-wings')).toBe('1');
    // No explanatory sentence: a face, a name, a word.
    expect(wings()?.textContent).toBe('DMYTROSealed #2');
  });

  it('a guest that has not sealed yet is in the race, as the three are; with no face from the factory it wears the mark', () => {
    const race = sealing([DMYTRO], [house[0]!]);
    const now = race.startsAt! - 10 * MIN;
    vi.setSystemTime(now);
    show(<Stage race={race} serverNow={now} asOf={null} faces={{}} />);
    const [dmytro] = guests();
    expect(guest(dmytro)).toBe('DMYTRO In the race');
    expect(dmytro!.querySelector('img')).toBeNull();
    expect(dmytro!.querySelector('[data-mark]')).not.toBeNull();
  });

  it('three guests: all three by face, in the chain’s order, each in its own look’s light, and no count', () => {
    const race = sealing([DMYTRO, KIRA, NIGHTJAR], [house[0]!, DMYTRO, NIGHTJAR]);
    const now = race.startsAt! - 10 * MIN;
    vi.setSystemTime(now);
    show(<Stage race={race} serverNow={now} asOf={null} faces={FACES} />);
    expect(stageNames()).toEqual(['ONYX', 'ORACLE', 'NOVA']);
    expect(guests().map(guest)).toEqual(['DMYTRO Sealed #2', 'KIRA In the race', 'NIGHTJARSEVEN Sealed #3']);
    expect(guests().map((li) => li.getAttribute('data-tone'))).toEqual(['ice', 'ember', 'violet']);
    expect(guests().map((li) => li.querySelector('img')?.getAttribute('src'))).toEqual(['/art/wraith.webp', '/art/ronin.webp', '/art/volt.webp']);
    expect(guests().map((li) => li.querySelector('a')?.getAttribute('href'))).toEqual(['/mask/dmytro', '/mask/kira', '/mask/nightjarseven']);
    expect(wings()?.textContent).not.toContain('+');
    expect(box.querySelector('main')?.getAttribute('data-wings')).toBe('3');
  });

  it('five guests: the first three by face, the other two one count that opens the round', () => {
    const race = sealing([DMYTRO, KIRA, NIGHTJAR, VOLTA, ZED], [house[0]!, DMYTRO]);
    const now = race.startsAt! - 10 * MIN;
    vi.setSystemTime(now);
    show(<Stage race={race} serverNow={now} asOf={null} faces={FACES} />);
    expect(stageNames()).toEqual(['ONYX', 'ORACLE', 'NOVA']);
    expect(guests()).toHaveLength(4);
    expect(guests().slice(0, 3).map(guest)).toEqual(['DMYTRO Sealed #2', 'KIRA In the race', 'NIGHTJARSEVEN In the race']);
    const count = guests()[3]!.querySelector('a')!;
    expect(count.textContent).toBe('+2');
    expect(count.getAttribute('href')).toBe(`/race/${race.id}`);
    expect(count.getAttribute('aria-label')).toBe('2 more masks in the round');
    expect(box.querySelector('main')?.getAttribute('data-wings')).toBe('4');
  });

  it('a guest that works harder than the three while the round runs still stands in the wings: the stage keeps its three', () => {
    const start = broken.startsAt!;
    const race: Race = {
      ...sealing([DMYTRO], [house[0]!, DMYTRO]),
      phase: 'racing',
      startsAt: start,
      sealUntil: start,
      events: [...sealing([DMYTRO], [house[0]!, DMYTRO]).events, step('move', start + 1000, DMYTRO), step('move', start + 2000, DMYTRO), step('move', start + 3000, house[0]!)],
    };
    vi.setSystemTime(start + 5 * MIN);
    show(<Stage race={race} serverNow={start + 5 * MIN} asOf={null} faces={FACES} />);
    expect(stageNames()).toEqual(['ONYX', 'ORACLE', 'NOVA']);
    expect(guest(guests()[0])).toBe('DMYTRO 2 tries');
  });

  it('a round with no guest has no row', () => {
    const race = sealing([], [house[0]!]);
    vi.setSystemTime(race.startsAt! - 10 * MIN);
    show(<Stage race={race} serverNow={race.startsAt! - 10 * MIN} asOf={null} />);
    expect(wings()).toBeNull();
    expect(box.querySelector('main')?.hasAttribute('data-wings')).toBe(false);
  });
});

describe('the round a guest won', () => {
  const now = () => broken.payout!.at! + 10 * MIN;

  it('the result is the guest’s: its face takes the stage, the money goes to its name, never to another mask', () => {
    const race = brokenBy(DMYTRO, [DMYTRO]);
    vi.setSystemTime(now());
    show(<Stage race={race} serverNow={now()} asOf={null} faces={FACES} />);
    const face = box.querySelector('section[aria-label$="the vault, broken"]')!;
    const taker = face.querySelector('img')!;
    expect(taker.getAttribute('src')).toBe('/art/wraith.webp');
    expect(taker.getAttribute('alt')).toBe('DMYTRO');
    expect(result()?.querySelector('a[href="/mask/dmytro"]')?.textContent).toBe('DMYTRO');
    expect(words(result())).toContain('1.086');
    // The light behind the vault is the winner's: Ice, as its look's eyes.
    expect(box.querySelector('main')?.getAttribute('data-tone')).toBe('ice');
    // The guest took a place on the stage (the 3D arena pays it there); the mask it took it from is in the row.
    // After the round no mask has a word under it, on the stage or in the row.
    expect(guests().map(guest)).toEqual(['ORACLE']);
  });

  it('with no face from the factory the guest still takes the stage, in the mark’s silhouette, under its own name', () => {
    const race = brokenBy(DMYTRO, [DMYTRO]);
    vi.setSystemTime(now());
    show(<Stage race={race} serverNow={now()} asOf={null} faces={null} />);
    const face = box.querySelector('section[aria-label$="the vault, broken"]')!;
    expect(face.querySelector('img')).toBeNull();
    expect(face.querySelector('[data-mark]')).not.toBeNull();
    expect(result()?.querySelector('a[href="/mask/dmytro"]')?.textContent).toBe('DMYTRO');
  });

  it('the visitor who picked one of the three: missed, and the line says who broke it', () => {
    const race = brokenBy(DMYTRO, [DMYTRO]);
    const nova = house.find((m) => m.slug === 'nova')!;
    const pick: PickView = { window: null, mine: null, running: null, runningMine: null, last: briefOf(race), lastMine: { key: `r.${race.contract}.${race.id}`, choice: nova.account, at: race.openedAt! + 1000 }, old: false };
    vi.setSystemTime(now());
    show(<Stage race={race} serverNow={now()} asOf={null} faces={FACES} pick={pick} />);
    const line = words(box.querySelector('[data-mode="called"] [role="status"]'));
    expect(line).toBe('Missed NOVA DMYTRO broke it');
    expect(line).not.toContain('Called it');
    // The pick tiles of the next round stay the arena's three and the vault.
    expect(briefOf(race).masks.map((m) => m.name)).toEqual(['ONYX', 'ORACLE', 'NOVA']);
  });

  it('a visitor with no pick on it reads the round and its winner', () => {
    const race = brokenBy(DMYTRO, [DMYTRO]);
    const pick: PickView = { window: null, mine: null, running: null, runningMine: null, last: briefOf(race), lastMine: null, old: false };
    vi.setSystemTime(now());
    show(<Stage race={race} serverNow={now()} asOf={null} faces={FACES} pick={pick} />);
    expect(words(box.querySelector('[data-mode="row"] [role="status"]'))).toBe('Race 0003 DMYTRO Picks open next round');
  });

  it('an agent from outside that broke it reads as its account, never as a name of ours', () => {
    const agent: Who = { account: 'scout.agents-lab.testnet', slug: null, name: 'scout.agents-lab.testnet', mask: true, model: null };
    const race = brokenBy(agent, [agent]);
    vi.setSystemTime(now());
    show(<Stage race={race} serverNow={now()} asOf={null} />);
    expect(result()?.querySelector('a[href^="/mask/"]')).toBeNull();
    expect(words(result())).toContain('scout.agents-lab.testnet');
  });
});
