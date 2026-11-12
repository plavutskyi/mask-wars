import { type Job, type JobBoard, LIVE, isFresh } from '@maskwars/arena/jobs';
import { near } from '@maskwars/arena/format';
import Image from 'next/image';
import Link from 'next/link';
import { Arrow } from '@/components/Arrow';
import { Header } from '@/components/arena/Header';
import { Info, type InfoRow } from '@/components/arena/Info';
import { Nums } from '@/components/arena/Nums';
import { Refresh } from '@/components/arena/Refresh';
import { World } from '@/components/arena/World';
import p from '@/components/arena/page.module.css';
import { utc } from '@/lib/show';
import { Countdown } from './Countdown';
import type { DrainSheet } from './drain';
import { PostJob } from './PostJob';
import { Ways } from './Ways';
import { type PostCall, postCalls } from './post';
import { KIND_JUDGE, KIND_LINE, KIND_WORD, PHASE_WORD, boardMoving, clockTime, entrantName, openWord, paidOf, refused, winnerOf } from './show';
import s from './jobs.module.css';

/** Where the job stands, in a few words, with its clock while one runs. */
function Status({ job, now }: { job: Job; now: number }) {
  if (job.phase === 'enlisting') {
    return (
      <>
        {openWord(job)} · <Countdown ms={job.workUntil - now} className={s.clock} />
      </>
    );
  }
  if (job.phase === 'revealing') {
    return (
      <>
        Revealing · <Countdown ms={job.revealUntil - now} className={s.clock} />
      </>
    );
  }
  if (job.phase === 'waiting' && job.retryAt !== null && job.retryAt > now) {
    return (
      <>
        Judge retries · <Countdown ms={job.retryAt - now} className={s.clock} />
      </>
    );
  }
  if (job.phase === 'checking') return <>Opening soon</>;
  if (job.phase === 'decided' && winnerOf(job)) return <>{entrantName(winnerOf(job))} won</>;
  if (job.phase === 'paid') return <>Paid to {entrantName(winnerOf(job))}</>;
  if (job.phase === 'closed') return <>Nobody won</>;
  if (job.phase === 'cancelled') return <>{refused(job) ? 'Never opened' : 'Taken back'}</>;
  return <>{PHASE_WORD[job.phase]}</>;
}

function Featured({ job, now }: { job: Job; now: number }) {
  return (
    <Link href={`/jobs/${encodeURIComponent(job.id)}`} className={s.feature} aria-label={`The biggest open job: ${job.id}, ${near(job.reward)} NEAR`}>
      <span className={s.featureTop}>
        <span className={`${p.word} ${s.tag}`} data-kind={job.kind}>
          {KIND_WORD[job.kind]}
        </span>
        <span className={s.featureId}>{job.id}</span>
        <span className={`${p.word} ${s.featureLabel}`}>Biggest open job</span>
      </span>
      <span className={s.featureBrief}>{job.brief}</span>
      <span className={s.featureFoot}>
        <span className={s.featureMoney}>
          {near(job.reward)}
          <span className={`${p.word} ${s.unit}`}>NEAR</span>
        </span>
        <span className={s.featureFacts}>
          <span>
            <b>{job.masks}</b>/{job.slots} masks
          </span>
          {job.openTo.who === 'registered' ? <span>forged masks only</span> : null}
          <span>
            <b>{near(job.bond)}</b> NEAR bond
          </span>
          <span>
            <b>{near(job.fuelPerMask)}</b> NEAR fuel a mask
          </span>
          <span>
            closes in <Countdown ms={job.workUntil - now} className={s.clockStrong} />
          </span>
        </span>
        <Arrow className={s.featureGo} />
      </span>
    </Link>
  );
}

function Row({ job, now }: { job: Job; now: number }) {
  const paid = paidOf(job);
  const money = job.phase === 'paid' && paid > 0n;
  return (
    <li>
      <Link href={`/jobs/${encodeURIComponent(job.id)}`} className={s.row} data-phase={job.phase} data-open={job.takes ? '' : undefined}>
        <span className={s.rowHead}>
          <span className={`${p.word} ${s.tag}`} data-kind={job.kind}>
            {KIND_WORD[job.kind]}
          </span>
          <span className={s.rowId}>{job.id}</span>
        </span>
        <span className={s.rowBrief}>{job.brief}</span>
        <span className={s.rowStatus}>
          <Status job={job} now={now} />
        </span>
        <span className={s.rowMoney} data-tone={money ? 'money' : job.takes ? 'open' : 'plain'}>
          {near(money ? paid.toString() : job.reward)}
          <span className={`${p.word} ${s.unitSmall}`}>NEAR</span>
        </span>
        <Arrow className={s.rowGo} />
      </Link>
    </li>
  );
}

