import { checkoutUrl, domEvent, HIRE_ORIGIN, hireMessage, originOk, type HireEvent } from "./events.ts";

/**
 * <mask-wars-hire>: the button any NEAR app puts on its page to hire the swarm. It draws itself in its own shadow root,
 * and on a click opens the checkout over the page: a frame from maskwars.xyz, where the money is quoted, read back and
 * followed. Nothing about money runs in the host page and nothing of the host page reaches the checkout but the
 * element's own attributes. What happens in the checkout comes back as `hire:*` DOM events on the element.
 *
 *   <script src="https://maskwars.xyz/hire/v1.js" async></script>
 *   <mask-wars-hire job="Attack my contract before launch" target="vault.acme.near" team="acme.near" usd="250"></mask-wars-hire>
 *
 * Attributes: `job` (what the masks should do), `target` (the contract), `team` (the team's NEAR account: its vault
 * holds the money and takes refunds), `usd` or `near` (the amount), `chain` (sol, base, eth, arb, tron, btc: the
 * payer's network, picked first), `label` (the button's word), `origin` (where the checkout lives; maskwars.xyz).
 * Anything the attributes leave out, the checkout asks for. The payer proves the vault is theirs in a MASK WARS window
 * before any address is shown, so a page can only name a vault its own payer holds.
 *
 * The `hire:*` events say what the checkout saw, for the page's own screen. They are not proof of payment: anyone can
 * dispatch an event on an element. Before a page gives anything for a hire, it checks the chain itself (the `txs` of
 * `hire:funded` on NEAR, or the vault's balance in NEAR Intents), and never grants access on an event alone.
 */

export const TAG = "mask-wars-hire";
const ATTRS = ["job", "target", "team", "usd", "near", "chain", "label", "origin"] as const;
const MARK = "M47 0 L120 87 L193 0 L224 95 L138 155 L138 179 L214 126 L164 280 L120 228 L76 280 L26 126 L102 179 L102 155 L16 95Z";

/** The checkout's origin when the page does not name one: the site this script came from, if it is our served bundle. */
const SCRIPT_ORIGIN = (() => {
  if (typeof document === "undefined") return null;
  const src = (document.currentScript as HTMLScriptElement | null)?.src;
  if (!src || !/\/hire\/v\d+(\.[0-9a-f]{10})?\.js(\?|$)/.test(src)) return null;
  return originOk(src);
})();

/**
 * `$250`, `$1,250`, `$12.50`, `100 NEAR`: the amount on the button, read by the checkout's own rules (`amountOf`), so
 * the button never shows an amount the checkout would not take: dollars from 1 to 9,999.99 with up to two decimals
 * first, else NEAR up to 1,000,000 with up to four. Nothing when neither reads. Kept apart from `job.ts` so this script
 * carries no hashing code onto host pages; a test holds the two together.
 */
export function amountLabel(usd: string | null, near: string | null): string {
  const d = usd ? usd.trim().replace(/^\$/, "").replace(/[,\s]/g, "") : "";
  const dv = /^\d{1,4}(?:\.\d{0,2})?$/.test(d) ? Number(d) : 0;
  if (dv > 0) return `$${dv.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(dv) ? 0 : 2, maximumFractionDigits: 2 })}`;
  const n = near ? near.trim().replace(/[,\s]/g, "").replace(/NEAR$/i, "") : "";
  const nv = /^\d{1,7}(?:\.\d{0,4})?$/.test(n) ? Number(n) : 0;
  return nv > 0 && nv <= 1_000_000 ? `${nv.toLocaleString("en-US", { maximumFractionDigits: 4 })} NEAR` : "";
}

// Never wider than the box the host gives it: tighter on a phone, and in a narrower box still the word wraps onto a
// second line rather than run past the edge.
const BUTTON_CSS = `
:host{display:inline-block;max-width:100%;vertical-align:middle;-webkit-tap-highlight-color:transparent}
:host([hidden]){display:none}
button{all:unset;box-sizing:border-box;display:inline-flex;align-items:center;gap:14px;max-width:100%;min-height:60px;padding:0 22px;
border-radius:2px;background:#06050c;color:#eef1ff;box-shadow:inset 0 0 0 1px rgba(238,241,255,.16);cursor:pointer;
font-family:"MaskWars Hubot",system-ui,sans-serif;font-weight:800;font-stretch:125%;font-size:14px;line-height:1.1;
letter-spacing:.06em;text-transform:uppercase;touch-action:manipulation;user-select:none;
transition:transform 100ms cubic-bezier(.2,0,0,1),background-color 160ms}
button:focus-visible{box-shadow:inset 0 0 0 1px rgba(238,241,255,.16),0 0 0 2px #eef1ff,0 0 0 4px #06050c}
button:active{transform:scale(.97)}
@media (hover:hover){button:hover{background:#0c0b14}}
svg{width:18px;height:21px;flex:none;fill:#eef1ff}
.word{min-width:0;padding:8px 0;text-wrap:balance;overflow-wrap:anywhere}
.sum{flex:none;margin-left:4px;padding-left:16px;box-shadow:inset 1px 0 0 rgba(238,241,255,.16);font-family:"MaskWars Mona",system-ui,sans-serif;
font-size:19px;letter-spacing:0;color:#00ec97;align-self:stretch;display:flex;align-items:center;white-space:nowrap}
.sum:empty{display:none}
@media (max-width:420px){button{gap:10px;padding:0 16px;font-size:13px;letter-spacing:.04em}.sum{padding-left:12px;font-size:17px}}
@media (prefers-reduced-motion:reduce){button{transition:background-color 200ms}button:active{transform:none}}
`;

