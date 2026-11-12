// @vitest-environment happy-dom
// The network beside the mark: on every page, in the same place, whether the page passes it or not.
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SITE } from '@/lib/site';
import { Header } from './Header';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ usePathname: () => '/check' }));
vi.mock('next/link', () => ({
  default: ({ href, className, children, 'aria-current': current }: { href: string; className?: string; children?: ReactNode; 'aria-current'?: 'page' | undefined }) => (
    <a href={href} className={className} aria-current={current}>
      {children}
    </a>
  ),
}));
vi.mock('@/components/Mark', () => ({ Mark: () => null }));

describe('the header', () => {
  it('names the network on a page that reads the chain and on one that does not, the same way', () => {
    const box = document.createElement('div');
    const root = createRoot(box);
    act(() => root.render(<Header overlay />));
    const plain = box.querySelector(`[title="NEAR ${SITE.network}"]`)?.textContent;
    act(() => root.render(<Header network={SITE.network} here="race" />));
    const race = box.querySelector(`[title="NEAR ${SITE.network}"]`)?.textContent;
    expect(plain).toBe(SITE.network);
    expect(race).toBe(plain);
    act(() => root.unmount());
  });
});

describe('the open menu', () => {
  it('has the pages the menu has no item for as a quieter second group under its own items', () => {
    const box = document.createElement('div');
    document.body.append(box);
    const root = createRoot(box);
    act(() => root.render(<Header network={SITE.network} here="race" />));
    expect(document.querySelector('nav[aria-label="More"]')).toBeNull();
    act(() => box.querySelector<HTMLButtonElement>('button[aria-label="Menu"]')?.click());
    const sheet = document.querySelector('[role="dialog"][aria-label="Menu"]');
    const navs = [...(sheet?.querySelectorAll('nav') ?? [])].map((n) => n.getAttribute('aria-label'));
    expect(navs).toEqual(['Site', 'More']);
    expect(sheet?.querySelector('nav[aria-label="Site"] a')?.textContent).toBe('The race');
    const more = [...(sheet?.querySelectorAll('nav[aria-label="More"] a') ?? [])];
    expect(more.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['Swap', '/swap'],
      ['MASK CHECK', '/check'],
      ['Hire the swarm', '/hire'],
      ['Private minds', '/verified'],
      ['Break my contract', '/break'],
    ]);
    // The page the visitor is on (/check here) is the lit one.
    expect(more.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent)).toEqual(['MASK CHECK']);
    act(() => root.unmount());
    box.remove();
  });
});

// This site on its own (no sibling named) is the testnet one, whose network states the jobs contracts are on chain.
describe('Jobs in the menu of a site on its own', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** The menu's places on the first frame, and once the chain has answered `/api/jobs-open` as `answer` says. */
  async function menu(answer: () => Promise<unknown>) {
    // A fresh menu module: it asks the chain once per page load, and every case here is a page load of its own.
    vi.resetModules();
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(String(url));
      if (String(url) === '/api/forge') return Response.json({ open: false });
      return Response.json(await answer());
    });
    const { Header: Fresh } = await import('./Header');
    const box = document.createElement('div');
    const root = createRoot(box);
    const places = () => [...box.querySelectorAll('nav[aria-label="Site"] a')].map((e) => e.textContent?.toLowerCase());
    act(() => root.render(<Fresh network={SITE.network} here="race" />));
    const first = places();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const after = places();
    act(() => root.unmount());
    return { first, after, asked };
  }

  it('trusts the network’s statement on the first frame, then the chain: Jobs leaves once the chain says the contracts are not there', async () => {
    const { first, after, asked } = await menu(async () => ({ open: false }));
    expect(first).toContain('jobs');
    expect(after).not.toContain('jobs');
    expect(asked).toContain('/api/jobs-open');
  });

  it('keeps Jobs while the chain says the jobs and crews contracts are on chain', async () => {
    const { first, after } = await menu(async () => ({ open: true }));
    expect(first).toContain('jobs');
    expect(after).toContain('jobs');
  });

  it('keeps to the statement when the chain said nothing', async () => {
    expect((await menu(async () => ({ open: null }))).after).toContain('jobs');
    expect(
      (
        await menu(async () => {
          throw new TypeError('fetch failed');
        })
      ).after,
    ).toContain('jobs');
  });
});