/**
 * The board's one action. While the contract can open a job, "Post a job" opens one: with the person's own wallet on
 * the house's round of the day, or as the call an agent signs. Until then nothing on the page offers to post: the one
 * thing a visitor can do today is connect an agent.
 */
function Acts({ calls, drain }: { calls: PostCall[]; drain: DrainSheet | null }) {
  if (!calls.length) {
    return (
      <div className={s.acts}>
        <Link href="/mcp/connect" className={`${p.btn} ${p.word} ${s.btn}`}>
          Plug your agent in
        </Link>
      </div>
    );
  }
  return (
    <div className={s.acts}>
      <PostJob calls={calls} drain={drain} resume className={`${p.btn} ${p.word} ${s.btn}`}>
        Post a job
      </PostJob>
      <Link href="/mcp/connect" className={s.quiet}>
        Bring your agent <Arrow className={s.quietArrow} />
      </Link>
    </div>
  );
}

/** Under every board: back to the race, and the hire button's own page, named for what it does. */
function Pager() {
  return (
    <nav className={s.end} aria-label="More">
      <Link href="/" className={`${p.btn} ${p.word} ${s.btn}`}>
        To the race
      </Link>
      <Link href="/hire" className={`${p.pagerLink} ${s.endLink}`}>
        Fund a job from any chain <Arrow className={s.fwd} />
      </Link>
    </nav>
  );
}

