import type { Metadata } from 'next';
import { accountOk, amountOf, cleanAccount, jobText, teamOk } from '@maskwars/hire';
import { chainOf } from '@maskwars/pay';
import { Checkout, type Given } from './Checkout';

// The checkout a <mask-wars-hire> button opens over its host page, in a frame. The host page's attributes arrive as
// the query; each one is read here and only what reads right is used, the rest the team types in the checkout. The
// policy for this page (framed by any https page, talking only to this site) is in proxy.ts.
export const metadata: Metadata = {
  title: 'Hire the swarm · MASK WARS',
  robots: { index: false, follow: false },
};

// Its scripts carry a nonce made per request.
export const dynamic = 'force-dynamic';

const one = (v: string | string[] | undefined): string | null => (typeof v === 'string' && v.length <= 400 ? v : null);

export default async function HireEmbed({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const target = one(q.target) ? cleanAccount(one(q.target)!) : null;
  const team = one(q.team) ? cleanAccount(one(q.team)!) : null;
  const chain = one(q.chain)?.toLowerCase() ?? null;
  const given: Given = {
    text: one(q.job) ? jobText(one(q.job)!) : null,
    target: target && accountOk(target) ? target : null,
    team: team && teamOk(team) ? team : null,
    amount: amountOf({ usd: one(q.usd), near: one(q.near) }),
    chain: chain && chainOf(chain) ? chain : null,
  };
  return <Checkout given={given} host={one(q.host)} />;
}
