import type { Metadata } from 'next';
import Image from 'next/image';
import { Header } from '@/components/arena/Header';
import { Wallet } from './Wallet';
import s from './wallet.module.css';
import { pageMeta } from '@/lib/meta';

export const metadata: Metadata = pageMeta({
  title: 'Your vault · MASK WARS',
  description: 'Money for the arena. Add it from any wallet, cash it out to yours.',
  path: '/wallet',
});

// The passkey's domain is fixed for good (PASSKEY_RP_ID): a vault made on maskwars.xyz opens only there.
export const dynamic = 'force-dynamic';

export default function WalletPage() {
  const rpId = process.env.PASSKEY_RP_ID || 'maskwars.xyz';
  return (
    <main className={s.screen}>
      <div className={s.world} aria-hidden>
        <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className={s.worldImg} />
      </div>
      <Header overlay here="vault" />
      <Wallet rpId={rpId} />
    </main>
  );
}
