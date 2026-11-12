import type { Metadata } from 'next';
import Image from 'next/image';
import { Header } from '@/components/arena/Header';
import { CARD, SITE } from '@/lib/meta';

// A page that is not there has its own title and no canonical address: the layout's would call it the home page. Its
// card names no address either.
const TITLE = `Not found · ${SITE}`;
export const metadata: Metadata = {
  title: TITLE,
  alternates: { canonical: null },
  openGraph: { title: TITLE, siteName: SITE, type: 'website', images: [CARD] },
  twitter: { card: 'summary_large_image', title: TITLE, images: [{ url: CARD.url, alt: CARD.alt }] },
};

export default function NotFound() {
  return (
    <main className="nf-screen">
      <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className="nf-world" />
      <Header overlay />
      <div className="nf-body">
        <div className="nf-vault" aria-hidden>
          <Image src="/art/vault.webp" alt="" fill priority sizes="300px" quality={85} />
        </div>
        <h1 className="nf-title">Nothing to break here</h1>
        <a href="/" className="nf-btn">
          To the race
        </a>
      </div>
    </main>
  );
}
