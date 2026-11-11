// @vitest-environment happy-dom
// The network beside the mark: on every page, in the same place, whether the page passes it or not.
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { SITE } from '@/lib/site';
import { Header } from './Header';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ usePathname: () => '/check' }));
vi.mock('next/link', () => ({ default: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) => <a href={href} className={className}>{children}</a> }));
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
