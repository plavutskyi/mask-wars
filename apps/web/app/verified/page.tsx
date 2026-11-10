import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { Fragment, Suspense } from 'react';
import { Header } from '@/components/arena/Header';
import {
  ago,
  gpuCard,
  gpuCount,
  MODELS,
  modelName,
  overall,
  reason,
  rows,
  short,
  utcTime,
  verifiedAll,
  type ModelVerification,
  type RowOutcome,
} from '@/lib/verified';
import s from './verified.module.css';
import { pageMeta } from '@/lib/meta';

// Under the hood, not in the menu: the proof behind "private inference" for anyone who taps the quiet "i".
export const metadata: Metadata = pageMeta({
  title: 'Private minds · MASK WARS',
  description: 'Every mask thinks inside a sealed NVIDIA GPU on NEAR AI Cloud, checked live with a fresh nonce.',
  path: '/verified',
});

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export default function VerifiedPage() {
  return (
    <main className={s.screen}>
      <div className={s.world} aria-hidden>
        <Image src="/art/arena.webp" alt="" fill priority sizes="100vw" quality={75} className={s.worldImg} />
      </div>
      <Header />
      <Suspense fallback={<Board />}>
        <Live />
      </Suspense>
    </main>
  );
}

async function Live() {
  const results = await verifiedAll();
  return <Board results={results} now={Date.now()} />;
}

const STATE: Record<RowOutcome, string> = {
  pass: 'Verified',
  fail: 'Not verified',
  unavailable: 'Unavailable',
  pending: 'Checking',
};

/**
 * Nothing could be checked: every model is unavailable for the same kind of reason (NEAR AI did not answer). The page
 * says it once, under the title, instead of on every card and every row.
 */
function silence(results: readonly ModelVerification[] | undefined): string | null {
  if (!results?.length || !results.every((v) => v.outcome === 'unavailable')) return null;
  const texts = [...new Set(results.map((v) => reason(v)?.text ?? 'Not checked this time'))];
  return texts.length === 1 ? texts[0]! : 'Not checked this time';
}

