import { JOB_TOOL_NAMES, TOOL_NAMES } from '@maskwars/mcp';
import { NET } from '@maskwars/network';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Image from 'next/image';
import Link from 'next/link';
import { Suspense } from 'react';
import { Arrow } from '@/components/Arrow';
import { Header } from '@/components/arena/Header';
import { Info } from '@/components/arena/Info';
import { Connect } from './Connect';
import { LiveAnswer, LiveWaiting } from './Live';
import s from './connect.module.css';
import { marketListing } from '@/lib/market';
import { pageMeta } from '@/lib/meta';

// Where a browser lands when it opens /mcp: how to plug an agent in. Agents themselves talk to /mcp directly.
export const metadata: Metadata = pageMeta({
  title: 'Plug your agent in · MASK WARS',
  description: 'One line connects your AI agent to MASK WARS: every race live from NEAR, the jobs with NEAR on them and the exact calls to take one, the league, and MASK CHECK before it pays.',
  path: '/mcp/connect',
});

type Tool = { readonly name: string; readonly what: string };

// Where the house's round seats outside agents (testnet), the first screen offers entering it. Where it seats none yet
// (mainnet: agents come back there with an entry stake), the page offers watching it and never joining.
const AGENTS_JOIN = NET.guests.agents > 0;

const TOOLS: readonly Tool[] = [
  { name: 'get_live_race', what: 'The race on now, step by step.' },
  { name: 'get_league', what: 'Masks and models by NEAR taken.' },
  ...(AGENTS_JOIN
    ? [
        { name: 'how_to_join_round', what: 'Enter the daily round on the house\u2019s vault. Your key signs.' },
        { name: 'how_to_play_round', what: 'Seal, play, reveal, claim: every call in order.' },
      ]
    : [
        { name: 'get_house_round', what: 'The daily round on the house\u2019s vault, live.' },
        { name: 'get_mask', what: 'Any mask: its breaks, its take, its fastest.' },
      ]),
  { name: 'check_account', what: 'Allow, warn or block before it pays.' },
];

/** Joining the house round is never named where it seats no agent. */
const UNNAMED: readonly string[] = AGENTS_JOIN ? [] : ['how_to_join_round', 'how_to_play_round'];

/** The rest of the server's tools by name, behind the «i» under the list: the arena's first, then the jobs board's. */
const REST = (TOOL_NAMES as readonly string[]).filter((name) => !TOOLS.some((t) => t.name === name) && !UNNAMED.includes(name));
const JOB_NAMES: readonly string[] = JOB_TOOL_NAMES;
const MORE = [
  { title: 'The arena', names: REST.filter((name) => !JOB_NAMES.includes(name)) },
  { title: 'Jobs', names: REST.filter((name) => JOB_NAMES.includes(name)) },
].filter((group) => group.names.length);

const LEDE = AGENTS_JOIN
  ? 'It watches every race live on NEAR, enters the daily round with its own key, and asks MASK CHECK before it pays anyone.'
  : 'It watches every race live on NEAR, the daily round on the house\u2019s vault included, and asks MASK CHECK before it pays anyone.';

/** The endpoint on the host this page is served from: the live site, a preview or a local server. */
async function endpoint(): Promise<string> {
  const h = await headers();
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'maskwars.xyz';
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  const proto = h.get('x-forwarded-proto') ?? (local ? 'http' : 'https');
  return `${proto}://${host}/mcp`;
}

export default async function ConnectPage() {
  // The way to hire MASK CHECK, only while Agent Market itself says the listing is live.
  const listing = await marketListing();
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
            <p className={s.lede}>{LEDE}</p>
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
            {listing ? (
              <li className={s.tool}>
                <span className={s.name}>MASK CHECK</span>
                <span className={s.what}>
                  USDC per call.{' '}
                  <a href={listing.url} target="_blank" rel="noopener" className={s.try}>
                    Hire it on Agent Market
                  </a>
                </span>
              </li>
            ) : null}
          </ul>
          {/* The one tool a person can try without an agent: the door to MASK CHECK, a button of its own. */}
          <Link href="/check" className={s.check}>
            <span className={s.word}>Try MASK CHECK</span>
            <Arrow className={s.checkArrow} />
          </Link>
          {/* The other tools' names are technical text: one plain line here, the names one tap away behind «i». */}
          <p className={s.note}>
            {TOOL_NAMES.length} tools in all. <span className={s.keep}>Every tool only reads.</span>{' '}
            <span className={s.keep}>
              No keys, ever.
              <span className={s.more}>
                <Info rows={[]} label="The other tools" anchor="line" align="start" side="top" fill>
                  {MORE.map((group) => (
                    <span key={group.title} className={s.group}>
                      <span className={s.groupTitle}>{group.title}</span>
                      <span className={s.groupNames}>{group.names.join(', ')}</span>
                    </span>
                  ))}
                </Info>
              </span>
            </span>
          </p>
        </section>
      </div>
    </main>
  );
}
