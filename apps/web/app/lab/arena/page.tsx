import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Lab } from './Lab';

// Development view of the arena engine: every state on a switch. Never in production, unless a preview build
// asks for it explicitly with MASKWARS_LAB=1.

export const metadata: Metadata = { title: 'Arena lab', robots: { index: false, follow: false } };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function Page({ searchParams }: { searchParams: Promise<Search> }) {
  if (process.env.NODE_ENV === 'production' && process.env.MASKWARS_LAB !== '1') notFound();
  const q = await searchParams;
  return <Lab state={one(q.state)} quality={one(q.q)} panel={one(q.panel) !== '0'} insets={one(q.insets) === '1'} cast={one(q.cast)} />;
}