const SHEET_CSS = `
:host{all:initial}
:host([hidden]){display:none}
:host(:not([data-open])) .scrim,:host(:not([data-open])) .sheet{pointer-events:none}
.scrim{position:fixed;inset:0;z-index:2147483646;background:rgba(6,5,12,.78);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
opacity:0;transition:opacity 220ms}
.sheet{position:fixed;z-index:2147483647;left:50%;top:50%;width:min(480px,calc(100vw - 32px));height:min(760px,calc(100dvh - 48px));
transform:translate(-50%,calc(-50% + 12px));opacity:0;transition:opacity 240ms,transform 320ms cubic-bezier(.2,0,0,1);
background:#0c0b14;border-radius:2px;box-shadow:0 0 0 1px rgba(238,241,255,.12),0 40px 120px rgba(0,0,0,.6);overflow:hidden}
:host([data-open]) .scrim{opacity:1}
:host([data-open]) .sheet{opacity:1;transform:translate(-50%,-50%)}
iframe{display:block;width:100%;height:100%;border:0;background:#0c0b14;opacity:0;transition:opacity 200ms;pointer-events:none}
:host([data-ready]) iframe{opacity:1;pointer-events:auto}
.wait{position:absolute;left:50%;top:50%;width:28px;height:33px;margin:-17px 0 0 -14px;fill:#eef1ff;opacity:.4;animation:breathe 1.6s ease-in-out infinite}
:host([data-ready]) .wait,:host([data-ready]) .x,:host([data-ready]) .fail{display:none}
.x{all:unset;position:absolute;z-index:1;top:6px;right:6px;width:44px;height:44px;display:grid;place-items:center;cursor:pointer;
color:rgba(238,241,255,.62);font:400 28px/1 system-ui,sans-serif}
.x:focus-visible{outline:2px solid #eef1ff;outline-offset:-4px}
.fail{display:none;position:absolute;left:24px;right:24px;top:calc(50% + 36px);margin:0;text-align:center;
font:500 15px/1.4 "MaskWars Mona",system-ui,sans-serif;color:rgba(238,241,255,.62)}
:host([data-failed]) .fail{display:block}
:host([data-failed]) .wait{animation:none;opacity:.25}
@keyframes breathe{50%{opacity:.15}}
@media (max-width:560px){.sheet{left:0;top:0;width:100vw;height:100dvh;border-radius:0;box-shadow:none;transform:translateY(16px)}
:host([data-open]) .sheet{transform:none}}
@media (prefers-reduced-motion:reduce){.sheet,:host([data-open]) .sheet{transform:translate(-50%,-50%);transition:opacity 200ms}
.wait{animation:none}}
@media (prefers-reduced-motion:reduce) and (max-width:560px){.sheet,:host([data-open]) .sheet{transform:none}}
`;

/** Styles a shadow root under any host CSP: a constructed sheet where the browser has them, a style element otherwise. */
function style(root: ShadowRoot, css: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const el = document.createElement("style");
    el.textContent = css;
    root.append(el);
  }
}

const fontsAsked = new Set<string>();
/** The brand's two faces from the checkout's origin, once per origin; the button reads fine in system type until then. */
function loadFonts(origin: string): void {
  if (fontsAsked.has(origin) || typeof FontFace === "undefined") return;
  fontsAsked.add(origin);
  for (const [family, file] of [
    ["MaskWars Hubot", "hubot-sans"],
    ["MaskWars Mona", "mona-sans"],
  ] as const) {
    const face = new FontFace(family, `url(${origin}/hire/${file}.woff2) format("woff2")`, { weight: "200 900", stretch: "75% 125%", display: "swap" });
    document.fonts.add(face);
    face.load().catch(() => {
      /* the host's policy or the network said no: system type stays */
    });
  }
}

function svgMark(cls?: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 240 280");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", MARK);
  svg.append(path);
  return svg;
}

