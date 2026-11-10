"use client";

import { useEffect, useRef, type CSSProperties, type ReactElement, type Ref } from "react";
import { TAG, type HireElement } from "./element.ts";
import { domEvent, type HireEvent, type HireEventType } from "./events.ts";

type Of<T extends HireEventType> = Extract<HireEvent, { type: T }>;

export interface HireButtonProps {
  /** What the masks should do. */
  job?: string;
  /** The contract the job is about. */
  target?: string;
  /** The team's NEAR account: its vault holds the job's money and takes refunds. */
  team?: string;
  /** The amount in dollars, or `near` in NEAR. */
  usd?: number | string;
  near?: number | string;
  /** The payer's network, picked first: sol, base, eth, arb, tron, btc. */
  chain?: string;
  /** The button's word. */
  label?: string;
  /** Where the checkout lives: maskwars.xyz unless a preview or local run is named. */
  origin?: string;
  className?: string;
  style?: CSSProperties;
  onOpen?: () => void;
  onDeposit?: (e: Of<"deposit">) => void;
  onDropped?: (e: Of<"dropped">) => void;
  onProgress?: (e: Of<"progress">) => void;
  onFunded?: (e: Of<"funded">) => void;
  onRefunded?: (e: Of<"refunded">) => void;
  onFailed?: (e: Of<"failed">) => void;
  onClose?: () => void;
}

/**
 * <mask-wars-hire> for React: the same element, its attributes from props and its events as callbacks. The element
 * registers itself when this module loads in a browser; on the server it renders as an empty tag the browser upgrades.
 */
export function HireButton(p: HireButtonProps) {
  const ref = useRef<HireElement>(null);
  const handlers = useRef(p);
  handlers.current = p;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on: [string, (e: Event) => void][] = [
      ["hire:open", () => handlers.current.onOpen?.()],
      [domEvent("deposit"), (e) => handlers.current.onDeposit?.((e as CustomEvent<Of<"deposit">>).detail)],
      [domEvent("dropped"), (e) => handlers.current.onDropped?.((e as CustomEvent<Of<"dropped">>).detail)],
      [domEvent("progress"), (e) => handlers.current.onProgress?.((e as CustomEvent<Of<"progress">>).detail)],
      [domEvent("funded"), (e) => handlers.current.onFunded?.((e as CustomEvent<Of<"funded">>).detail)],
      [domEvent("refunded"), (e) => handlers.current.onRefunded?.((e as CustomEvent<Of<"refunded">>).detail)],
      [domEvent("failed"), (e) => handlers.current.onFailed?.((e as CustomEvent<Of<"failed">>).detail)],
      [domEvent("close"), () => handlers.current.onClose?.()],
    ];
    for (const [name, fn] of on) el.addEventListener(name, fn);
    return () => {
      for (const [name, fn] of on) el.removeEventListener(name, fn);
    };
  }, []);

  const attrs: Record<string, string> = {};
  for (const k of ["job", "target", "team", "usd", "near", "chain", "label", "origin"] as const) {
    const v = p[k];
    if (v !== undefined && v !== "") attrs[k] = String(v);
  }
  return <Tag ref={ref} class={p.className} style={p.style} {...attrs} />;
}

// React 19 passes string props on a custom element through as attributes: `class` here, not `className`.
const Tag = TAG as unknown as (props: Record<string, unknown> & { ref: Ref<HireElement> }) => ReactElement;
