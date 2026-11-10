import type { Metadata } from 'next';
import Image from 'next/image';
import { Header } from '@/components/arena/Header';
import { Forge } from './Forge';
import s from './forge.module.css';
import { pageMeta } from '@/lib/meta';
import { SITE, siteOrigin } from '@/lib/site';

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
      {/* A mask is forged on this site's network. Beside a sibling on the other one the header says which, and the
          switch leads back; a site on its own keeps its header plain. */}
      <Header overlay here="forge" network={SITE.sibling ? SITE.network : undefined} />
      {/* A forged mask is shared by its address on this site: the network it was forged on. */}
      <Forge origin={siteOrigin()} />
    </main>
  );
}
