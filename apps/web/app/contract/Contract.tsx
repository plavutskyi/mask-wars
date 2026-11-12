import { accountUrl, txUrl } from '@maskwars/arena/config';
import { duration, near, raceNo } from '@maskwars/arena/format';
import { type Claim, type Dossier, type Evidence, type RaceLine, SLOT, type WrittenPage, renderClaim } from '@maskwars/dossier';
import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { Clock } from '@/components/arena/Clock';
import { Header } from '@/components/arena/Header';
import { Info, type InfoRow } from '@/components/arena/Info';
import { Nums } from '@/components/arena/Nums';
import { Refresh } from '@/components/arena/Refresh';
import { ArenaTarget, safeTargetOf } from '@/components/arena/Target';
import { World } from '@/components/arena/World';
import { artOf, day, eventLine, TEAMS, utc } from '@/lib/show';
import { modelName } from '@/lib/verified';
import { SECTION_TITLE, checkWord, displayName, kicker, numberLine, raceOutcome, standingLine, stats } from './show';
import s from './contract.module.css';

const ORACLE = (account: string) => `/api/contract/${account}`;

/**
 * The name. A long one narrows on the width axis first, then gives up size, so it never leaves its column (§4); an
 * account breaks only after its dots.
 */
function Title({ text }: { text: string }) {
  const parts = text.split('.');
  // Up to 18 characters the name stays on one line; a longer account breaks after its dots.
  const chars = text.length <= 18 ? text.length : Math.max(...parts.map((p, i) => p.length + (i < parts.length - 1 ? 1 : 0)));
  return (
    <h1 className={`${s.word} ${s.title}`} data-long={chars > 10 ? '' : undefined} style={{ '--chars': chars } as CSSProperties}>
      {parts.map((p, i) => (
        <span key={i}>
          <Nums text={p} />
          {i < parts.length - 1 ? (
            <>
              .<wbr />
            </>
          ) : null}
        </span>
      ))}
    </h1>
  );
}

/** Everything technical about the contract, one tap away. */
function facts(d: Dossier): InfoRow[] {
  const j = d.judge;
  return [
    { label: d.library && d.role === 'target' ? 'Training target' : d.role === 'target' ? 'Sandbox target' : 'Account', value: d.account, href: d.role === 'target' ? undefined : accountUrl(d.account) },
    ...(d.library ? [{ label: 'Library', value: d.library.title }, { label: 'Planted hole', value: d.library.hole }] : []),
    ...(d.code ? [{ label: 'Code hash', value: d.code }] : []),
    ...(d.check ? [{ label: 'MASK CHECK', value: `${checkWord(d.check) === 'target' ? 'ARENA TARGET, by design' : d.check.verdict.toUpperCase()} at block ${d.check.block.height}`, href: `/api/check?account=${d.account}` }] : []),
    ...(j
      ? [
          { label: "The judge's last word", value: `${j.verdict} · race ${raceNo(j.race)}`, href: j.tx ? txUrl(j.tx) : undefined },
          ...(j.judgeCode ? [{ label: 'Judge (OutLayer, TEE)', value: j.judgeCode }] : []),
        ]
      : []),
    { label: 'Facts on chain', value: `${d.evidence.length} · sha256 ${d.evidenceHash}`, href: ORACLE(d.account) },
    { label: 'Network', value: `NEAR ${d.network}` },
  ];
}

/** How the record was written: the model, the bytes it signed and the TEE that signed them. */
function attestation(w: WrittenPage): InfoRow[] {
  const a = w.attestation;
  return [
    { label: 'Model', value: `${modelName(w.model)} · NEAR AI Cloud, Confidential TEE` },
    { label: 'Written', value: utc(Date.parse(w.writtenAt)) },
    { label: 'From facts', value: `${w.evidence.length} · sha256 ${w.evidenceHash}` },
    { label: 'Request sha256', value: a.requestHash },
    { label: 'Response sha256', value: a.responseHash },
    ...(a.signature ? [{ label: 'Signed by the TEE', value: a.signature.signingAddress }] : []),
    { label: 'Signature', value: a.signatureVerified ? 'holds for these exact bytes' : 'not checked' },
    ...(a.tee ? [{ label: 'TEE attestation', value: `${a.tee.outcome} · ${a.tee.checkedAt}` }, { label: 'Nonce', value: a.tee.nonce }] : []),
    { label: 'Every byte, to check yourself', value: ORACLE(w.account), href: ORACLE(w.account) },
  ];
}

