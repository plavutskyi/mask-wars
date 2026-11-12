import type { Metadata } from 'next';
import Image from 'next/image';
import { Header } from '@/components/arena/Header';
import { pageMeta } from '@/lib/meta';
import { GetNear } from './GetNear';
import s from './near.module.css';

export const metadata: Metadata = pageMeta({
  title: 'Get NEAR · MASK WARS',
  description: 'Any coin on any network to NEAR, straight to your account. Send from your own wallet or straight from an exchange.',
  path: '/near',
});

// Under the same script policy as /wallet (proxy.ts): a fresh nonce per request, which only a page rendered per request
// can carry; NEAR Connect's wallet frames take the same nonce.
export const dynamic = 'force-dynamic';

export default function NearPage() {
  return (
    <main className={s.screen}>
      <div className={s.world} aria-hidden>
        <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className={s.worldImg} />
      </div>
      <Header overlay here="near" />
      <GetNear />
    </main>
  );
}
