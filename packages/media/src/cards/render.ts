/** Card page → PNG with Chromium. The page may not reach the network and may not log an error. */

import type { Browser } from "playwright";
import { chromium } from "playwright";
import type { CardKind } from "../detector.ts";
import type { MediaEvent } from "../event.ts";
import { CARD_H, CARD_SCALE, CARD_W, cardHtml } from "./html.ts";

export type CardRenderer = { render(kind: CardKind, e: MediaEvent): Promise<Buffer>; close(): Promise<void> };

const PREINSTALLED = "/opt/pw-browsers/chromium";

export async function launch(): Promise<Browser> {
  try {
    return await chromium.launch();
  } catch (e) {
    // A cloud box ships Chromium outside Playwright's own cache.
    const { existsSync, readdirSync } = await import("node:fs");
    const exe = existsSync(PREINSTALLED) ? readdirSync(PREINSTALLED).map((d) => `${PREINSTALLED}/${d}/chrome`).find(existsSync) : undefined;
    if (exe) return chromium.launch({ executablePath: exe });
    // A CI runner without Playwright's download still has Google Chrome.
    return chromium.launch({ channel: "chrome" }).catch(() => {
      throw e;
    });
  }
}

export type PageShot = { width: number; height: number; scale: number };

/**
 * One self-contained page → PNG. The page sets `window.__cardReady` when its fonts are in and its text is fitted; a
 * request to anything but a `data:` URL is cut, and a console error fails the shot.
 */
export async function shootPage(browser: Browser, html: string, size: PageShot, name: string): Promise<Buffer> {
  const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (err) => errors.push(err.message));
  await page.route("**/*", (r) => (r.request().url().startsWith("data:") ? r.continue() : r.abort()));
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.waitForFunction("window.__cardReady === true", undefined, { timeout: 10_000 });
    if (errors.length) throw new Error(`card ${name}: ${errors.join("; ")}`);
    return await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: size.width, height: size.height } });
  } finally {
    await ctx.close();
  }
}

export async function cardRenderer(): Promise<CardRenderer> {
  const browser = await launch();
  return {
    render: (kind, e) => shootPage(browser, cardHtml(kind, e), { width: CARD_W, height: CARD_H, scale: CARD_SCALE }, kind),
    close: () => browser.close(),
  };
}
