// @vitest-environment happy-dom
// The quiet «i»: its sheet opens over the page and closes with Escape or a tap outside; a tap on the dimmed page closes
// it with that tap's own click, so the same tap never lands on the button behind it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Info } from './Info';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const show = async (fill = false) => {
  await act(async () =>
    root.render(
      <p>
        You pay
        <Info rows={[{ label: 'Rate', value: '1 NEAR ≈ $3.41' }]} label="Details" anchor="line" align="start" fill={fill}>
          <span>Swapped by NEAR Intents.</span>
        </Info>
      </p>,
    ),
  );
};
const mark = () => box.querySelector('button[aria-label="Details"]') as HTMLButtonElement;
const sheet = () => document.querySelector('[role="dialog"]');
const tap = async (el: Element, type: string) => act(async () => void el.dispatchEvent(new Event(type, { bubbles: true })));
const press = async (key: string) => act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));

describe('the «i» and its sheet', () => {
  it('is closed until the «i» is pressed, then holds its rows and what it was given', async () => {
    await show();
    expect(sheet()).toBeNull();
    expect(mark().getAttribute('aria-expanded')).toBe('false');
    await act(async () => mark().click());
    expect(mark().getAttribute('aria-expanded')).toBe('true');
    expect(sheet()?.getAttribute('aria-label')).toBe('Details');
    expect(sheet()?.textContent).toContain('1 NEAR ≈ $3.41');
    expect(sheet()?.textContent).toContain('Swapped by NEAR Intents.');
    // It is the «i»'s own sheet: the button says which element it opens.
    expect(mark().getAttribute('aria-controls')).toBe(sheet()?.id);
  });

  it('closes with Escape', async () => {
    await show();
    await act(async () => mark().click());
    await press('Escape');
    expect(sheet()).toBeNull();
  });

  it('closes when the page outside it is pressed, and stays for a press inside it', async () => {
    await show();
    await act(async () => mark().click());
    await tap(sheet()!.firstElementChild!, 'pointerdown');
    expect(sheet()).not.toBeNull();
    await tap(document.body, 'pointerdown');
    expect(sheet()).toBeNull();
  });

  it('a tap on the dimmed page closes it on the click, not on the way down: the tap never reaches what is behind', async () => {
    await show();
    await act(async () => mark().click());
    const dim = sheet()!.previousElementSibling as HTMLElement;
    expect(dim.getAttribute('aria-hidden')).toBe('true');
    await tap(dim, 'pointerdown');
    expect(sheet()).not.toBeNull();
    await act(async () => dim.click());
    expect(sheet()).toBeNull();
  });

  it('`fill` marks the sheet as wide as its line, and only then', async () => {
    await show(true);
    await act(async () => mark().click());
    expect(sheet()?.hasAttribute('data-fill')).toBe(true);
    expect(box.querySelector('[data-anchor="line"]')?.hasAttribute('data-fill')).toBe(true);
    await act(async () => mark().click());
    await show(false);
    await act(async () => mark().click());
    expect(sheet()?.hasAttribute('data-fill')).toBe(false);
  });
});
