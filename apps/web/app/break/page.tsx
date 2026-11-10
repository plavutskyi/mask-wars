import type { Metadata } from 'next';
import Image from 'next/image';
import { BreakForm } from '@/components/BreakForm';
import { Header } from '@/components/arena/Header';
import s from '@/components/break.module.css';
import { pageMeta } from '@/lib/meta';

export const metadata: Metadata = pageMeta({
  title: 'Break my contract · MASK WARS',
  description: 'Put up a bounty. Masks race to drain your vault before you ship.',
  path: '/break',
});

export default function BreakPage() {
  return (
    <main className={s.screen}>
      <div className={s.world} aria-hidden>
        <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className={s.worldImg} />
      </div>
      <Header overlay here="break" />
      <BreakForm />
    </main>
  );
}
