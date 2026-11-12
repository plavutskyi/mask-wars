import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import release from './release.json';
import { waysTo } from './Embed';

// What /hire hands a builder to paste: each way names the same pinned script and its integrity, and the React way is a
// component that compiles as it is copied.
describe('the ways to embed Hire the swarm', () => {
  const ways = waysTo('https://maskwars.xyz');

  it('gives HTML, React and events, each with the pinned script where it loads one', () => {
    expect(ways.map((w) => w.id)).toEqual(['html', 'react', 'events']);
    for (const w of ways.filter((x) => x.id !== 'events')) {
      expect(w.text).toContain(`https://maskwars.xyz/hire/${release.file}`);
      expect(w.text).toContain(release.integrity);
    }
  });

  it('gives a React component that compiles as TSX and loads the script once', () => {
    const react = ways.find((w) => w.id === 'react')!.text;
    const out = ts.transpileModule(react, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
    expect(out.diagnostics ?? []).toEqual([]);
    expect(out.outputText).toContain('mask-wars-hire');
    expect(react).toContain("addEventListener('hire:funded'");
    expect(react).toMatch(/if \(!document\.querySelector\(`script\[src="\$\{SRC\}"\]`\)\)/);
  });
});
