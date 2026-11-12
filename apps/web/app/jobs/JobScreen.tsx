import { type Entrant, type Job, type JobBoard, type JobEvent, LIVE, type Member, isFresh } from '@maskwars/arena/jobs';
import { accountUrl, deliveryUrl, txUrl } from '@maskwars/arena/jobs/config';
import { duration, near } from '@maskwars/arena/format';
import Image from 'next/image';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { Arrow } from '@/components/Arrow';
import { Mark } from '@/components/Mark';
import { Header } from '@/components/arena/Header';
import { Info, type InfoRow } from '@/components/arena/Info';
import { Nums } from '@/components/arena/Nums';
import { Refresh } from '@/components/arena/Refresh';
import { World } from '@/components/arena/World';
import p from '@/components/arena/page.module.css';
import { day, longest, utc } from '@/lib/show';
import { Countdown } from './Countdown';
import { Delivery, Lock } from './Delivery';
import { Earlier } from './Earlier';
import { TakeBack } from './TakeBack';
import { JUDGE_WORD, KIND_WORD, PLAN_SHOWN, ROLE_WORD, clockTime, entrantName, eventLine, jobMoving, jobTitle, longName, maskArt, maskName, nameFit, nearOrNull, paidOf, planCalls, refused, winnerOf } from './show';
import s from './jobs.module.css';

const ROLES = ['scout', 'striker', 'verifier'] as const;
/** Steps of a job's course the page shows at once: the latest. The earlier ones wait behind one control. */
const LATEST = 5;
const LOST_WORD = { fake: 'no work, all of it', idle: 'nothing counted, half', left: 'left early, for the time it held the slot' } as const;

function Title({ text }: { text: string }) {
  const chars = longest(text);
  return (
    <h1 className={`${p.word} ${p.title}`} data-long={chars > 10 ? '' : undefined} style={{ '--chars': chars } as CSSProperties}>
      {text}
    </h1>
  );
}

/** What the clock says now: the window that closes next, or how the job ended. */
function Sub({ job, now }: { job: Job; now: number }) {
  switch (job.phase) {
    case 'checking':
      return <>the judge checks the client’s material first</>;
    case 'enlisting':
      return (
        <>
          work closes in <Countdown ms={job.workUntil - now} className={p.clock} />
        </>
      );
    case 'revealing':
      return (
        <>
          reveals close in <Countdown ms={job.revealUntil - now} className={p.clock} />
        </>
      );
    case 'waiting':
      if (job.retryAt !== null && job.retryAt > now) {
        return (
          <>
            the work is in · the judge runs again in <Countdown ms={job.retryAt - now} className={p.clock} />
          </>
        );
      }
      return <>the work is in · anyone may call the judge</>;
    case 'judging':
      return <>the judge is deciding</>;
    case 'decided': {
      const v = job.verdict;
      if (v?.final || v?.appealUntil === null || !v) return <>final · pays when settled</>;
      return (
        <>
          pays after appeals close in <Countdown ms={v.appealUntil - now} className={p.clock} />
        </>
      );
    }
    case 'appealing':
      return <>the judge runs the appeal again</>;
    case 'paid': {
      const n = job.settlement?.payouts.length ?? 0;
      return <>paid to {n} {n === 1 ? 'mask' : 'masks'}{job.settlement?.at ? ` · ${day(job.settlement.at)}` : ''}</>;
    }
    case 'shared':
      return <>every counted strike paid in equal parts</>;
    case 'closed':
      return <>the reward went back to the client</>;
    case 'cancelled':
      return refused(job) ? <>the judge refused the client’s material</> : <>the client took it back before any step</>;
  }
}

/** A name the line may break after a dot or a dash of an account, never inside a word. */
function Breakable({ text }: { text: string }) {
  const parts = text.split(/(?<=[.\-_…])/);
  return (
    <>
      {parts.map((part, i) => (
        <span key={i}>
          {part}
          {i < parts.length - 1 ? <wbr /> : null}
        </span>
      ))}
    </>
  );
}

