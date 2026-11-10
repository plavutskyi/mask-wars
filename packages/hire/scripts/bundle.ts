import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Where the site serves the host-page files from: apps/web/public/hire → https://maskwars.xyz/hire/. */
export const OUT = new URL("../../../apps/web/public/hire/", import.meta.url);

const HEAD = "/* MASK WARS · Hire the swarm · <mask-wars-hire> v1. Generated from packages/hire/src/element.ts, do not edit. */\n";

/** What /hire hands hosts for the pinned script: its file and its Subresource Integrity hash. */
export const RELEASE = new URL("../../../apps/web/app/hire/release.json", import.meta.url);

/** The pinned name and integrity of a built script: `v1.<10 hex of sha256>.js` and `sha384-…`. */
export function release(code: string): { file: string; integrity: string } {
  const sha = (alg: string) => createHash(alg).update(code, "utf8");
  return { file: `v1.${sha("sha256").digest("hex").slice(0, 10)}.js`, integrity: `sha384-${sha("sha384").digest("base64")}` };
}

/** The element and everything it imports, as one minified script with no imports of its own. */
export async function bundle(): Promise<string> {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("../src/element.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    target: ["es2020", "safari15"],
    minify: true,
    legalComments: "none",
    write: false,
    logLevel: "silent",
  });
  return HEAD + out.outputFiles[0]!.text;
}

/** The brand's two variable faces, byte for byte from packages/brand. */
export function fonts(): [string, Uint8Array][] {
  return ["hubot-sans.woff2", "mona-sans.woff2"].map((f) => [f, readFileSync(new URL(`../../brand/fonts/${f}`, import.meta.url))]);
}