/** A whole NEAR account with dots in it: `vault.house.maskwars.near`. Never an amount: `1.93` has no letter after its dot. */
const ACCOUNT = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)*\.[a-z0-9_-]*[a-z][a-z0-9_-]*$/;
/** A NEAR account (safe-0001.maskwars.near) with the punctuation after it, or a name (SAFE-0001, race-0003). */
const NAME = /([a-z0-9](?:[a-z0-9_-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?)+[.,;:)]*|\b[A-Za-z]+-\d+\b)/;
/** A label this long (a 64-hex account, a code hash) may break anywhere: held whole it would leave a phone's column. */
const WHOLE = 24;
/** A code or transaction hash a sentence names: base58 of 32 to 64 characters, or 64 hex; never a label of an account. */
const HASH = /((?<![A-Za-z0-9_.-])(?:[1-9A-HJ-NP-Za-km-z]{32,64}|[0-9a-f]{64})(?![A-Za-z0-9_-]|\.[A-Za-z0-9]))/;
const isHash = (w: string) => new RegExp(`^${HASH.source}$`).test(w);

/** What a hash in a sentence is, from the facts the page was written from: the code's, a step's transaction, an implicit account. */
function hashRow(value: string, facts: readonly Evidence[]): InfoRow {
  if (facts.some((e) => e.data['code_hash'] === value)) return { label: 'Code hash', value };
  if (facts.some((e) => e.tx === value)) return { label: 'Transaction', value, href: txUrl(value) };
  if (/^[0-9a-f]{64}$/.test(value)) return { label: 'Account', value, href: accountUrl(value) };
  return { label: 'Hash', value };
}

/**
 * A hash is data, not words: the sentence keeps its first and last characters and the whole of it sits behind «i»,
 * so a 44-character run never breaks a line in two.
 */
function Hash({ row, after }: { row: InfoRow; after?: string }) {
  return (
    <span className={s.name}>
      <span className={s.hash} title={row.value}>{`${row.value.slice(0, 6)}…${row.value.slice(-4)}`}</span>
      {after}
      <span className={s.hashInfo}>
        <Info rows={[row]} label={row.label} align="end" />
      </span>
    </span>
  );
}

/** `vault.house.maskwars.near,` → its labels and the punctuation after it. */
function labelsOf(word: string): { labels: string[]; punct: string } {
  const m = /^(.*?)([.,;:)!?]*)$/.exec(word)!;
  return { labels: m[1]!.split('.'), punct: m[2]! };
}

/** Every label but the last, each held whole, a line break allowed only after its dot. */
function Leading({ labels }: { labels: string[] }) {
  return labels.slice(0, -1).map((l, j) => (
    <span key={j}>
      {l.length <= WHOLE ? <span className={s.name}>{l}</span> : l}.<wbr />
    </span>
  ));
}

/**
 * Words of a sentence. An account moves to the next line whole, and breaks after a dot only when it is longer than the
 * line; a name never breaks at its hyphen. On a phone `vault.house.maskwars.near` never reads `maskwars.nea` and `r`.
 */
function Words({ text, facts = [] }: { text: string; facts?: readonly Evidence[] }) {
  return text.split(new RegExp(HASH.source, 'g')).map((chunk, h) => (h % 2 ? <Hash key={`h${h}`} row={hashRow(chunk, facts)} /> : <Names key={`n${h}`} text={chunk} />));
}

function Names({ text }: { text: string }) {
  const parts = text.split(new RegExp(NAME.source, 'g'));
  return parts.map((p, i) => {
    if (i % 2 === 0) return p;
    if (!p.includes('.') || /^[A-Za-z]+-\d+$/.test(p)) {
      return (
        <span key={i} className={s.name}>
          {p}
        </span>
      );
    }
    const { labels, punct } = labelsOf(p);
    const last = labels.at(-1)!;
    return (
      <span key={i} className={s.account}>
        <Leading labels={labels} />
        {last.length <= WHOLE ? <span className={s.name}>{last}</span> : last}
        {punct}
      </span>
    );
  });
}

