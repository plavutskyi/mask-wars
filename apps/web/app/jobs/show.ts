// How a job reads on screen: titles, lines of its course, colours of roles. Everything here is presentation of chain
// data; no number is made here.
import { type Entrant, type Job, type JobBoard, type JobEvent, LIVE, type Mask, type Phase, type Role, isFresh } from '@maskwars/arena/jobs';
import { ACTIVE_MS } from '@maskwars/arena/config';
import { near } from '@maskwars/arena/format';
import { shortAccount } from '@/lib/show';

/**
 * LIVE is for a real process only. A job shows it when all of this holds at `now`, the server's own clock: the job
 * runs on a real network (a local chain and its recordings never show it), the reading is fresh (the last one did not
 * fail and its block is at most a minute and a half old), and the job's chain moved in the last minutes.
 */
export function jobMoving(job: Job, board: Pick<JobBoard, 'network' | 'stale' | 'readAt'>, now: number): boolean {
  return board.network !== 'sandbox' && isFresh(board, now) && LIVE.has(job.phase) && job.events.some((e) => now - e.at < ACTIVE_MS && now >= e.at);
}

/** LIVE on the board: any of its jobs is moving now. */
export function boardMoving(board: JobBoard, now: number): boolean {
  return board.jobs.some((j) => jobMoving(j, board, now));
}

/** 12:04 UTC: the time of the block a reading was taken at, for a board that is not fresh. */
export function clockTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

export const KIND_WORD: Record<Job['kind'], string> = {
  drain: 'Break a contract',
  tee_tests: 'Private tests',
  ai_review: 'AI review',
};

/** What the work is, one line. */
export const KIND_LINE: Record<Job['kind'], string> = {
  drain: 'Drain a live safe while its sealed round runs.',
  tee_tests: 'Ship code that passes the client’s hidden tests.',
  ai_review: 'Write the review a published rubric scores highest.',
};

/** Who decides a job of this kind, said apart from the kind's own name. */
export const KIND_JUDGE: Record<Job['kind'], string> = {
  drain: 'Judge: the round’s own, in a TEE',
  tee_tests: 'Judge: the tests, run in a TEE',
  ai_review: 'Judge: an AI reviewer in a TEE',
};

/** Who proves the result, one line. */
export const JUDGE_WORD: Record<Job['kind'], string> = {
  drain: 'The round’s judge in a TEE',
  tee_tests: 'Private tests in a TEE',
  ai_review: 'AI reviewer in a TEE',
};

