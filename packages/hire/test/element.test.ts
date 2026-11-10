// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"handleDisabledFileLoadingAsSuccess":true,"disableJavaScriptFileLoading":true,"disableCSSFileLoading":true}}
import { createElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { HireElement } from "../src/element.ts";
import { envelope, type HireEvent } from "../src/events.ts";

let amountLabel: (usd: string | null, near: string | null) => string;
let checkoutOrigin: (named: string | null, page: { origin: string; hostname: string }, script: string | null) => string;

beforeAll(async () => {
  ({ amountLabel, checkoutOrigin } = await import("../src/element.ts"));
});

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(attrs: Record<string, string>): HireElement {
  const el = document.createElement("mask-wars-hire") as HireElement;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

const button = (el: HireElement) => el.shadowRoot!.querySelector("button")!;
const sheet = () => document.querySelector("mask-wars-hire-sheet") as HTMLElement | null;
const frame = () => sheet()?.shadowRoot!.querySelector("iframe") ?? null;

/** A message as a window hears it: from `source`, sent from `origin`. */
function hear(data: unknown, origin: string, source: Window | null) {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}

describe("<mask-wars-hire>", () => {
  it("is one button: the word and the amount", () => {
    const el = mount({ usd: "250" });
    expect(button(el).textContent).toBe("Hire the swarm$250");
    expect(button(el).getAttribute("aria-label")).toBe("Hire the swarm, $250");
    el.setAttribute("near", "100");
    el.removeAttribute("usd");
    expect(button(el).textContent).toBe("Hire the swarm100 NEAR");
    el.setAttribute("label", "Break it before launch");
    expect(button(el).textContent).toBe("Break it before launch100 NEAR");
  });

  it("writes amounts the way the site does, and nothing it cannot read", () => {
    expect(amountLabel("1250", null)).toBe("$1,250");
    expect(amountLabel("12.5", null)).toBe("$12.50");
    expect(amountLabel(null, "2.5")).toBe("2.5 NEAR");
    expect(amountLabel("lots", null)).toBe("");
    expect(amountLabel("100000", null)).toBe("");
  });

  it("shows on the button exactly the amount the checkout will take", async () => {
    const { amountOf } = await import("../src/job.ts");
    const cases: [string | null, string | null][] = [
      ["250", null], ["1000.125", null], ["1000.125", "100"], ["$1,250.50", null], ["0", "3"], ["9999.99", null], ["10000", "5"],
      [null, "0.00001"], [null, "2,000"], [null, "2.5 NEAR"], [null, "1000000"], [null, "1000001"], ["12.", null], [".5", null], [" 40 ", null], ["lots", "lots"],
    ];
    for (const [usd, near] of cases) {
      const a = amountOf({ usd, near });
      const want = !a ? "" : "usd" in a ? amountLabel(String(a.usd), null) : amountLabel(null, String(a.near));
      expect([usd, near, amountLabel(usd, near)]).toEqual([usd, near, want]);
    }
  }, 30_000);

  it("opens the checkout from maskwars.xyz with only its own attributes and the host to tell", () => {
    const el = mount({ job: "Attack my vault before launch", target: "vault.acme.near", team: "acme.near", usd: "250", chain: "base" });
    button(el).click();
    const f = frame()!;
    const url = new URL(f.src);
    expect(url.origin).toBe("https://maskwars.xyz");
    expect(url.pathname).toBe("/hire/embed");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      job: "Attack my vault before launch",
      target: "vault.acme.near",
      team: "acme.near",
      usd: "250",
      chain: "base",
      host: location.origin,
    });
    expect(f.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(sheet()!.shadowRoot!.querySelector("[role=dialog]")!.getAttribute("aria-modal")).toBe("true");
  });

  it("opens the checkout only from maskwars.xyz, the page itself, or a local server on a local page", () => {
    // happy-dom's page is http://localhost:3000: a developer's own machine.
    button(mount({ origin: "http://localhost:3211" })).click();
    expect(new URL(frame()!.src).origin).toBe("http://localhost:3211");
    document.body.innerHTML = "";
    for (const evil of ["https://maskwars.xyz.evil.example", "https://evil.example", "http://evil.example", "javascript:alert(1)"]) {
      button(mount({ origin: evil })).click();
      expect([evil, new URL(frame()!.src).origin]).toEqual([evil, "https://maskwars.xyz"]);
      document.body.innerHTML = "";
    }
    const page = { origin: "https://app.example", hostname: "app.example" };
    expect(checkoutOrigin("https://app.example", page, null)).toBe("https://app.example");
    expect(checkoutOrigin("http://localhost:3211", page, null)).toBe("https://maskwars.xyz");
    expect(checkoutOrigin(null, page, "https://preview.example")).toBe("https://preview.example");
    expect(checkoutOrigin("https://other.example", page, "https://preview.example")).toBe("https://preview.example");
  });

  it("gives the sheet its own way out until the checkout says it is up, and says so if it never does", async () => {
    vi.useFakeTimers();
    try {
      const el = mount({ usd: "250" });
      const closed: string[] = [];
      el.addEventListener("hire:close", () => closed.push("close"));
      button(el).click();
      const root = sheet()!.shadowRoot!;
      expect(sheet()!.hasAttribute("data-failed")).toBe(false);
      vi.advanceTimersByTime(15_000);
      expect(sheet()!.hasAttribute("data-failed")).toBe(true);
      expect(root.querySelector(".fail")!.textContent).toBe("The checkout did not load. Nothing has moved.");
      (root.querySelector(".x") as HTMLButtonElement).click();
      expect(closed).toEqual(["close"]);
      expect(document.documentElement.style.overflow).toBe("");
      // Opening again tries a new frame rather than the one that never came up.
      const dead = frame();
      button(el).click();
      expect(frame()).not.toBe(dead);
      expect(sheet()!.hasAttribute("data-failed")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes on the checkout's events as hire:* events, only from its own frame and origin", () => {
    const el = mount({ usd: "250" });
    button(el).click();
    const heard: HireEvent[] = [];
    el.addEventListener("hire:funded", (e) => heard.push((e as CustomEvent<HireEvent>).detail));
    const job = { id: "job-0123456789ab", hash: "0".repeat(64), text: "Attack my vault before launch", target: "vault.acme.near", team: "acme.near" };
    const funded = envelope({ type: "funded", job, near: "67.21", txs: [] });
    const win = frame()!.contentWindow;
    hear(funded, "https://evil.example", win);
    hear(funded, "https://maskwars.xyz", window);
    hear({ maskwarsHire: 2, event: { type: "funded" } }, "https://maskwars.xyz", win);
    expect(heard).toHaveLength(0);
    hear(funded, "https://maskwars.xyz", win);
    expect(heard).toEqual([{ type: "funded", job, near: "67.21", txs: [] }]);
  });

  it("closes when the checkout says so, on Escape and on the scrim, and gives focus back to the button", async () => {
    const el = mount({ usd: "250" });
    const closed: string[] = [];
    el.addEventListener("hire:close", () => closed.push("close"));
    button(el).click();
    expect(document.documentElement.style.overflow).toBe("hidden");
    hear(envelope({ type: "close" }), "https://maskwars.xyz", frame()!.contentWindow);
    expect(closed).toEqual(["close"]);
    expect(document.documentElement.style.overflow).toBe("");
    button(el).click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closed).toHaveLength(2);
    button(el).click();
    (sheet()!.shadowRoot!.querySelector(".scrim") as HTMLElement).click();
    expect(closed).toHaveLength(3);
    expect(el.shadowRoot!.activeElement).toBe(button(el));
  });

  it("keeps the checkout while a deposit is on its way, and starts a fresh one for a new job otherwise", () => {
    const el = mount({ usd: "250" });
    button(el).click();
    const first = frame();
    el.close();
    el.setAttribute("usd", "500");
    button(el).click();
    expect(frame()).not.toBe(first);
    expect(new URL(frame()!.src).searchParams.get("usd")).toBe("500");
    const job = { id: "job-0123456789ab", hash: "0".repeat(64), text: "Attack my vault before launch", target: "vault.acme.near", team: "acme.near" };
    hear(
      envelope({ type: "deposit", job, chain: "sol", coin: "USDC", amount: "500", address: "x", memo: null, deadline: "", near: "1" }),
      "https://maskwars.xyz",
      frame()!.contentWindow,
    );
    const paying = frame();
    el.close();
    el.setAttribute("usd", "750");
    button(el).click();
    expect(frame()).toBe(paying);
    // The payer drops that address for a new one: from then on the attributes count again.
    hear(envelope({ type: "dropped", job: job.id }), "https://maskwars.xyz", paying!.contentWindow);
    el.close();
    button(el).click();
    expect(frame()).not.toBe(paying);
    expect(new URL(frame()!.src).searchParams.get("usd")).toBe("750");
  });

  it("starts fresh once a job ends, and keeps a new deposit made after a refund", () => {
    const el = mount({ usd: "250" });
    button(el).click();
    const job = { id: "job-0123456789ab", hash: "0".repeat(64), text: "Attack my vault before launch", target: "vault.acme.near", team: "acme.near" };
    const deposit = envelope({ type: "deposit", job, chain: "sol", coin: "USDC", amount: "250", address: "x", memo: null, deadline: "", near: "1" });
    const paying = frame();
    hear(deposit, "https://maskwars.xyz", paying!.contentWindow);
    el.setAttribute("usd", "750");
    // Once that job ends, the next open is a fresh checkout for whatever the attributes say now.
    hear(envelope({ type: "refunded", job, stage: "refunded" }), "https://maskwars.xyz", paying!.contentWindow);
    // "Try again" in the checkout hands out a new address: that one is kept like the first.
    hear(deposit, "https://maskwars.xyz", paying!.contentWindow);
    el.close();
    button(el).click();
    expect(frame()).toBe(paying);
    hear(envelope({ type: "funded", job, near: "1", txs: [] }), "https://maskwars.xyz", paying!.contentWindow);
    el.close();
    button(el).click();
    expect(frame()).not.toBe(paying);
    expect(new URL(frame()!.src).searchParams.get("usd")).toBe("750");
  });

  it("works under React: <HireButton origin=…> sets attributes, not the element's own workings", async () => {
    const { HireButton } = await import("../src/react.tsx");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const funded: unknown[] = [];
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    await act(async () => root.render(createElement(HireButton, { usd: 250, origin: "http://localhost:3211", job: "Attack my vault before launch", onFunded: (e) => funded.push(e) })));
    const el = host.querySelector("mask-wars-hire") as HireElement;
    expect(button(el).textContent).toBe("Hire the swarm$250");
    expect(() => button(el).click()).not.toThrow();
    expect(new URL(frame()!.src).origin).toBe("http://localhost:3211");
    const job = { id: "job-0123456789ab", hash: "0".repeat(64), text: "Attack my vault before launch", target: "vault.acme.near", team: "acme.near" };
    hear(envelope({ type: "funded", job, near: "1", txs: [] }), "http://localhost:3211", frame()!.contentWindow);
    expect(funded).toHaveLength(1);
    await act(async () => root.render(createElement(HireButton, { usd: 500, origin: "http://localhost:3211" })));
    expect(button(el).textContent).toBe("Hire the swarm$500");
    await act(async () => root.unmount());
  });
});