/** One sentence and the facts it rests on: each a link to its proof. */
function Sentence({ claim, byId }: { claim: Claim; byId: ReadonlyMap<string, Evidence> }) {
  // Every number in it is a slot the site fills from the fact it names; the number says, on hover, which fact it is.
  const all = [...byId.values()];
  const parts = claim.text.split(new RegExp(SLOT.source));
  const texts: string[] = [];
  const slots: { id: string; field: string }[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    texts.push(parts[i] ?? '');
    if (parts[i + 1] && parts[i + 2]) slots.push({ id: parts[i + 1]!, field: parts[i + 2]! });
  }
  // `{E9.amount_near} NEAR`: the number and its unit go in one unbreakable piece. A no-break space between two
  // elements is not enough: a browser may still end the line at the element's edge.
  const unit = slots.map((_, k) => /^ NEAR\b/.test(texts[k + 1] ?? ''));
  unit.forEach((u, k) => {
    if (u) texts[k + 1] = texts[k + 1]!.slice(' NEAR'.length);
  });

  const valueOf = (k: number) => {
    const { id, field } = slots[k]!;
    const e = byId.get(id);
    const value = renderClaim({ text: `{${id}.${field}}`, refs: [id] }, all);
    const title = e ? `${field.replace(/_near$/, '').replaceAll('_', ' ')} · fact ${id.slice(1)}` : undefined;
    // A number holds together. An account put in from a fact moves to the next line whole and breaks only after a
    // dot; a code hash is one long word and breaks where it must, never past its column.
    const labels = value.split('.');
    const shown = ACCOUNT.test(value) ? (
      <span className={s.value} data-account="" title={title}>
        <Leading labels={labels} />
        <span className={s.name}>{labels.at(-1)}</span>
      </span>
    ) : (
      <span className={s.value} data-code={value.length > 24 && !/\s/.test(value) ? '' : undefined} title={title}>
        {value}
      </span>
    );
    return (
      <span key={`v${k}`} className={unit[k] ? s.name : undefined}>
        {shown}
        {unit[k] ? '\u00a0NEAR' : null}
      </span>
    );
  };

  // The last word of the sentence and its facts stay together: a fact's number never wraps alone. A long last word (an
  // account, a hash) moves to the next line whole and breaks inside only when it is longer than the line; its last
  // label, or a hash's last characters, still hold on to the facts. A number right before the last word (`0.25 NEAR.`)
  // joins it.
  const lastText = texts.at(-1)!;
  const cut = lastText.search(/\S*$/);
  const word = lastText.slice(cut);
  const joined = cut === 0 && slots.length > 0;
  const out = [];
  for (let k = 0; k < texts.length; k++) {
    out.push(<Words key={`w${k}`} text={k === texts.length - 1 ? lastText.slice(0, cut) : texts[k]!} facts={all} />);
    if (k < slots.length && !(joined && k === slots.length - 1)) out.push(valueOf(k));
  }
  const { labels, punct } = labelsOf(word);
  const last = labels.at(-1)!;
  const held = last.length <= WHOLE ? '' : last.slice(0, -4);
  const refs = (
    <span className={s.refs}>
      {claim.refs.map((r) => {
        const e = byId.get(r);
        const n = r.slice(1);
        return e?.href ? (
          <a key={r} className={s.ref} href={e.href} target={e.href.startsWith('/') ? undefined : '_blank'} rel="noreferrer" title={e.fact} aria-label={`Fact ${n}: ${e.fact}`}>
            {n}
          </a>
        ) : (
          <span key={r} className={s.ref} title={e?.fact} aria-label={e ? `Fact ${n}: ${e.fact}` : undefined}>
            {n}
          </span>
        );
      })}
    </span>
  );
  // A hash as the last word: its short form, the stop, its «i» and the facts hold together on one line.
  if (labels.length === 1 && isHash(last)) {
    return (
      <>
        {out}
        <span className={s.tail}>
          {joined ? valueOf(slots.length - 1) : null}
          <Hash row={hashRow(last, all)} after={punct} />
          {refs}
        </span>
      </>
    );
  }
  return (
    <>
      {out}
      <span className={s.tail} data-long={word.length > 14 ? '' : undefined}>
        {joined ? valueOf(slots.length - 1) : null}
        <Leading labels={labels} />
        {held}
        <span className={s.name}>
          <Words text={`${last.slice(held.length)}${punct}`} />
          {refs}
        </span>
      </span>
    </>
  );
}

function Record({ d, written, writing, verifying }: { d: Dossier; written: WrittenPage | null; writing: boolean; verifying: boolean }) {
  const byId = new Map((written?.evidence ?? []).map((e) => [e.id, e]));
  return (
    <section className={s.record} aria-labelledby="record">
      <div className={s.head}>
        <h2 id="record" className={`${s.word} ${s.h2}`}>
          The record
        </h2>
        {written ? (
          <span className={s.by}>
            <i className={s.seal} aria-hidden />
            Written by AI in a TEE
            <Info rows={attestation(written)} label="How this record was written" align="end" />
          </span>
        ) : null}
      </div>
      {written ? (
        <>
          <p className={s.lede}>
            <Sentence claim={written.page.lede} byId={byId} />
          </p>
          <div className={s.parts}>
            {written.page.sections.map((sec) => (
              <div key={sec.id} className={s.part}>
                <h3 className={`${s.word} ${s.h3}`}>{SECTION_TITLE[sec.id]}</h3>
                {sec.claims.map((c, i) => (
                  <p key={i} className={s.claim}>
                    <Sentence claim={c} byId={byId} />
                  </p>
                ))}
              </div>
            ))}
          </div>
        </>
      ) : verifying ? (
        <p className={s.writing} role="status">
          <i className={s.dot} aria-hidden />
          <span>Checking the TEE signature of the record</span>
        </p>
      ) : writing ? (
        <p className={s.writing} role="status">
          <i className={s.dot} aria-hidden />
          {/* One line of words beside the dot: the number is part of it, not a column of its own. */}
          <span>
            <Nums text={`A model in a TEE is writing it from ${d.evidence.length} facts on chain`} />
          </span>
        </p>
      ) : null}
    </section>
  );
}

