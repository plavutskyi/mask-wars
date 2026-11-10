'use client';

import Image from 'next/image';
import { useEffect } from 'react';
import { Header } from '@/components/arena/Header';

// Something on this page failed while it was drawn. Say so in one line, offer the page again and the way back.
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="nf-screen">
      <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className="nf-world" />
      <Header overlay />
      <div className="nf-body">
        <div className="nf-vault" aria-hidden>
          <Image src="/art/vault.webp" alt="" fill priority sizes="300px" quality={85} />
        </div>
        <h1 className="nf-title">This page tripped</h1>
        <div className="nf-acts">
          <button type="button" className="nf-btn" onClick={reset}>
            Try again
          </button>
          <a href="/" className="nf-quiet">
            To the race
          </a>
        </div>
      </div>
    </main>
  );
}