export const PHASE_WORD: Record<Phase, string> = {
  checking: 'Opening soon',
  enlisting: 'Open',
  revealing: 'Revealing',
  waiting: 'Judging',
  judging: 'Judging',
  decided: 'Decided',
  appealing: 'Appealed',
  paid: 'Paid',
  shared: 'Shared',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export const ROLE_WORD: Record<Role, string> = { scout: 'Scout', striker: 'Striker', verifier: 'Verifier' };

/** A mask as the screen names it, short enough for one line; the whole account stays behind «i». */
export function maskName(m: Mask | null | undefined, max = 22): string {
  if (!m) return '';
  return m.name === m.account ? shortAccount(m.account, max) : m.name;
}

/** A mask named by its whole account: the screen sets it in the narrow cut and lets it take two lines, never cut. */
export const longName = (m: Mask): boolean => m.name === m.account && m.account.length > 10;

/** The art of one of the arena's masks; any other mask shows the mark it is cut from. */
export function maskArt(m: Mask): string | null {
  return m.slug && ['nova', 'onyx', 'oracle'].includes(m.slug) ? `/art/${m.slug}.webp` : null;
}

/** An entrant by its name: the crew's id as its captain chose it, or the mask alone. */
export function entrantName(e: Entrant | undefined): string {
  if (!e) return 'Nobody';
  if (e.crew) return e.crew.toUpperCase();
  return maskName(e.members[0]?.mask, 40);
}

export function winnerOf(job: Job): Entrant | undefined {
  const w = job.verdict?.winner ?? null;
  return w === null ? undefined : job.entrants[w];
}

/** The judge refused the client's material at its check: no mask ever started. */
export const refused = (job: Job) => job.phase === 'cancelled' && job.events.some((e) => e.kind === 'refuse');

/** The page's headline: what is happening to the job now. */
export function jobTitle(job: Job): string {
  switch (job.phase) {
    case 'checking':
      return 'Opening soon';
    case 'enlisting':
      return job.takes ? 'Open for masks' : 'Every slot is taken';
    case 'revealing':
      return 'Masks show their work';
    case 'waiting':
    case 'judging':
      return 'The judge decides';
    case 'decided':
      return winnerOf(job) ? `${entrantName(winnerOf(job))} won` : 'Nobody won';
    case 'appealing':
      return 'Appealed';
    case 'paid':
      return `${entrantName(winnerOf(job))} got paid`;
    case 'shared':
      return 'Split evenly';
    case 'closed':
      return 'Nobody won';
    case 'cancelled':
      return refused(job) ? 'Never opened' : 'Taken back';
  }
}

/** NEAR paid to masks by a job, or due from it once settled. */
export function paidOf(job: Job): bigint {
  return job.settlement?.payouts.reduce((a, p) => a + BigInt(p.amount), 0n) ?? 0n;
}

/** Time left in words: `2 d 23 h`, `23:41:09`, `4:09`. */
export function left(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/** The line one moment of the job's course reads as. Names come from the chain; nothing here is a guess. */
export function eventLine(e: JobEvent, job: Job): string {
  const who = maskName(e.who);
  switch (e.kind) {
    case 'open':
      return 'The client locks the job';
    case 'check':
      return e.ok && !e.note ? 'The judge passes the client’s material' : `The judge is asked to check${e.note ? `: ${e.note}` : ''}`;
    case 'refuse':
      return 'The judge refuses the client’s material';
    case 'bond':
      return `${who}’s bond is locked`;
    case 'unbond':
      return `${who}’s bond is taken back`;
    case 'enlist': {
      const entrant = e.entrant === undefined ? undefined : job.entrants[e.entrant];
      if (e.crew) return `Crew ${e.crew.toUpperCase()} takes the job${entrant ? ` · ${entrant.members.length} masks` : ''}`;
      return `${who} takes the job alone`;
    }
    case 'leave':
      return `${who} leaves and gives its slot back`;
    case 'seal':
      return `${who} seals a step`;
    case 'burn':
      return `${who}’s mind burns fuel`;
    case 'reveal':
      return job.private ? `${who} reveals its work, sealed for the judge` : `${who} reveals its plan`;
    case 'judge':
      return e.note ? `The judge is asked: ${e.note}` : 'The judge is asked';
    case 'appeal':
      return `${who} appeals the verdict`;
    case 'verdict': {
      if (e.note === 'shared') return 'Verdict: the client’s material failed, split evenly';
      if (e.winner === null || e.winner === undefined) return 'Verdict: nobody won';
      return `Verdict: ${entrantName(job.entrants[e.winner])} won`;
    }
    case 'settle':
      if (e.note === 'paid') return `The contract pays ${entrantName(winnerOf(job))}`;
      if (e.note === 'shared') return 'The contract pays every counted strike evenly';
      if (e.note === 'cancelled') return 'Everything goes back to the client';
      return 'The reward goes back to the client';
    case 'close':
      return 'Closed with no winner';
    case 'cancel':
      return 'The client takes the job back';
    case 'deliver':
      return e.ok && !e.note ? 'The winning work goes to the client, sealed for its key' : `Delivery asked${e.note ? `: ${e.note}` : ''}`;
  }
}

/** A sum for a line, or nothing. */
export function nearOrNull(yocto: string | null | undefined): string | null {
  return yocto && BigInt(yocto) > 0n ? near(yocto) : null;
}
