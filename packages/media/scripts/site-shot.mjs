// One 16:9 picture of a page of the live site, for a post: what a person sees at 1600×900, after the arena has drawn.
//
//   node scripts/site-shot.mjs https://maskwars.xyz/ out/home.png [seconds to wait, default 12]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const [url, out, wait = "12"] = process.argv.slice(2);
if (!url || !out) {
  console.error("usage: site-shot <url> <out.png> [seconds]");
  process.exit(2);
}
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 })).newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(Number(wait) * 1000);
  const file = resolve(out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await page.screenshot({ type: "png" }));
  console.log(file);
} finally {
  await browser.close();
}