/** +0:15 from the start; −45:00 before it; 0:00 within a second of it; 2 d 11 h past a day. */
function offset(at: number, from: number | null): string {
  if (from === null) return '';
  const ms = at - from;
  if (Math.abs(ms) < 1_000) return '0:00';
  return `${ms < 0 ? '−' : '+'}${duration(Math.abs(ms))}`;
}

/**
 * The race's clock, as on its own page: a sealed round starts when its vault unlocks at the end of the commit window,
 * so «broke in 0:15» above and +0:15 on the break's row are the same clock.
 */
const zeroOf = (r: RaceLine) => r.startsAt ?? r.openedAt;

type Step = RaceLine['events'][number] | { kind: 'unlock'; at: number };

/**
 * The steps, with a sealed round's unlock in its place among them once it has happened: never one still ahead, nor
 * one after the bounty went back during the commit window.
 */
function stepsOf(r: RaceLine, now: number): Step[] {
  const unlock = r.startsAt;
  if (r.sealUntil === null || unlock === null || r.phase === 'sealing' || unlock > now || (r.refundAt !== null && unlock > r.refundAt)) return [...r.events];
  // A bounty back at a time not read: the unlock happened only if something did after it.
  if (r.state === 'refunded' && r.refundAt === null && !r.events.some((e) => e.at >= unlock)) return [...r.events];
  const at = r.events.findIndex((e) => e.at >= unlock);
  const i = at < 0 ? r.events.length : at;
  return [...r.events.slice(0, i), { kind: 'unlock', at: unlock }, ...r.events.slice(i)];
}

function RaceSteps({ race: r, now }: { race: RaceLine; now: number }) {
  return (
    <div className={s.race} data-phase={r.phase}>
      <Link href={`/race/${r.id}`} className={s.raceHead}>
        <span className={`${s.word} ${s.raceNo}`}>
          <Nums text={`Race ${raceNo(r.id)}${r.openedAt ? ` · ${day(r.openedAt)}` : ''}`} />
        </span>
        <span className={s.raceOut}>
          <Nums text={raceOutcome(r)} />
        </span>
        <span className={s.go} aria-hidden>
          ›
        </span>
      </Link>
      <ol className={s.steps}>
        {stepsOf(r, now).map((e, i) =>
          e.kind === 'unlock' ? (
            <li key={`unlock-${i}`} className={s.step} data-kind="unlock">
              <span className={s.when}>{offset(e.at, zeroOf(r))}</span>
              <span className={s.what}>The vault unlocks</span>
              <span className={s.amount} />
              <span className={s.stepInfo}>
                <Info align="end" label="This step on chain" rows={[{ label: 'Time', value: utc(e.at) }, { label: 'What', value: 'The commit window closes' }]} />
              </span>
            </li>
          ) : (
            <li key={`${e.tx}-${e.kind}-${i}`} className={s.step} data-kind={e.kind} data-quiet={e.kind === 'claim' && e.verdict !== 'paid' ? '' : undefined}>
              <span className={s.when}>{offset(e.at, zeroOf(r))}</span>
              <span className={s.what}>
                {e.kind === 'open' && r.sealUntil !== null ? 'The round opens' : eventLine(e, r.team)}
                {e.kind === 'drain' ? <span className={`${s.word} ${s.tag}`}>The break</span> : null}
              </span>
              <span className={s.amount} data-tone={e.kind === 'drain' || e.kind === 'paid' ? 'money' : 'plain'}>
                {e.amount ? `${near(e.amount)} NEAR` : ''}
              </span>
              <span className={s.stepInfo}>
                <Info
                  align="end"
                  label="This step on chain"
                  rows={[
                    { label: 'Time', value: utc(e.at) },
                    ...(e.who ? [{ label: 'Who', value: e.who.account, href: accountUrl(e.who.account) }] : []),
                    ...(e.method ? [{ label: 'Call', value: e.method }] : []),
                    ...(e.tx ? [{ label: 'Transaction', value: e.tx, href: txUrl(e.tx) }] : []),
                  ]}
                />
              </span>
            </li>
          ),
        )}
      </ol>
    </div>
  );
}

