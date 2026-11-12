import type { Metadata } from 'next';
import Image from 'next/image';
import { Header } from '@/components/arena/Header';
import { pageMeta } from '@/lib/meta';
import { Swap } from './Swap';
import s from '../near/near.module.css';

export const metadata: Metadata = pageMeta({
  title: 'Swap · MASK WARS',
  description: 'Any coin on any network into any coin on another, in one go. From your own wallet or straight from an exchange.',
  path: '/swap',
});

// Under the same script policy as /near and /wallet (proxy.ts): a fresh nonce per request, which only a page rendered
// per request can carry; NEAR Connect's wallet frames take the same nonce.
export const dynamic = 'force-dynamic';

export default function SwapPage() {
  return (
    <main className={s.screen}>
      <div className={s.world} aria-hidden>
        <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className={s.worldImg} />
      </div>
      <Header overlay here="near" />
      <Swap />
    </main>
  );
}