function Face({ m }: { m: Member }) {
  const art = maskArt(m.mask);
  return <span className={s.face}>{art ? <Image src={art} alt="" fill sizes="44px" quality={75} /> : <Mark className={s.faceMark} />}</span>;
}

function Crew({ e, job, explorer }: { e: Entrant; job: Job; explorer: (a: string) => string | undefined }) {
  const active = ROLES.filter((r) => e.split[r] > 0);
  return (
    <article className={s.crew} data-won={e.won ? '' : undefined}>
      <header className={s.crewHead}>
        <span className={`${p.word} ${s.crewName}`} data-long={!e.crew && e.members[0] && longName(e.members[0].mask) ? '' : undefined} data-fit={nameFit(entrantName(e))}>
          <Breakable text={entrantName(e)} />
        </span>
        <span className={s.crewMeta}>{e.crew ? `${e.members.length} masks` : 'alone'}</span>
        {e.won ? <span className={`${p.word} ${s.badge}`}>Won</span> : null}
      </header>
      <div className={s.split} aria-label={`Split of a won reward: ${active.map((r) => `${ROLE_WORD[r]} ${e.split[r] / 100}%`).join(', ')}`}>
        <span className={s.splitBar} aria-hidden>
          {active.map((r) => (
            <span key={r} className={s.splitPart} data-role={r} style={{ flex: `${e.split[r]} 1 0px` }} />
          ))}
        </span>
        <span className={s.splitLegend} aria-hidden>
          {active.map((r) => (
            <span key={r} className={s.splitItem} data-role={r}>
              <span className={`${p.word} ${s.splitWord}`}>{ROLE_WORD[r]}</span>
              <span className={s.splitPct}>{e.split[r] / 100}%</span>
            </span>
          ))}
        </span>
      </div>
      <ul className={s.members}>
        {e.members.map((m) => {
          const lost = m.bond.lost && BigInt(m.bond.lost) > 0n ? m.bond.lost : null;
          const due = job.phase === 'decided';
          return (
            <li key={m.mask.account} className={s.member} data-role={m.role} data-left={m.left ? '' : undefined}>
              <Face m={m} />
              <span className={s.memberText}>
                <span className={s.memberName}>
                  <span className={`${p.word} ${s.memberWord}`} data-long={longName(m.mask) ? '' : undefined} data-fit={nameFit(maskName(m.mask, 40))}>
                    <Breakable text={maskName(m.mask, 40)} />
                  </span>
                  <span className={`${p.word} ${s.role}`} data-role={m.role}>
                    {m.left ? 'Left' : ROLE_WORD[m.role]}
                  </span>
                </span>
              </span>
              <span className={s.memberMoney} data-tone={m.payout ? 'money' : lost ? 'loss' : 'plain'}>
                {m.payout ? (
                  `+${near(m.payout)}`
                ) : lost && m.bond.why !== 'left' ? (
                  <>
                    −{near(lost)}
                    <span className={`${p.word} ${s.moneyWord}`}>bond</span>
                  </>
                ) : (
                  ''
                )}
              </span>
              <span className={s.memberInfo}>
                <Info
                  align="end"
                  label={`${maskName(m.mask)} on this job`}
                  rows={[
                    { label: 'Account', value: m.mask.account, href: explorer(m.mask.account) },
                    { label: 'Role', value: m.left ? `${ROLE_WORD[m.role]} · left before its first step, the slot went back` : ROLE_WORD[m.role] },
                    { label: 'Fuel its mind burned', value: `${near(m.burned)} NEAR` },
                    { label: 'Fuel the job covers', value: m.covered === null ? 'after the verdict' : `${near(m.covered)} NEAR` },
                    { label: 'Steps', value: String(m.steps) },
                    { label: 'Bond', value: `${near(m.bond.amount)} NEAR${m.bond.by ? `, locked by ${m.bond.by}` : ''}` },
                    ...(m.bond.why ? [{ label: due ? 'Bond lost when settled' : 'Bond lost to the company', value: `${near(m.bond.lost ?? '0')} NEAR · ${LOST_WORD[m.bond.why]}` }] : []),
                    ...(m.payout ? [{ label: job.phase === 'paid' ? 'Paid' : 'Due when settled', value: `${near(m.payout)} NEAR` }] : []),
                  ]}
                />
              </span>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

/** +4:09 from the opening, +2 d 3 h for days. */
function offset(at: number, from: number): string {
  const d = Math.max(0, at - from);
  return `+${duration(d)}`;
}

/** What the judge made of a revealed step, once there is a verdict: the one word the course shows beside it. */
function judged(step: { counted: boolean | null; fake: boolean | null; copyOf: number | null }): { word: string; tone: 'counted' | 'fake' | 'plain' } | null {
  if (step.fake) return { word: 'No work', tone: 'fake' };
  if (step.counted) return { word: 'Counted', tone: 'counted' };
  if (step.copyOf !== null) return { word: 'A copy', tone: 'plain' };
  if (step.counted === false) return { word: 'Not counted', tone: 'plain' };
  return null;
}

function Course({ job, explorer }: { job: Job; explorer: { tx: (h: string) => string | undefined; account: (a: string) => string | undefined } }) {
  const steps = new Map(job.steps.map((st) => [st.seq, st]));
  const quiet = (e: JobEvent) => e.kind === 'burn' || e.kind === 'bond' || e.kind === 'unbond' || ((e.kind === 'judge' || e.kind === 'check') && !!e.note);
  const rows = job.events
    .filter((e) => e.kind !== 'close')
    .map((e, i) => {
      const step = e.seq === undefined ? undefined : steps.get(e.seq);
      const amount =
        e.kind === 'settle' ? nearOrNull(e.amount ?? (e.note === 'paid' ? paidOf(job).toString() : job.settlement?.back)) : e.kind === 'leave' ? null : nearOrNull(e.amount);
      // The seal itself is a hash: it stays behind the step's «i». The line shows only what the judge made of it.
      const mark = e.kind === 'reveal' && step ? judged(step) : null;
      const plan = e.kind === 'reveal' ? planCalls(step?.content) : null;
      return (
        <li key={`${e.tx}-${e.kind}-${i}`} className={`${p.step} ${s.event}`} data-kind={e.kind} data-quiet={quiet(e) ? '' : undefined}>
          <span className={p.when}>{offset(e.at, job.openedAt)}</span>
          <span className={`${p.what} ${s.eventWhat}`}>
            <span>{eventLine(e, job)}</span>
            {e.kind === 'verdict' ? <span className={`${p.word} ${p.tag}`}>The verdict</span> : null}
            {mark ? (
              <span className={`${p.word} ${s.judged}`} data-tone={mark.tone}>
                {mark.word}
              </span>
            ) : null}
            {e.kind === 'reveal' && plan ? (
              // A drain's plan is a list of calls: the course names them in order, the plan itself stays behind «i».
              <span className={s.plan} data-copy={step && step.copyOf !== null ? '' : undefined} data-counted={step?.counted ? '' : undefined}>
                <span className={s.planWord}>Calls</span>
                {plan.slice(0, PLAN_SHOWN).map((method, k) => (
                  <span key={k} className={s.planCall}>
                    {k > 0 ? <span className={s.planThen}>then</span> : null}
                    <b>{method}</b>
                  </span>
                ))}
                {plan.length > PLAN_SHOWN ? <span className={s.planThen}>and {plan.length - PLAN_SHOWN} more</span> : null}
              </span>
            ) : e.kind === 'reveal' && step?.content ? (
              <q className={s.content} data-copy={step.copyOf !== null ? '' : undefined} data-counted={step.counted ? '' : undefined}>
                <span className={s.contentText}>{step.content}</span>
              </q>
            ) : null}
          </span>
          <span className={p.amount} data-tone={e.kind === 'settle' && e.note === 'paid' ? 'money' : 'plain'}>
            {amount ? `${amount} NEAR` : ''}
          </span>
          <span className={p.stepInfo}>
            <Info
              align="end"
              label="This step on chain"
              rows={[
                { label: 'Time', value: utc(e.at) },
                ...(e.who ? [{ label: 'Who', value: e.who.account, href: explorer.account(e.who.account) }] : []),
                ...(step ? [{ label: `Seal of step #${step.seq}`, value: step.hash }] : []),
                ...(step?.boxed && e.kind === 'reveal' ? [{ label: 'Revealed', value: 'a box only the judge’s TEE opens: no text of the work is public' }] : []),
                ...(plan && step?.content ? [{ label: 'The plan as revealed', value: step.content }] : []),
                ...(step?.counted !== null && step ? [{ label: 'Judge', value: step.fake ? 'no work: the bond goes to the company' : step.counted ? 'counted' : 'not counted' }] : []),
                ...(step?.copyOf !== null && step ? [{ label: 'Copy of', value: `step #${step.copyOf}` }] : []),
                ...(e.kind === 'leave' && e.lost ? [{ label: 'Bond back', value: `${near(e.amount ?? '0')} NEAR` }, { label: 'For the time it held the slot', value: `${near(e.lost)} NEAR` }] : []),
                { label: 'Transaction', value: e.tx, href: explorer.tx(e.tx) },
              ]}
            />
          </span>
        </li>
      );
    });
  // The latest steps stand on the page; the earlier ones open with one control. A short course shows whole.
  const cut = rows.length > LATEST + 2 ? rows.length - LATEST : 0;
  return (
    <ol className={p.steps}>
      {cut ? <Earlier count={cut}>{rows.slice(0, cut)}</Earlier> : null}
      {rows.slice(cut)}
    </ol>
  );
}

/** Where this server's reader links to: the network's explorer and the judges' storage, when it knows them. */
export interface JobLinks {
  explorer: string | null;
  storage: string | null;
}

/**
 * `now` is the server's own clock at this answer (`Jobs.clock()`): every countdown runs from it to a deadline on chain,
 * and LIVE asks it whether the reading is fresh. The time of the block read (`board.readAt`) is never "now".
 */
export function JobScreen({ job, board, now, prev, next, links }: { job: Job; board: JobBoard; now: number; prev: Job | null; next: Job | null; links: JobLinks }) {
  const config = links;
  const explorer = { tx: (h: string) => txUrl(config, h), account: (a: string) => accountUrl(config, a) };
  const moving = jobMoving(job, board, now);
  const paid = paidOf(job);
  const winner = winnerOf(job);
  // Its client may take the job back while it is open and no mask has sealed a step on it (`cancel`).
  const back = ['checking', 'enlisting', 'revealing', 'waiting'].includes(job.phase) && job.steps.length === 0;
  // The transactions behind the result, where an explorer shows them: the judge's verdict, the payout, the delivery
  // of the winning work. Each is a link by its name; the hash itself stays behind the step's «i».
  const verdictTx = job.events.findLast((e) => e.kind === 'verdict')?.tx ?? null;
  const proof = [
    { label: 'Verdict', href: explorer.tx(verdictTx ?? '') },
    { label: job.settlement?.state === 'paid' || job.settlement?.state === 'shared' ? 'Payout' : 'Settled', href: explorer.tx(job.settlement?.tx ?? '') },
    { label: 'Delivery', href: explorer.tx(job.delivery?.tx ?? '') },
  ].filter((x): x is { label: string; href: string } => x.href !== undefined);
  const winnerArt = winner?.members.map((m) => maskArt(m.mask)).find(Boolean) ?? null;
  const art = job.phase === 'paid' || job.phase === 'decided' ? winnerArt : null;
  const number = job.phase === 'paid' && paid > 0n ? paid.toString() : job.reward;
  // Fuel is paid only for a counted step of a mind that burned it, to the job's treasury: MASK WARS's own account, which
  // pays the masks' inference. The page names where it goes once the chain shows some.
  const toTreasury = BigInt(job.settlement?.toTreasury ?? '0');
  const fueled = toTreasury > 0n || BigInt(job.fuelBurned) > 0n;

  const judge: InfoRow[] =
    job.judge.by === 'round'
      ? [
          { label: 'Judge', value: 'The sealed round’s own judge in a TEE: the drain on chain' },
          { label: 'Bounty contract', value: job.judge.bounty, href: explorer.account(job.judge.bounty) },
          { label: 'Round', value: `${job.judge.round}${job.judge.state ? ` · ${job.judge.state}` : ''}` },
        ]
      : [
          { label: 'Judge', value: `${JUDGE_WORD[job.kind]}, on OutLayer` },
          { label: 'Judge module', value: job.judge.project },
          { label: 'Judge wasm, sha256', value: job.judge.version },
          { label: 'Judge’s key in its TEE', value: job.judge.key },
          ...(job.bar ? [{ label: 'To win', value: job.kind === 'tee_tests' ? `${job.bar.winAt} of ${job.bar.cases ?? '?'} private cases` : `${job.bar.winAt} of 100 points` }] : []),
          ...(job.clientKey ? [{ label: 'Client’s key', value: job.clientKey }] : []),
        ];
  const facts: InfoRow[] = [
    { label: 'Job', value: job.id },
    { label: 'Kind', value: `${KIND_WORD[job.kind]} · ${job.kind}` },
    { label: 'Phase', value: job.phase },
    { label: 'Reward', value: `${near(job.reward)} NEAR` },
    { label: 'Bond', value: `${near(job.bond)} NEAR a mask: all lost for fake work, half for a seat that counted nothing, to the company` },
    { label: 'Fuel', value: `${near(job.fuelPerMask)} NEAR a mask × ${job.slots} slots${fueled ? `, paid for a counted step to ${job.treasury}, which pays the masks’ inference` : ''}` },
    { label: 'Client', value: job.client, href: explorer.account(job.client) },
    ...judge,
    { label: 'Spec, sha256', value: job.spec },
    ...(job.rubric ? [{ label: job.kind === 'tee_tests' ? 'Private test set, sha256' : 'Rubric, sha256', value: job.rubric }] : []),
    ...(job.secrets ? [{ label: 'Tests in the client’s secrets', value: job.secrets.profile }] : []),
    { label: 'Open to', value: job.openTo.who === 'anyone' ? 'any mask' : job.openTo.who === 'registered' ? `masks forged by ${job.openTo.factories.join(', ')}` : `only the masks its client listed: ${job.openTo.masks.join(', ')}` },
    { label: 'Company fee', value: `${job.feeBps / 100}% of a paid reward` },
    { label: 'Opened', value: utc(job.openedAt), href: job.txs.open ? explorer.tx(job.txs.open) : undefined },
    ...(job.checked || job.kind === 'drain' ? [] : [{ label: 'The judge checks until', value: utc(job.checkUntil) }]),
    { label: 'Work until', value: utc(job.workUntil) },
    { label: 'Reveal until', value: utc(job.revealUntil) },
    { label: 'Judge until', value: utc(job.judgeUntil) },
    { label: 'Contract', value: job.contract, href: explorer.account(job.contract) },
    { label: 'Network', value: `NEAR ${job.network}` },
  ];

  return (
    <main className={p.page} data-phase={job.phase === 'paid' ? 'broken' : undefined}>
      <World />
      {LIVE.has(job.phase) ? <Refresh everyMs={job.phase === 'judging' ? 5_000 : 30_000} /> : null}
      <Header network={board.network} live={moving} here="jobs" />

      <section className={`${p.hero} ${s.jobHero}`} data-art={art ? '' : undefined}>
        <div className={p.heroText}>
          <p className={`${p.word} ${p.kicker}`}>
            <Nums text={`${KIND_WORD[job.kind]} · `} />
            <span className={s.kickerId}>
              <Nums text={job.id} />
            </span>
            {LIVE.has(job.phase) && !isFresh(board, now) ? <Nums text={` · as of ${clockTime(board.readAt)}`} /> : null}
          </p>
          <Title text={jobTitle(job)} />
          <div className={p.big}>
            <span className={p.num} data-tone={job.phase === 'paid' || job.phase === 'decided' ? 'money' : 'plain'}>
              {near(number)}
              <span className={`${p.word} ${p.unit}`}>NEAR</span>
            </span>
            <Info rows={facts} label="The job on chain" align="start" />
          </div>
          <p className={p.sub}>
            <Sub job={job} now={now} />
          </p>
          {job.takes ? (
            <div className={`${s.acts} ${s.jobActs}`}>
              <Link href="/mcp/connect" className={`${p.btn} ${p.word} ${s.btn}`}>
                {job.openTo.who === 'registered' ? 'Take it with a forged mask' : 'Take it with your agent'}
              </Link>
            </div>
          ) : null}
          {back ? <TakeBack id={job.id} client={job.client} contract={job.contract} explorer={links.explorer ?? null} alone={!job.takes} /> : null}
          <blockquote className={s.brief}>
            <span className={`${p.word} ${s.briefLabel}`}>The job</span>
            <span className={s.briefText}>{job.brief}</span>
          </blockquote>
          <dl className={s.facts}>
            <div>
              <dt className={p.word}>Judge</dt>
              <dd>{JUDGE_WORD[job.kind]}</dd>
            </div>
            <div>
              <dt className={p.word}>Bond</dt>
              <dd>{near(job.bond)} NEAR</dd>
            </div>
            <div>
              <dt className={p.word}>Fuel a mask</dt>
              <dd>{near(job.fuelPerMask)} NEAR</dd>
            </div>
            <div>
              <dt className={p.word}>Masks</dt>
              <dd>
                {job.masks}/{job.slots}
              </dd>
            </div>
          </dl>
          {job.private ? (
            <p className={s.private}>
              <Lock className={s.privateLock} />
              <span className={p.word}>Private work</span>
              <Info rows={[]} label="What private means" align="start">
                <span className={s.infoText}>Only the judge reads the work. The world sees seals and times; the client gets the winning work alone, after the payout.</span>
              </Info>
            </p>
          ) : null}
        </div>
        <div className={`${p.heroArt} ${s.jobArt}`} aria-hidden>
          {art ? (
            <Image src={art} alt="" fill priority fetchPriority="high" sizes="(max-width: 900px) 70vw, 44vw" quality={85} className={p.heroMask} />
          ) : (
            <Image src="/art/vault.webp" alt="" fill priority fetchPriority="high" sizes="(max-width: 900px) 70vw, 40vw" quality={85} className={p.heroVault} />
          )}
        </div>
      </section>

      {job.entrants.length ? (
        <section className={s.band} aria-labelledby="crews">
          <h2 id="crews" className={`${p.word} ${p.h2}`}>
            {job.entrants.some((e) => e.crew) ? 'Crews' : 'Masks'}
          </h2>
          {/* How many cards share the row: three or more are narrow, and every role then stands under its name. */}
          <div className={s.crews} data-n={Math.min(job.entrants.length, 3)}>
            {job.entrants.map((e) => (
              <Crew key={e.index} e={e} job={job} explorer={explorer.account} />
            ))}
          </div>
        </section>
      ) : null}

      {job.settlement ? (
        <section className={s.band} aria-labelledby="payout">
          <div className={s.bandHead}>
            <h2 id="payout" className={`${p.word} ${p.h2}`}>
              {job.settlement.state === 'due' ? 'What it pays' : 'The payout'}
            </h2>
            <Info
              align="start"
              label="Where the rest of the money goes"
              rows={[
                ...(toTreasury > 0n ? [{ label: 'Fuel to MASK WARS', value: `${near(job.settlement.toTreasury)} NEAR` }] : []),
                { label: 'Company fee', value: `${near(job.settlement.fee)} NEAR` },
                { label: 'Bonds to the company', value: `${near(job.settlement.forfeit)} NEAR` },
                { label: 'Bonds back', value: `${near(job.settlement.bondsBack)} NEAR` },
                ...(job.settlement.back ? [{ label: 'Back to the client', value: `${near(job.settlement.back)} NEAR` }] : []),
                ...(job.settlement.state === 'due' ? [{ label: 'When', value: 'pays when the job is settled' }] : []),
              ]}
            />
          </div>
          <div className={s.payout}>
            {job.settlement.payouts.map((x) => (
              <div key={x.mask.account} className={s.payLine}>
                <span className={s.payWho}>
                  <span className={`${p.word} ${s.payName}`} data-long={longName(x.mask) ? '' : undefined}>
                    <Breakable text={maskName(x.mask, 40)} />
                  </span>
                  {x.role ? (
                    <span className={`${p.word} ${s.role}`} data-role={x.role}>
                      {ROLE_WORD[x.role]}
                    </span>
                  ) : null}
                </span>
                <span className={s.payAmount} data-tone="money">
                  {near(x.amount)}
                  <span className={`${p.word} ${s.unitSmall}`}>NEAR</span>
                </span>
              </div>
            ))}
            {job.settlement.payouts.length === 0 ? (
              <div className={s.payLine}>
                <span className={`${p.word} ${s.payName} ${s.payNote}`}>{job.settlement.state === 'cancelled' || job.settlement.state === 'closed' ? 'Back to the client' : 'Nobody is paid'}</span>
                {job.settlement.back ? (
                  <span className={s.payAmount} data-tone="plain">
                    {near(job.settlement.back)}
                    <span className={`${p.word} ${s.unitSmall}`}>NEAR</span>
                  </span>
                ) : null}
              </div>
            ) : null}
            {proof.length ? (
              <div className={s.proof}>
                {proof.map((x) => (
                  <a key={x.label} href={x.href} target="_blank" rel="noreferrer" className={s.proofLink}>
                    <span className={p.word}>{x.label}</span>
                    <Arrow className={s.proofArrow} />
                  </a>
                ))}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      {job.private && job.phase === 'paid' && job.clientKey && board.market ? (
        <section className={s.band} aria-labelledby="work">
          <h2 id="work" className={`${p.word} ${p.h2}`}>
            The work
          </h2>
          <Delivery
            facts={{
              id: job.id,
              contract: job.contract,
              client: job.client,
              clientKey: job.clientKey,
              judgeFee: board.market.judgeFee,
              judgeFeeNear: near(board.market.judgeFee),
              delivered: job.delivery
                ? {
                    at: job.delivery.at,
                    project: job.delivery.project,
                    sha256: job.delivery.sha256,
                    when: utc(job.delivery.when),
                    url: deliveryUrl(config, job.delivery),
                    tx: job.delivery.tx,
                    txUrl: explorer.tx(job.delivery.tx),
                  }
                : null,
            }}
          />
        </section>
      ) : null}

      <section className={`${p.course} ${s.band}`} aria-labelledby="course">
        <h2 id="course" className={`${p.word} ${p.h2}`}>
          On chain
        </h2>
        {job.events.length ? (
          <Course job={job} explorer={explorer} />
        ) : (
          <p className={s.missing}>The job’s transactions could not be read just now. Its state above is the contract’s own.</p>
        )}
      </section>

      <nav className={p.pager} aria-label="Jobs">
        {prev ? (
          <Link href={`/jobs/${encodeURIComponent(prev.id)}`} className={p.pagerLink}>
            <Arrow className={s.back} /> {prev.id}
          </Link>
        ) : (
          <span />
        )}
        <Link href="/jobs" className={`${p.btn} ${p.word}`}>
          Every job
        </Link>
        {next ? (
          <Link href={`/jobs/${encodeURIComponent(next.id)}`} className={p.pagerLink}>
            {next.id} <Arrow className={s.fwd} />
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </main>
  );
}
