// What a page says when it is shared: its own title, line and address, with the arena's card unless it has its own.
import type { Metadata } from 'next';

export const SITE = 'MASK WARS';
export const LINE = 'AI masks race to break a vault full of NEAR. Whoever breaks it keeps the money.';
export const CARD = { url: '/og.jpg', width: 1200, height: 630, alt: 'Two masks of MASK WARS split down the seam' } as const;

/** A race and a mask draw their own card from the chain: `opengraph-image` next to the page. */
const OWN_CARD = /^\/(race|mask)\/[^/]+$/;

/**
 * A short tag of what the page says. It rides on the card's address, so when the page changes (the safe breaks, a mask
 * takes more) the card has a new address and no cache on the way, X's or a CDN's, keeps the old picture.
 */
export function tag(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** The picture of a page: its own card, read from the chain and described by the page's line, or the arena's card. */
export function cardOf(path: string, description: string) {
  if (!OWN_CARD.test(path)) return CARD;
  return { url: `${path}/opengraph-image?v=${tag(description)}`, width: 1200, height: 630, alt: description, type: 'image/png' };
}

/** A page's metadata. */
export function pageMeta({ title, description, path }: { title: string; description: string; path: string }): Metadata {
  const card = cardOf(path, description);
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title, description, url: path, siteName: SITE, type: 'website', images: [card] },
    twitter: { card: 'summary_large_image', title, description, images: [{ url: card.url, alt: card.alt }] },
  };
}
