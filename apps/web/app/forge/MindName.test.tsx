// @vitest-environment happy-dom
// The model names on the forge's MIND step: every model in one face, a long name on more lines and never narrower.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MINDS } from '@maskwars/forge';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MindName } from './MindName';

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

const show = async (names: readonly string[]) => {
  await act(async () =>
    root.render(
      <>
        {names.map((n) => (
          <button key={n} type="button">
            <MindName name={n} />
          </button>
        ))}
      </>,
    ),
  );
  return [...box.querySelectorAll('button')].map((b) => b.firstElementChild as HTMLElement);
};

describe('a model’s name on its tile', () => {
  it('every model of the catalog stands in the same class: no name is marked long or set apart', async () => {
    expect(MINDS.length).toBeGreaterThan(1);
    const labels = await show(MINDS.map((m) => m.name));
    expect(new Set(labels.map((l) => l.className)).size).toBe(1);
    expect(labels[0]!.className).not.toBe('');
    expect(box.querySelector('[data-long]')).toBeNull();
    expect(box.querySelector('[style]')).toBeNull();
  });

  it('reads as the name itself, its words apart', async () => {
    const labels = await show(MINDS.map((m) => m.name));
    expect(labels.map((l) => l.textContent?.trim())).toEqual(MINDS.map((m) => m.name));
  });

  it('breaks between words: the last word in its own box, each word before it in one too', async () => {
    const [label] = await show(['DeepSeek V4.1 Flash']);
    const [head, tail] = [...label!.children];
    expect([...head!.children].map((w) => w.textContent)).toEqual(['DeepSeek ', 'V4.1 ']);
    expect(tail!.textContent).toBe('Flash');
  });

  it('a name of one word is one box', async () => {
    const [label] = await show(['Qwen']);
    expect(label!.children.length).toBe(1);
    expect(label!.textContent).toBe('Qwen');
  });
});

describe('the forge’s sheet', () => {
  const css = readFileSync(resolve(import.meta.dirname, 'forge.module.css'), 'utf8');
  /** Every rule of the sheet as [selector, body], media blocks opened. */
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!] as const);

  it('no rule narrows the face of a tile’s name', () => {
    const narrowed = rules.filter(([sel, body]) => /\.(tile|mind)/.test(sel) && /font-stretch:\s*(?!125%)/.test(body) && !/\.lookTile/.test(sel));
    expect(narrowed.map(([sel]) => sel)).toEqual([]);
  });

  it('a model’s name has one size on a desk and one on a phone, the same for every model', () => {
    const sizes = rules.filter(([sel, body]) => /\.mind\b/.test(sel) && /font-size/.test(body));
    expect(sizes.map(([sel]) => sel)).toEqual(['.tile .mind', '.tile .mind']);
  });
});