function action(d: Dossier): { href: string; label: string } {
  const newest = d.races[0];
  if (d.headline.standing === 'unknown') return { href: '/', label: 'To the race' };
  if (!newest) return { href: '/break', label: 'Put it in the arena' };
  if (d.headline.standing === 'under_fire') return { href: `/race/${newest.id}`, label: 'Watch it live' };
  return { href: `/race/${newest.id}`, label: `Race ${raceNo(newest.id)}` };
}

export function Contract({ dossier: d, written, writing, verifying = false }: { dossier: Dossier; written: WrittenPage | null; writing: boolean; verifying?: boolean }) {
  const h = d.headline;
  const line = standingLine(d);
  const by = h.standing === 'broken' ? (h.broken?.by ?? null) : null;
  const art = by?.mask ? artOf(by) : null;
  const go = action(d);
  const numbers = stats(d);
  const info = h.standing === 'unknown' ? null : <Info rows={facts(d)} label="This contract on chain" align="start" />;
  // One of the arena's own safes, said plainly under its number: who funds it, who breaks it, the rest behind «i».
  const target = d.role === 'safe' && h.standing !== 'unknown' ? safeTargetOf(d.account, d.code, d.races[0], TEAMS) : null;
  // A stored record waits only for this server's attestation, seconds away: it is asked for again soon.
  const refresh = h.live || verifying ? 5_000 : writing ? 20_000 : h.standing === 'under_fire' ? 30_000 : null;

  return (
    <main className={s.page} data-standing={h.standing}>
      <World />
      {refresh ? <Refresh everyMs={refresh} /> : null}
      <Header live={h.live} network={d.network} />

      <section className={s.hero} data-art={art ? '' : undefined}>
        <div className={s.heroText}>
          {kicker(d) ? (
            <p className={`${s.word} ${s.kicker}`}>
              <Nums text={kicker(d)} />
            </p>
          ) : null}
          <Title text={displayName(d)} />
          <div className={s.standRow}>
            <p className={`${s.word} ${s.standing}`} data-tone={line.tone}>
              {h.live ? <i className={s.dot} aria-hidden /> : null}
              <Nums text={line.text} />
            </p>
            {h.amount ? null : info}
          </div>
          {h.amount ? (
            <div className={s.big}>
              <span className={s.num} data-tone={h.amountIs === 'taken' ? 'money' : 'plain'}>
                {near(h.amount)}
                <span className={`${s.word} ${s.unit}`}>NEAR</span>
              </span>
              {info}
            </div>
          ) : null}
          <p className={s.sub}>
            {h.standing === 'under_fire' && h.closesAt ? (
              <>
                on the line now · closes in <Clock to={h.closesAt} className={s.clock} />
              </>
            ) : (
              <Nums text={numberLine(d)} />
            )}
          </p>
          {target ? <ArenaTarget target={target} className={s.target} align="start" /> : null}
          {numbers.length ? (
            <dl className={s.stats} data-n={numbers.length}>
              {numbers.map((x) => (
                <div key={x.label}>
                  <dt className={s.word}>{x.label}</dt>
                  <dd data-tone={x.tone}>{x.label === 'Mask check' ? <span className={s.word}>{x.value}</span> : x.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <Link href={go.href} className={`${s.btn} ${s.word}`}>
            <span>
              <Nums text={go.label} />
            </span>
          </Link>
        </div>
        <div className={s.heroArt} aria-hidden>
          {art ? (
            <Image src={art} alt="" fill priority fetchPriority="high" sizes="(max-width: 900px) 70vw, 44vw" quality={85} className={s.heroMask} />
          ) : (
            <Image src="/art/vault.webp" alt="" fill priority fetchPriority="high" sizes="(max-width: 900px) 70vw, 40vw" quality={85} className={s.heroVault} />
          )}
        </div>
      </section>

      {written || writing || verifying ? <Record d={d} written={written} writing={writing} verifying={verifying} /> : null}

      {d.races.length ? (
        <section className={s.chain} aria-labelledby="chain">
          <h2 id="chain" className={`${s.word} ${s.h2}`}>
            On chain
          </h2>
          {d.races.map((r) => (
            <RaceSteps key={r.id} race={r} now={d.readAt} />
          ))}
        </section>
      ) : null}
    </main>
  );
}
