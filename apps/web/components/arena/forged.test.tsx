// @vitest-environment happy-dom
// "Forged masks" on the league page: the masks people forged, between the arena's own table and the best callers. A
// factory that lists nothing, or fails, leaves the page as it was: no section, and the same count under the title.
import type { MaskStats } from '@maskwars/arena';
import type { MaskView } from '@maskwars/forge';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Forged, forgedReader, forgedRows } from '@/lib/forged';
import { LeaguePage } from './LeaguePage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ usePathname: () => '/league' }));
vi.mock('next/image', () => ({ default: ({ src }: { src: string }) => <img src={src} alt="" /> }));
vi.mock('next/link', () => ({ default: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) => <a href={href} className={className}>{children}</a> }));
vi.mock('@/components/Mark', () => ({ Mark: () => null }));
vi.mock('./Menu', () => ({ Menu: () => null, Net: () => null }));

const FACTORY = 'masks.maskwars.near';

const own = (name: string, breaks: number): MaskStats => ({
  who: { account: `${name}.maskwars.near`, slug: name, name: name.toUpperCase(), mask: true, model: null },
  races: 3,
  breaks,
  earned: breaks ? '500000000000000000000000' : '0',
  fastestMs: null,
  fastestRace: null,
  history: [],
});
const LEAGUE = [own('oracle', 2), own('nova', 1), own('onyx', 0)];

const mask = (name: string, o: Partial<MaskView> = {}): MaskView =>
  ({ name, account: `${name}.${FACTORY}`, owner: 'someone.near', look: 'porcelain', brain: '680000000000000000000000', races: 0, born_ns: '1', state: 'ready', race: null, ...o }) as MaskView;

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

const show = (forged: Forged | null) =>
  act(() => root.render(<LeaguePage league={LEAGUE} races={3} network="mainnet" forged={forged} callers={{ list: [], rounds: 0, me: null }} />));
const section = () => box.querySelector('section[aria-labelledby="forged"]');
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('the league page with the masks people forged', () => {
  it('lists the mask the factory holds: its face, its name to its page, races, breaks, its tank, and where it stands', () => {
    show(forgedRows([mask('dmytro')], LEAGUE));
    const forged = section();
    expect(text(forged?.querySelector('h2'))).toBe('Forged masks');
    expect(forged?.textContent).toContain('Made by people on the forge');
    expect(text(forged?.querySelector('a[href="/forge"]'))).toBe('Forge yours');

    const rows = [...(forged?.querySelectorAll('ol > li') ?? [])];
    expect(rows).toHaveLength(1);
    const link = rows[0]!.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/mask/dmytro');
    expect(link?.querySelector('img')?.getAttribute('src')).toBe('/art/wraith.webp');
    expect(link?.textContent).toContain('DMYTRO');
    expect(link?.textContent).toContain('Ready to race');
    // The three numbers of the row, right of the name: races, breaks, the tank in NEAR.
    expect([...rows[0]!.children].slice(1).map(text)).toEqual(['0', '0', '0.68NEAR']);
    // Their labels, and nothing technical on the screen.
    expect(text(forged?.querySelector('[aria-hidden]'))).toBe('MaskRacesBreaksTank');
    expect(forged?.textContent).not.toMatch(/factory|masks\.maskwars|\.near\b/i);
    expect(forged?.querySelector('ol + p')).toBeNull();
  });

  it('stands between the arena’s table and the best callers, and leaves the count under the title to the arena’s masks', () => {
    show(forgedRows([mask('dmytro')], LEAGUE));
    const order = [...box.querySelectorAll('section')].map((s) => s.getAttribute('aria-label') ?? s.getAttribute('aria-labelledby') ?? 'head');
    expect(order).toEqual(['head', 'League table', 'forged', 'callers']);
    expect(text(box.querySelector('h1 + p'))).toBe('3 masks · 3 races');
    expect(box.querySelectorAll('section[aria-label="League table"] ol > li')).toHaveLength(3);
  });

  it('gives each look its own face and the row its own word', () => {
    show(
      forgedRows(
        [
          mask('ash', { look: 'crimson', races: 7, born_ns: '1' }),
          mask('volt', { look: 'graphite', state: 'racing', race: { race: 'race-0007', held: '1', armed_ns: '1', keys: [] }, races: 2, born_ns: '2' }),
          mask('dry', { look: 'porcelain', brain: '0', born_ns: '3' }),
        ],
        LEAGUE,
      ),
    );
    const rows = [...(section()?.querySelectorAll('ol > li') ?? [])];
    expect(rows.map((li) => li.querySelector('a')?.getAttribute('href'))).toEqual(['/mask/ash', '/mask/volt', '/mask/dry']);
    expect(rows.map((li) => li.querySelector('img')?.getAttribute('src'))).toEqual(['/art/ronin.webp', '/art/volt.webp', '/art/wraith.webp']);
    expect(rows.map((li) => li.getAttribute('data-tone'))).toEqual(['ember', 'violet', 'ice']);
    expect(rows.map((li) => text(li.querySelector('[data-state]')))).toEqual(['Ready to race', 'Racing now', 'Out of fuel']);
    expect(rows.map((li) => text(li.children[1]))).toEqual(['7', '2', '0']);
  });

  it('shows twelve masks and says how many more there are', () => {
    show(forgedRows(Array.from({ length: 15 }, (_, i) => mask(`m${i}`, { born_ns: String(i + 1) })), LEAGUE));
    expect(section()?.querySelectorAll('ol > li')).toHaveLength(12);
    expect(text(section()?.querySelector('ol + p'))).toBe('and 3 more');
  });

  it('has no such section when the factory lists no mask', () => {
    show(forgedRows([], LEAGUE));
    expect(section()).toBeNull();
    expect(box.textContent).not.toContain('Forged masks');
    expect(text(box.querySelector('h1 + p'))).toBe('3 masks · 3 races');
    expect(box.querySelector('section[aria-labelledby="callers"]')).not.toBeNull();
  });

  it('has no such section, and no error, when the factory does not answer', async () => {
    const reader = forgedReader({
      list: async (): Promise<MaskView[]> => {
        throw new Error('no RPC answered');
      },
    });
    show(forgedRows(await reader.read(), LEAGUE));
    expect(section()).toBeNull();
    expect(box.querySelectorAll('section[aria-label="League table"] ol > li')).toHaveLength(3);
    expect(box.querySelector('section[aria-labelledby="callers"]')).not.toBeNull();
  });
});
