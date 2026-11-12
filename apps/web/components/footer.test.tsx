// @vitest-environment happy-dom
// The foot of every page: the pages a visitor can open, the code, the network. And the pages that have none.
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODE_URL, SITE } from '@/lib/site';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const at = vi.hoisted(() => ({ path: '/check' }));
vi.mock('next/navigation', () => ({ usePathname: () => at.path }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  at.path = '/check';
});

/** The footer on `path`, on the first frame and once the chain has answered the menu's two questions. */
async function footer(path: string, chain: { forge: boolean; jobs: boolean } = { forge: false, jobs: true }) {
  at.path = path;
  // A fresh menu module: it asks the chain once per page load, and every case here is a page load of its own.
  vi.resetModules();
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(String(url));
    return Response.json({ open: String(url) === '/api/forge' ? chain.forge : chain.jobs });
  });
  const { Footer } = await import('./Footer');
  const box = document.createElement('div');
  const root = createRoot(box);
  const read = () => ({
    foot: box.querySelector('footer'),
    links: [...box.querySelectorAll('footer nav a')].map((a) => [a.textContent?.trim(), a.getAttribute('href')]),
    text: box.querySelector('footer')?.textContent ?? '',
  });
  act(() => root.render(<Footer />));
  const first = read();
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
  const after = read();
  const code = box.querySelector(`footer a[href="${CODE_URL}"]`);
  const current = [...box.querySelectorAll('footer [aria-current="page"]')].map((a) => a.textContent?.trim());
  const out = { first, after, asked, code: code ? { target: code.getAttribute('target'), rel: code.getAttribute('rel') } : null, current };
  act(() => root.unmount());
  return out;
}

// This site on its own (no sibling named) is the testnet one: its network states the jobs board, and asks its factory.
describe('the footer', () => {
  it('names every page in three groups, the code and the network, and marks the page it stands on', async () => {
    const { after, code, current } = await footer('/check', { forge: true, jobs: true });
    expect(after.links).toEqual([
      ['The race', '/'],
      ['League', '/league'],
      ['Forge', '/forge'],
      ['Jobs', '/jobs'],
      ['Get NEAR', '/near'],
      ['Swap', '/swap'],
      ['Wallet', '/wallet'],
      ['Connect an agent', '/mcp/connect'],
      ['MASK CHECK', '/check'],
      ['Hire the swarm', '/hire'],
      ['Private minds', '/verified'],
      ['GitHub', CODE_URL],
    ]);
    expect(after.text).toContain('Built on NEAR');
    expect(after.text).toContain(SITE.network);
    // The code opens in a tab of its own and tells the other site nothing about this one.
    expect(code).toEqual({ target: '_blank', rel: 'noopener noreferrer' });
    expect(current).toEqual(['MASK CHECK']);
  });

  it('shows Forge only once the factory says it is open, and drops Jobs once the chain says the contracts are not there', async () => {
    const shut = await footer('/', { forge: false, jobs: false });
    expect(shut.first.links.map((l) => l[0])).not.toContain('Forge');
    expect(shut.first.links.map((l) => l[0])).toContain('Jobs');
    expect(shut.after.links.map((l) => l[0])).not.toContain('Forge');
    expect(shut.after.links.map((l) => l[0])).not.toContain('Jobs');
    expect(shut.asked.sort()).toEqual(['/api/forge', '/api/jobs-open']);

    const open = await footer('/', { forge: true, jobs: true });
    expect(open.first.links.map((l) => l[0])).not.toContain('Forge');
    expect(open.after.links.map((l) => l[0]).slice(0, 4)).toEqual(['The race', 'League', 'Forge', 'Jobs']);
  });

  it('is not on the hire checkout’s frame or window, nor in the lab, and asks the chain nothing there', async () => {
    for (const path of ['/hire/embed', '/hire/prove', '/lab/arena']) {
      const { first, after, asked } = await footer(path);
      expect(first.foot, path).toBeNull();
      expect(after.foot, path).toBeNull();
      expect(asked, path).toEqual([]);
    }
  });

  it('is on every other page, a page that was not found included', async () => {
    for (const path of ['/', '/hire', '/race/race-0002', '/mask/nova', '/jobs/job-0007', '/nothing-here']) {
      expect((await footer(path)).after.foot, path).not.toBeNull();
    }
  });
});