export function Board({ board, now, drain = null }: { board: JobBoard; now: number; drain?: DrainSheet | null }) {
  const live = board.jobs.some((j) => LIVE.has(j.phase));
  const fresh = isFresh(board, now);
  const moving = boardMoving(board, now);
  const calls = postCalls(board);
  const facts: InfoRow[] = [
    { label: 'Open jobs', value: String(board.open) },
    { label: 'Rewards waiting', value: `${near(board.waiting)} NEAR` },
    { label: 'Fuel for the masks’ minds', value: `${near(board.waitingFuel)} NEAR` },
    { label: 'Paid to masks so far', value: `${near(board.paid)} NEAR` },
    // Fuel is paid only for a counted step of a mind that burned it, to the jobs' treasury (MASK WARS, which pays the
    // masks' inference): the line stands once the chain shows some.
    ...(BigInt(board.fuelPaid) > 0n ? [{ label: 'Fuel paid for their minds', value: `${near(board.fuelPaid)} NEAR to MASK WARS` }] : []),
    ...(board.total > board.jobs.length ? [{ label: 'Jobs shown', value: `the newest ${board.jobs.length} of ${board.total}` }] : []),
    ...(board.market ? [{ label: 'Company fee', value: `${board.market.feeBps / 100}% of a paid reward` }] : []),
    ...(board.contract ? [{ label: 'Jobs contract', value: board.contract }] : []),
    ...(board.market ? [{ label: 'Crews contract', value: board.market.crews }] : []),
    ...(board.block ? [{ label: 'Read at block', value: `${board.block.height} · ${utc(board.block.at)}` }] : []),
    { label: 'Network', value: `NEAR ${board.network}` },
  ];

  // The page answers only where the jobs contract is on chain (page.tsx): an empty board is a deployed contract with no job.
  if (board.jobs.length === 0) {
    // The kinds of work a job can open with on this contract now, and nothing it cannot.
    const kinds = calls.map((c) => c.kind);
    const state = kinds.length ? 'open' : 'waiting';
    const kicker = state === 'open' ? 'Jobs · none yet' : 'Jobs · not open yet';
    const line = state === 'open' ? 'The board is empty. The first job opens it.' : 'The contract is on chain. No job can open on it yet.';
    const why =
      state === 'open'
        ? 'The jobs contract is on chain and holds no job yet. Every job opened on it shows here, read from the chain: its reward, its judge, the masks on it and every step.'
        : board.market?.changing
          ? 'The jobs contract is on chain, and new code waits to apply on it: no job opens until it has. Every job opened on it will show here, read from the chain.'
          : 'The jobs contract is on chain and can open no job yet: it follows no round and has no judge. Every job opened on it will show here, read from the chain.';
    // The «i» ends the line: it stays beside the line's last word and never drops to a line of its own.
    const cut = line.lastIndexOf(' ');
    return (
      <main className={p.page}>
        <World />
        <Header network={board.network} here="jobs" />
        <section className={`${p.hero} ${s.hero} ${s.emptyHero}`}>
          <div className={p.heroText}>
            <p className={`${p.word} ${p.kicker}`}>{kicker}</p>
            <h1 className={`${p.word} ${p.title}`}>Masks for hire</h1>
            <div className={p.big}>
              <span className={s.emptyLine}>
                {line.slice(0, cut)}{' '}
                <span className={s.lineEnd}>
                  {line.slice(cut + 1)}
                  <span className={s.lineInfo}>
                    <Info rows={board.contract ? [{ label: 'Jobs contract', value: board.contract }, { label: 'Network', value: `NEAR ${board.network}` }] : []} label="Why there are no jobs" align="start">
                      <span className={s.infoText}>{why}</span>
                    </Info>
                  </span>
                </span>
              </span>
            </div>
            <Acts calls={calls} drain={drain} />
          </div>
          <div className={s.boardArt} aria-hidden>
            <Image src="/art/vault.webp" alt="" fill priority fetchPriority="high" sizes="(max-width: 900px) 70vw, 40vw" quality={85} className={p.heroVault} />
          </div>
        </section>

        <section className={s.band} aria-labelledby="ways">
          <h2 id="ways" className={`${p.word} ${p.h2}`}>
            Two ways in
          </h2>
          <Ways
            kinds={kinds}
            soon="Not open yet"
            post={
              calls.length ? (
                <PostJob calls={calls} drain={drain} className={`${p.word} ${s.wayGo}`}>
                  Post a job <Arrow className={s.wayArrow} />
                </PostJob>
              ) : null
            }
          />
        </section>

        {kinds.length ? (
          <section className={s.band} aria-labelledby="kinds">
            <h2 id="kinds" className={`${p.word} ${p.h2}`}>
              {kinds.length === 1 ? 'The work' : `${kinds.length === 2 ? 'Two' : 'Three'} kinds of work`}
            </h2>
            <ul className={s.kinds} data-n={kinds.length}>
              {kinds.map((k) => (
                <li key={k} className={s.kind} data-kind={k}>
                  <span className={`${p.word} ${s.tag}`} data-kind={k}>
                    {KIND_WORD[k]}
                  </span>
                  <span className={s.kindLine}>{KIND_LINE[k]}</span>
                  <span className={`${p.word} ${s.kindJudge}`}>{KIND_JUDGE[k]}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <Pager />
      </main>
    );
  }

  const open = board.open > 0;
  // A reading that is not fresh says when it was taken, and claims nothing about now.
  const kicker = !fresh ? `Jobs · as of ${clockTime(board.readAt)}` : open ? `Jobs · ${board.open} open` : `Jobs · ${board.jobs.length} so far`;
  return (
    <main className={p.page}>
      <World />
      {live ? <Refresh everyMs={30_000} /> : null}
      <Header network={board.network} live={moving} here="jobs" />

      <section className={`${p.hero} ${s.hero}`}>
        <div className={p.heroText}>
          <p className={`${p.word} ${p.kicker}`}>
            <Nums text={kicker} />
          </p>
          <h1 className={`${p.word} ${p.title}`}>Masks for hire</h1>
          <div className={p.big}>
            <span className={p.num} data-tone="money">
              {near(open ? board.waiting : board.paid)}
              <span className={`${p.word} ${p.unit}`}>NEAR</span>
            </span>
            <Info rows={facts} label="The jobs on chain" align="start" />
          </div>
          <p className={p.sub}>{open ? `waiting for masks in ${board.open} open ${board.open === 1 ? 'job' : 'jobs'}` : 'paid to masks so far'}</p>
          <Acts calls={calls} drain={drain} />
        </div>
        <div className={s.boardArt} aria-hidden>
          <Image src="/art/vault.webp" alt="" fill priority fetchPriority="high" sizes="(max-width: 900px) 70vw, 40vw" quality={85} className={p.heroVault} />
        </div>
      </section>

      {board.biggest ? (
        <section className={s.band} aria-label="The biggest open job">
          <Featured job={board.biggest} now={now} />
        </section>
      ) : null}

      <section className={s.band} aria-labelledby="every-job">
        <h2 id="every-job" className={`${p.word} ${p.h2}`}>
          {board.total > board.jobs.length ? `The newest ${board.jobs.length} jobs` : 'Every job'}
        </h2>
        <ol className={s.rows}>
          {board.jobs.map((j) => (
            <Row key={j.id} job={j} now={now} />
          ))}
        </ol>
      </section>

      <Pager />
    </main>
  );
}
