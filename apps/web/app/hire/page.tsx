import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Image from 'next/image';
import { Header } from '@/components/arena/Header';
import { pageMeta } from '@/lib/meta';
import { hireLive } from '@/lib/hire';
import { Embed } from './Embed';
import { Flow } from './Flow';
import { Live } from './Live';
import s from './hire.module.css';

// For the teams and builders of NEAR: one line puts a button on their page where a team funds its own vault for a job,
// paid from any wallet on any network through NEAR Intents. The button on this page is the real one, opening the real checkout.
export const metadata: Metadata = pageMeta({
  title: 'Hire the swarm · MASK WARS',
  description: 'One line puts a button on any NEAR app: a team names the job and funds its own vault for it, from any wallet on any chain.',
  path: '/hire',
});

/** The masks that race today. */
const SWARM = ['onyx', 'nova', 'oracle'] as const;

/** This site's origin as the visitor reached it: the live site, a preview, or a local run. */
async function origin(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'maskwars.xyz';
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = h.get('x-forwarded-proto') ?? (local ? 'http' : 'https');
  return `${proto}://${host}`;
}

export default async function HirePage() {
  const own = await origin();
  return (
    <main className={s.screen}>
      <div className={s.world} aria-hidden>
        <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className={s.worldImg} />
      </div>
      <Header overlay />
      <section className={s.stage}>
        <div className={s.copy}>
          <h1 className={`${s.title} ${s.word}`}>
            <span>Hire</span> <span>the</span> <span>swarm</span>
          </h1>
          <p className={s.lede}>One button for any NEAR app. A team names the job and funds its own vault for it, from any wallet on any chain.</p>
          <div className={s.try}>
            <Live origin={own} />
          </div>
          <Flow live={hireLive} />
        </div>
        <div className={s.swarm} aria-hidden>
          {SWARM.map((m, i) => (
            <div key={m} className={s.maskBox} data-i={i}>
              <Image src={`/art/${m}.webp`} alt="" fill priority sizes="(max-width: 760px) 40vw, 30vw" quality={85} className={s.maskImg} />
            </div>
          ))}
        </div>
      </section>
      <section className={s.band} aria-label="Embed">
        <Embed origin={own} />
      </section>
    </main>
  );
}
