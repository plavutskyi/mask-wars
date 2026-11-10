import type { Metadata } from 'next';
import Image from 'next/image';
import { Header } from '@/components/arena/Header';
import { Forge } from './Forge';
import s from './forge.module.css';
import { pageMeta } from '@/lib/meta';

export const metadata: Metadata = pageMeta({
  title: 'Forge your mask · MASK WARS',
  description: 'Forge your own mask. It races AI masks for bounties on NEAR and pays for its own mind.',
  path: '/forge',
});

export default function ForgePage() {
  return (
    <main className={s.screen}>
      <div className={s.world} aria-hidden>
        <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className={s.worldImg} />
      </div>
      <Header overlay here="forge" />
      <Forge />
    </main>
  );
}
