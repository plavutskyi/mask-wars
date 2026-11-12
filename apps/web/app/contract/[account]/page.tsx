import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { pageFor, readDossier, subjectOf } from '@/lib/dossier';
import { pageMeta } from '@/lib/meta';
import { Contract } from '../Contract';
import { describe, displayName } from '../show';

// One contract's page in the security encyclopedia: where it stands on the arena, the record a model wrote in a TEE
// from the chain, and every step on chain. Read fresh; the record is written in the background when the facts change.
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

type Props = { params: Promise<{ account: string }> };

/** Who asks, as Vercel reports it: MASK CHECK reads are limited per caller. */
async function caller(): Promise<string> {
  const h = await headers();
  return h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const subject = subjectOf((await params).account);
  if (!subject.ok) return { title: 'MASK WARS', robots: { index: false } };
  const d = await readDossier(subject.account, await caller());
  const title = `${displayName(d).toUpperCase()} · MASK WARS`;
  if (d.headline.standing === 'unknown' || d.role === 'missing') return { title, robots: { index: false } };
  return pageMeta({ title, description: describe(d), path: `/contract/${d.account}` });
}

export default async function ContractRoute({ params }: Props) {
  const started = Date.now();
  const subject = subjectOf((await params).account);
  if (!subject.ok) notFound();
  const d = await readDossier(subject.account, await caller());
  if (d.role === 'missing') notFound();
  const state = d.headline.standing === 'unknown' ? { page: null, writing: false, verifying: false } : await pageFor(d, started);
  return <Contract dossier={d} written={state.page} writing={state.writing} verifying={state.verifying} />;
}
