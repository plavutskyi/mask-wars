import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { color } from '@maskwars/brand';
import { LINE, pageMeta, SITE } from '@/lib/meta';
import { siteOrigin } from '@/lib/site';
import { hubot, mona } from './fonts';
import './globals.css';

// Every canonical address and card of this deployment points at its own host: the site on the other network has its own.
export const metadata: Metadata = {
  metadataBase: new URL(siteOrigin()),
  ...pageMeta({ title: SITE, description: LINE, path: '/' }),
};

export const viewport: Viewport = {
  themeColor: color.ink,
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${hubot.variable} ${mona.variable}`}>
      <body>{children}</body>
    </html>
  );
}
