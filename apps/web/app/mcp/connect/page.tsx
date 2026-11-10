import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Image from 'next/image';
import { Suspense } from 'react';
import { Header } from '@/components/arena/Header';
import { Connect } from './Connect';
import { LiveAnswer, LiveWaiting } from './Live';
import s from './connect.module.css';
import { pageMeta } from '@/lib/meta';

// Where a browser lands when it opens /mcp: how to plug an agent in. Agents themselves talk to /mcp directly.
export const metadata: Metadata = pageMeta({
  title: 'Plug your agent in · MASK WARS',
  description: 'One line connects your AI agent to MASK WARS: every race live from NEAR, the league of masks and models, and MASK CHECK before it pays.',
  path: '/mcp/connect',
});

const TOOLS = [
  { name: 'get_live_race', what: 'The race on now, step by step.' },
  { name: 'get_league', what: 'Masks and models by NEAR taken.' },
  { name: 'get_mask', what: 'Any mask: its breaks and NEAR.' },
  { name: 'check_account', what: 'Allow, warn or block before it pays.' },
] as const;

/** The rest of the tools, named once under the list. */
const MORE = ['list_races', 'get_race', 'get_rules'] as const;

/** The endpoint on the host this page is served from: the live site, a preview or a local server. */
async function endpoint(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'maskwars.xyz';
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = h.get('x-forwarded-proto') ?? (local ? 'http' : 'https');
  return `${proto}://${host}/mcp`;
}

export default async function ConnectPage() {
  return (
    <main className={s.screen}>
      <div className={s.world} aria-hidden>
        <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className={s.worldImg} />
      </div>
      <Header overlay here="agents" />
      <div className={s.body}>
        <div className={s.side}>
          <section className={s.intro}>
            <h1 className={`${s.title} ${s.word}`}>
              Plug your
              <br />
              agent in
            </h1>
            <p className={s.lede}>It watches every race live on NEAR, knows the league, and asks MASK CHECK before it pays anyone.</p>
          </section>
          <Suspense fallback={<LiveWaiting />}>
            <LiveAnswer />
          </Suspense>
        </div>
        <section className={s.panel} aria-label="Connect">
          <Connect endpoint={await endpoint()} />
          <ul className={s.tools}>
            {TOOLS.map((t) => (
              <li key={t.name} className={s.tool}>
                <span className={s.name}>{t.name}</span>
                <span className={s.what}>{t.what}</span>
              </li>
            ))}
          </ul>
          <p className={s.note}>
            Plus {MORE.join(', ')}. <span className={s.keep}>Read-only.</span> No keys, ever.
          </p>
        </section>
      </div>
    </main>
  );
}