export interface HireElement extends HTMLElement {
  /** Opens the checkout, as a click on the button does. */
  open(): void;
  /** Closes it. A deposit address already handed out stays: opening again shows it. */
  close(): void;
}

/** How long the checkout may take to say it is up before the sheet says it did not load. */
const LOAD_MS = 15_000;

const LOCAL = /^(localhost|127\.0\.0\.1)$/;

/**
 * Where the checkout opens from. A page may name only maskwars.xyz, itself (this site on a preview), or, on a
 * developer's own machine, a local server: never a third site that could dress up as the checkout.
 */
export function checkoutOrigin(named: string | null, page: { origin: string; hostname: string }, script: string | null): string {
  const o = named ? originOk(named) : null;
  if (o && (o === HIRE_ORIGIN || o === page.origin || (LOCAL.test(page.hostname) && LOCAL.test(new URL(o).hostname)))) return o;
  return script ?? HIRE_ORIGIN;
}

function define(): void {
  // Everything inside is `#private`: React 19 sets a prop as a property whenever the element has one by that name, so
  // a method called `origin` would be overwritten by <HireButton origin=…>.
  class MaskWarsHire extends HTMLElement implements HireElement {
    static observedAttributes = [...ATTRS];

    readonly #button: HTMLButtonElement;
    readonly #word: HTMLSpanElement;
    readonly #sum: HTMLSpanElement;
    #sheetHost: HTMLElement | null = null;
    #frame: HTMLIFrameElement | null = null;
    #frameOrigin = "";
    /** A deposit address is out and the swap has not ended: the frame is kept whatever changes. */
    #busy = false;
    /** The last job ended (funded, refunded, failed): the next open starts a fresh checkout. */
    #spent = false;
    /** The attributes changed since the frame was made: the next open starts fresh unless money is on its way. */
    #stale = false;
    #openNow = false;
    #pageOverflow = "";
    #loadTimer: ReturnType<typeof setTimeout> | undefined;

    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      style(root, BUTTON_CSS);
      this.#button = document.createElement("button");
      this.#button.type = "button";
      this.#button.setAttribute("part", "button");
      this.#button.setAttribute("aria-haspopup", "dialog");
      this.#word = document.createElement("span");
      this.#word.className = "word";
      this.#word.setAttribute("part", "label");
      this.#sum = document.createElement("span");
      this.#sum.className = "sum";
      this.#sum.setAttribute("part", "amount");
      this.#button.append(svgMark(), this.#word, this.#sum);
      root.append(this.#button);
      this.#button.addEventListener("click", () => this.open());
    }

    connectedCallback(): void {
      this.#render();
      loadFonts(this.#origin());
      window.addEventListener("message", this.#onMessage);
    }

    disconnectedCallback(): void {
      window.removeEventListener("message", this.#onMessage);
      this.close();
      clearTimeout(this.#loadTimer);
      this.#sheetHost?.remove();
      this.#sheetHost = null;
      this.#frame = null;
    }

    attributeChangedCallback(name: string, before: string | null, after: string | null): void {
      if (before === after) return;
      this.#render();
      if (name !== "label" && this.#frame) this.#stale = true;
    }

    #origin(): string {
      return checkoutOrigin(this.getAttribute("origin"), location, SCRIPT_ORIGIN);
    }

    #render(): void {
      this.#word.textContent = (this.getAttribute("label") ?? "").trim().slice(0, 40) || "Hire the swarm";
      const sum = amountLabel(this.getAttribute("usd"), this.getAttribute("near"));
      this.#sum.textContent = sum;
      this.#button.setAttribute("aria-label", sum ? `${this.#word.textContent}, ${sum}` : this.#word.textContent);
    }

    open(): void {
      if (this.#openNow) return;
      const host = this.#sheet();
      // A frame that never came up is tried again: a phone's network drops one more often than a page reloads.
      const fresh =
        !this.#frame || this.#spent || host.hasAttribute("data-failed") || (this.#stale && !this.#busy) || this.#frameOrigin !== this.#origin();
      if (fresh) this.#makeFrame(host);
      this.#openNow = true;
      this.#pageOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      host.hidden = false;
      // The next frame, so the sheet slides in rather than appearing.
      requestAnimationFrame(() => requestAnimationFrame(() => host.setAttribute("data-open", "")));
      if (host.hasAttribute("data-ready")) this.#frame!.focus();
      else (host.shadowRoot!.querySelector(".x") as HTMLElement | null)?.focus({ preventScroll: true });
      document.addEventListener("keydown", this.#onKey, true);
      this.dispatchEvent(new CustomEvent("hire:open", { bubbles: true, composed: true }));
    }

    close(): void {
      if (!this.#openNow || !this.#sheetHost) return;
      this.#openNow = false;
      document.removeEventListener("keydown", this.#onKey, true);
      document.documentElement.style.overflow = this.#pageOverflow;
      const host = this.#sheetHost;
      host.removeAttribute("data-open");
      setTimeout(() => {
        if (!this.#openNow) host.hidden = true;
      }, 320);
      this.#button.focus({ preventScroll: true });
      this.#emit({ type: "close" });
    }

    #makeFrame(host: HTMLElement): void {
      this.#spent = false;
      this.#stale = false;
      this.#busy = false;
      this.#frame?.remove();
      host.removeAttribute("data-ready");
      host.removeAttribute("data-failed");
      this.#frameOrigin = this.#origin();
      const f = document.createElement("iframe");
      f.title = "Hire the swarm · MASK WARS";
      f.allow = "clipboard-write";
      f.referrerPolicy = "strict-origin";
      // Scripts and its own origin for its API, and one window of its own: where the payer proves the vault on
      // maskwars.xyz itself, outside this page and out of its reach. No navigating this page.
      f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
      f.src = checkoutUrl(this.#frameOrigin, {
        job: this.getAttribute("job"),
        target: this.getAttribute("target"),
        team: this.getAttribute("team"),
        usd: this.getAttribute("usd"),
        near: this.getAttribute("near"),
        chain: this.getAttribute("chain"),
        host: location.origin,
      });
      host.shadowRoot!.querySelector(".sheet")!.append(f);
      this.#frame = f;
      // A frame the page's own policy, a blocker or the network stops never says it is up: say so, with a way out.
      clearTimeout(this.#loadTimer);
      this.#loadTimer = setTimeout(() => {
        if (!host.hasAttribute("data-ready")) host.setAttribute("data-failed", "");
      }, LOAD_MS);
    }

    /** The overlay, made once and kept in the body, in its own shadow root so no page style reaches it. */
    #sheet(): HTMLElement {
      if (this.#sheetHost) return this.#sheetHost;
      const host = document.createElement("mask-wars-hire-sheet");
      host.hidden = true;
      const root = host.attachShadow({ mode: "open" });
      style(root, SHEET_CSS);
      const scrim = document.createElement("div");
      scrim.className = "scrim";
      scrim.addEventListener("click", () => this.close());
      const sheet = document.createElement("div");
      sheet.className = "sheet";
      sheet.setAttribute("role", "dialog");
      sheet.setAttribute("aria-modal", "true");
      sheet.setAttribute("aria-label", "Hire the swarm");
      // Until the checkout is up, the sheet's own way out: a close button, and a line if it never comes.
      const x = document.createElement("button");
      x.type = "button";
      x.className = "x";
      x.setAttribute("aria-label", "Close");
      x.textContent = "×";
      x.addEventListener("click", () => this.close());
      const fail = document.createElement("p");
      fail.className = "fail";
      fail.setAttribute("role", "alert");
      fail.textContent = "The checkout did not load. Nothing has moved.";
      sheet.append(svgMark("wait"), fail, x);
      // Tab leaving the frame lands here and goes back into it: the page behind waits until the sheet closes.
      const keep = () => {
        const k = document.createElement("span");
        k.tabIndex = 0;
        k.addEventListener("focus", () => (host.hasAttribute("data-ready") ? this.#frame?.focus() : x.focus()));
        return k;
      };
      root.append(scrim, keep(), sheet, keep());
      document.body.append(host);
      this.#sheetHost = host;
      return host;
    }

    #onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      }
    };

    #onMessage = (e: MessageEvent): void => {
      if (!this.#frame || e.source !== this.#frame.contentWindow || e.origin !== this.#frameOrigin) return;
      const event = hireMessage(e.data);
      if (!event) return;
      switch (event.type) {
        case "ready":
          clearTimeout(this.#loadTimer);
          this.#sheetHost?.removeAttribute("data-failed");
          this.#sheetHost?.setAttribute("data-ready", "");
          if (this.#openNow) this.#frame.focus();
          return;
        case "close":
          // `close()` tells the host itself, whichever way the sheet closes.
          return this.close();
        case "deposit":
          this.#busy = true;
          this.#spent = false;
          break;
        case "dropped":
          this.#busy = false;
          break;
        case "funded":
        case "refunded":
        case "failed":
          this.#busy = false;
          this.#spent = true;
          break;
      }
      this.#emit(event);
    };

    #emit(event: HireEvent): void {
      this.dispatchEvent(new CustomEvent(domEvent(event.type), { detail: event, bubbles: true, composed: true }));
    }
  }

  customElements.define(TAG, MaskWarsHire);
}

if (typeof window !== "undefined" && typeof customElements !== "undefined" && !customElements.get(TAG)) define();
