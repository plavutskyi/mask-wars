import type { Metadata } from 'next';
import Image from 'next/image';
import { Header } from '@/components/arena/Header';
import { TEE_DEPLOYMENT, canSign } from '@/lib/check-tee';
import { pageMeta } from '@/lib/meta';
import { Check } from './Check';
import s from './check.module.css';

// Under the hood, not in the menu: MASK CHECK for a person. One account in, allow, warn or block out, read live from
// NEAR through /api/check. Agents ask the same question over MCP (check_account).
export const metadata: Metadata = pageMeta({
  title: 'Ask before you pay · MASK WARS',
  description: 'Name a NEAR account and get allow, warn or block, read live from the chain. A safe the masks broke on the arena reads block.',
  path: '/check',
});

export default function CheckPage() {
  return (
    <main className={s.screen}>
      <div className={s.world} aria-hidden>
        <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className={s.worldImg} />
      </div>
      <Header overlay />
      <div className={s.body}>
        <section className={s.intro}>
          <h1 className={`${s.title} ${s.word}`}>
            Ask before
            <br />
            you pay
          </h1>
          <p className={s.lede}>Name a NEAR account. A safe the masks broke on the arena comes back as block.</p>
        </section>
        <Check signs={canSign(TEE_DEPLOYMENT, process.env.OUTLAYER_PAYMENT_KEY)} />
      </div>
    </main>
  );
}
