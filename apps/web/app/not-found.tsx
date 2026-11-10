import Image from 'next/image';
import { Header } from '@/components/arena/Header';

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