function Board({ results, now = Date.now() }: { results?: readonly ModelVerification[]; now?: number }) {
  const gpus = results?.reduce((sum, v) => sum + gpuCount(v), 0) ?? 0;
  const newest = results?.map((v) => v.checkedAt).sort().at(-1);
  const silent = silence(results);
  return (
    <div className={s.body} aria-busy={!results}>
      <section className={s.hero}>
        <State outcome={overall(results)} />
        <h1 className={`${s.word} ${s.title}`}>Private minds</h1>
        <p className={s.lede}>
          Every mask thinks inside a sealed NVIDIA GPU on NEAR AI Cloud. Not even NEAR can look inside.
        </p>
        <p className={s.facts}>
          {silent && newest ? (
            <>
              <span>{silent}</span>
              <span>{utcTime(newest)}</span>
              <a href="/verified" className={s.again}>
                Check again
              </a>
            </>
          ) : results && newest ? (
            <>
              <span>{results.length} models</span>
              {gpus > 0 && <span>{gpus} GPUs</span>}
              <span>
                Checked {ago(newest, now)} · {utcTime(newest)}
              </span>
            </>
          ) : (
            <span>Checking now with a fresh nonce…</span>
          )}
        </p>
      </section>

      <section className={s.models} aria-label="Models">
        {MODELS.map((id) => (
          <Model key={id} id={id} v={results?.find((r) => r.model === id)} now={now} quiet={silent !== null} />
        ))}
      </section>

      {silent ? null : (
        <section className={s.checks} aria-labelledby="checked">
          <h2 id="checked" className={`${s.word} ${s.label}`}>
            What was checked
          </h2>
          <ul className={s.rows}>
            {rows(results).map((r) => (
              <li key={r.key} className={s.row} data-outcome={r.outcome}>
                <Icon outcome={r.outcome} />
                <span className={s.rowText}>
                  <span className={`${s.word} ${s.rowLabel}`}>{r.label}</span>
                  <span className={s.rowLine}>
                    <Phrases text={r.text} />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className={s.foot}>
        <Link href="/" className={s.btn}>
          <span className={s.word}>To the race</span>
        </Link>
        <details className={s.limits}>
          <summary className={s.summary}>
            <span className={s.word}>What this does not prove</span>
            <Chevron />
          </summary>
          <ul className={s.limitList}>
            <li>Which instance answered a given move: instances of one model share a signing key.</li>
            <li>Who built the measured containers. The check pins them; their provenance is a separate check.</li>
            <li>Our race engine. It runs outside the enclave; only the model&apos;s thinking runs inside.</li>
          </ul>
          <p className={s.limitNote}>Checks follow NEAR AI&apos;s verification guide. Check it yourself:</p>
          <ul className={s.sources}>
            <li>
              <a href="https://docs.near.ai/cloud/verification" target="_blank" rel="noreferrer">
                The guide
              </a>
            </li>
            <li>
              <a href="https://cloud.near.ai/verify" target="_blank" rel="noreferrer">
                cloud.near.ai/verify
              </a>
            </li>
            <li>
              <a href="/api/verified" target="_blank" rel="noreferrer">
                Raw results
              </a>
            </li>
          </ul>
        </details>
      </footer>
    </div>
  );
}

/** One model's card. `quiet`: the page already said why nothing was checked, so the card keeps to its name. */
function Model({ id, v, now, quiet = false }: { id: string; v: ModelVerification | undefined; now: number; quiet?: boolean }) {
  const outcome: RowOutcome = v?.outcome ?? 'pending';
  const why = v ? reason(v) : null;
  const node = v?.nodes[0];
  const card = gpuCard(v);
  return (
    <article className={s.card} data-outcome={outcome} data-quiet={quiet ? '' : undefined} aria-label={modelName(id)}>
      {quiet ? null : <State outcome={outcome} small />}
      <h3 className={s.name}>{modelName(id)}</h3>
      {quiet ? null : (
        <p className={s.meta}>
          {v
            ? [gpuCount(v) ? `${gpuCount(v)} × ${card ?? 'GPU'}` : null, v.nodes.length ? 'Intel TDX' : null, utcTime(v.checkedAt)].filter(Boolean).join(' · ')
            : 'Waiting for evidence'}
        </p>
      )}
      {quiet ? null : why ? (
        <p className={s.why} data-outcome={outcome}>
          {why.text}
        </p>
      ) : (
        <p className={s.nonce}>
          Nonce <span className={s.hex}>{v ? short(v.nonce, 8, 8) : '…'}</span>
        </p>
      )}
      {v && (
        <details className={s.more}>
          <summary className={s.summary}>
            <span className={s.word}>Details</span>
            <Chevron />
          </summary>
          <dl className={s.dl}>
            <dt>Model</dt>
            <dd className={s.hex}>{id}</dd>
            <dt>Nonce</dt>
            <dd className={s.hex}>{v.nonce}</dd>
            {v.nodes.map((n, i) => (
              <Pair key={n.signer || i} term={v.nodes.length > 1 ? `Model key ${i + 1}` : 'Model key'} value={n.signer} />
            ))}
            {v.gateway && <Pair term="Gateway key" value={v.gateway.signer} />}
            <dt>Intel TCB</dt>
            <dd>{tcbLine(node?.tcb, v.gateway?.tcb)}</dd>
            {node?.mrtd && (
              <>
                <dt>MRTD</dt>
                <dd className={s.hex} title={node.mrtd}>
                  {short(node.mrtd, 16, 8)}
                </dd>
              </>
            )}
            {node?.gpus?.driver && (
              <>
                <dt>GPU driver</dt>
                <dd>{node.gpus.driver}</dd>
              </>
            )}
            <dt>Checked</dt>
            <dd>
              {ago(v.checkedAt, now)} · took {(v.ms / 1000).toFixed(1)} s
            </dd>
            {why && (
              <>
                <dt>Reason</dt>
                <dd className={s.hex}>{why.detail}</dd>
              </>
            )}
          </dl>
        </details>
      )}
    </article>
  );
}

/** UpToDate when model and gateway agree, otherwise both named. */
function tcbLine(model: string | null | undefined, gateway: string | null | undefined): string {
  if (model && model === gateway) return `${model}, model and gateway`;
  return [model && `${model} model`, gateway && `${gateway} gateway`].filter(Boolean).join(' · ') || '–';
}

/** Keeps each short phrase and its dot on one line, so a row never breaks inside "secure boot" or before a dot. */
function Phrases({ text }: { text: string }) {
  const parts = text.split(' · ');
  return parts.map((part, i) => (
    <Fragment key={i}>
      {i > 0 && ' '}
      <span className={part.length <= 32 ? s.phrase : undefined}>{i < parts.length - 1 ? `${part} ·` : part}</span>
    </Fragment>
  ));
}

function Pair({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd className={s.hex}>{value || '–'}</dd>
    </>
  );
}

function State({ outcome, small = false }: { outcome: RowOutcome; small?: boolean }) {
  return (
    <p className={`${s.word} ${s.state} ${small ? s.stateSmall : ''}`} data-outcome={outcome}>
      <span className={s.dot} aria-hidden />
      {STATE[outcome]}
    </p>
  );
}

function Icon({ outcome }: { outcome: RowOutcome }) {
  return (
    <svg className={s.icon} viewBox="0 0 20 20" aria-hidden focusable="false">
      {outcome === 'pass' && <path d="M4.5 10.5l3.5 3.5 7.5-8" />}
      {outcome === 'fail' && <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />}
      {outcome === 'unavailable' && <path d="M5 10h10" />}
      {outcome === 'pending' && <circle cx="10" cy="10" r="2" />}
    </svg>
  );
}

function Chevron() {
  return (
    <svg className={s.chev} viewBox="0 0 20 20" aria-hidden focusable="false">
      <path d="M6 8l4 4 4-4" />
    </svg>
  );
}
