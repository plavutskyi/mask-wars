// @vitest-environment happy-dom
// "Post a job" on mainnet, walked with a stand-in wallet (the test hook of NEXT_PUBLIC_JOBS_TEST=1, the same one the
// screenshots' build reads): one line, a reward, one signature, and the job on the board. Outside the window of the
// house's round, and when the window closes while the sheet is open, nothing is signed.
import { createHash } from 'node:crypto';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAINNET_JOBS } from '@maskwars/arena/jobs';
import { emptyJobs } from '@maskwars/arena/jobs/fixture';
import { NETWORKS } from '@maskwars/network';
import type { HouseRound } from './drain';
import { drainSheet, postCalls } from './post';
import type { Signer } from './wallet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const refresh = vi.fn();
vi.mock('next/link', () => ({ default: ({ href, className, children }: { href: string; className?: string; children?: ReactNode }) => <a href={href} className={className}>{children}</a> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
// The real wallet module, with its test hook; one test makes the wallet slow to connect.
const hook = vi.hoisted(() => ({ slow: null as Promise<unknown> | null }));
vi.mock('./wallet', async (original) => {
  const actual = await original<typeof import('./wallet')>();
  return { ...actual, signIn: () => (hook.slow as ReturnType<typeof actual.signIn> | null) ?? actual.signIn() };
});

const { PostJob } = await import('./PostJob');
const { forgetPostFlow } = await import('./DrainPost');

const MAINNET = NETWORKS.mainnet;
const at = (hh: number, mm: number) => Date.UTC(2026, 10, 13, hh, mm);
const board = await emptyJobs('deployed', MAINNET_JOBS).board();
const calls = postCalls(board);

// Seals until 18:49:30: half a minute either way of a press never moves the whole minutes counted.
const open = (now: number, arena: HouseRound['arena'] = { left: 2, full: [] }): HouseRound => ({ live: true, bounty: MAINNET.bounty, round: { id: 'race-0004', sealUntil: at(18, 49) + 30_000 }, now, arena });
/** The same round, with the arena's masks taking no more jobs from outside on it. */
const booked = (now: number): HouseRound => open(now, { left: 0, full: [] });
const closed = (now: number): HouseRound => ({ live: true, bounty: MAINNET.bounty, round: null, now });

/** What /api/jobs-round answers next, and the jobs the board holds by id. */
let rounds: HouseRound[] = [];
let jobs: Record<string, unknown> = {};
let asked: string[] = [];
let root: Root | null = null;
let box: HTMLDivElement;

function api() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    if (url === '/api/jobs-round') return Response.json(rounds.length > 1 ? rounds.shift() : rounds[0]);
    const id = /^\/api\/jobs\/([^?]+)\?missing=null&at=\d+$/.exec(url)?.[1];
    if (id) return Response.json(jobs[decodeURIComponent(id)] ?? null);
    return new Response('{}', { status: 404 });
  });
}

/**
 * A wallet that signs whatever it is handed, and puts the job on the board as the chain would, opened at `openedAt`.
 * `hold`: the person takes that long to approve.
 */
function wallet(o: { decline?: boolean; openedAt?: number; hold?: number } = {}) {
  const signed: { receiverId: string; action: Parameters<Signer['call']>[1] }[] = [];
  const signer: Signer = {
    accountId: 'alice.near',
    async call(receiverId, action) {
      signed.push({ receiverId, action });
      if (o.hold) await new Promise((r) => setTimeout(r, o.hold));
      if (o.decline) throw new Error('User rejected the request');
      const args = action.params.args as { id: string; reward: string; spec: string; work_minutes: number };
      const opened = o.openedAt ?? at(18, 10);
      jobs[args.id] = { id: args.id, client: 'alice.near', phase: 'enlisting', openedAt: opened, workUntil: opened + args.work_minutes * 60_000, reward: args.reward, spec: args.spec, txs: { open: '9xTx' } };
      return '9xTx';
    },
  };
  window.__jobsSigner = signer;
  return signed;
}

const settle = (ms = 60) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const button = (text: RegExp) => [...document.querySelectorAll('button, a')].find((b) => text.test(b.textContent ?? '')) as HTMLElement | undefined;
const input = (label: string) => {
  const l = [...document.querySelectorAll('label')].find((x) => x.textContent?.trim() === label);
  return document.getElementById(l!.htmlFor) as HTMLInputElement | HTMLTextAreaElement;
};

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!;
  set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The board with its "Post a job" button, opened; `twice`: the empty board's second button too, as on mainnet now. */
async function render(house: HouseRound, twice = false) {
  const drain = drainSheet(board, MAINNET, house, MAINNET.explorer)!;
  box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  await act(async () => {
    root!.render(
      <>
        <PostJob calls={calls} drain={drain} resume className="go">
          Post a job
        </PostJob>
        {twice ? (
          <PostJob calls={calls} drain={drain} className="way">
            Post this job
          </PostJob>
        ) : null}
      </>,
    );
  });
  await act(async () => button(/^Post a job$/)!.click());
  await settle();
}

beforeEach(() => {
  forgetPostFlow();
  hook.slow = null;
  localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_JOBS_TEST', '1');
  rounds = [];
  jobs = {};
  asked = [];
  refresh.mockClear();
  sessionStorage.clear();
  api();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  delete window.__jobsSigner;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('posting a drain with a wallet', () => {
  it('signs one `open` on the jobs contract with the line and the reward, and shows the job once the board has it', async () => {
    rounds = [open(at(18, 10))];
    const signed = wallet();
    await render(open(at(18, 10)));
    expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/Open for 14:[23]\d · race-0004/i);
    expect(input('The job').value).toBe('Drain the house vault in race-0004.');
    expect(button(/^Post with NEAR wallet$/)?.getAttribute('aria-disabled')).toBe('false');
    expect(document.body.textContent).toContain('Locks 1.64 NEAR. At least 0.62 comes back after the round, the reward too if no mask drains it.');
    // The masks' bonds are MASK WARS's, not the person's: the person locks the deposit and nothing more.
    expect(document.body.textContent).toContain('The masks’ bondsMASK WARS locks them: 3 × 0.05 NEAR');
    expect(document.body.textContent).toContain('MasksNOVA, ONYX and ORACLE take it; 4 slots, any mask');

    await act(async () => {
      type(input('The job'), 'Drain the vault before ORACLE does.');
      type(input('Reward'), '2');
    });
    expect(document.body.textContent).toContain('Locks 2.64 NEAR. At least 0.62 comes back after the round, the reward too if no mask drains it.');
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(1500);

    expect(signed).toHaveLength(1);
    const { receiverId, action } = signed[0]!;
    const args = action.params.args as Record<string, unknown>;
    expect(receiverId).toBe('jobs.maskwars.near');
    expect(action).toMatchObject({ type: 'FunctionCall', params: { methodName: 'open', gas: '100000000000000', deposit: '2640000000000000000000000' } });
    expect(args).toMatchObject({
      kind: 'drain',
      brief: 'Drain the vault before ORACLE does.',
      spec: createHash('sha256').update('Drain the vault before ORACLE does.').digest('hex'),
      round: { bounty: 'bounty.maskwars.near', id: 'race-0004' },
      reward: '2000000000000000000000000',
      fuel_per_mask: '50000000000000000000000',
      slots: 4,
      open_to: { who: 'anyone' },
      reveal_minutes: 30,
      appeal_minutes: 10,
    });
    expect(args['id']).toMatch(/^race-0004-[a-z0-9]{6}$/);
    // 39 whole minutes of seals left at the press, less the 5 the crew needs to enlist.
    expect(args['work_minutes']).toBe(34);
    // The round was read again right before the wallet was asked.
    expect(asked.filter((u) => u === '/api/jobs-round').length).toBeGreaterThanOrEqual(2);

    expect(document.body.textContent).toContain('Your job is live');
    expect(document.body.textContent).toContain(`${args['id']}2 NEAR`);
    expect(document.body.textContent).toMatch(/On the board\. NOVA, ONYX and ORACLE can take it for 3\d:\d\d more\./);
    expect(button(/^See your job$/)?.getAttribute('href')).toBe(`/jobs/${args['id']}`);
    expect(button(/The transaction/)?.getAttribute('href')).toBe('https://nearblocks.io/txns/9xTx');
    expect(sessionStorage.getItem('maskwars.jobs.pending')).toBeNull();
    // This device posted it: the job's page offers it back to its client.
    expect(JSON.parse(localStorage.getItem('maskwars.jobs.mine')!)).toEqual([args['id']]);
    // The board behind reads the chain again once the sheet closes, not while it shows the job (an empty board is laid
    // out anew with its first job, and would take the sheet with it). The form is then ready for the next job.
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => button(/^Post a job$/)!.click());
    await settle();
    expect(button(/^Post with NEAR wallet$/)).toBeTruthy();
    expect(input('Reward').value).toBe('2');
  });

  it('outside the window says when the next one opens, and nothing it does asks a wallet', async () => {
    rounds = [closed(at(10, 0))];
    const signed = wallet();
    await render(closed(at(10, 0)));
    expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/Next window in 8:0\d:\d\d/);
    const go = button(/^Opens at 18:04 UTC$/)!;
    expect(go.getAttribute('aria-disabled')).toBe('true');
    await act(async () => go.click());
    await act(async () => {
      input('The job').form!.requestSubmit();
    });
    await settle(200);
    expect(signed).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Pick your NEAR wallet');
    // An agent still gets the call, with the round's id to fill in once the window opens.
    expect(document.querySelector('pre code')?.textContent).toContain('"round":{"bounty":"bounty.maskwars.near","id":"THE-ROUND-ID"}');
  });

  it('signs nothing when the window closed while the sheet was open', async () => {
    // Opened at 18:23 with a minute of posting left; by the press the round seals for less than 25 minutes more.
    rounds = [open(at(18, 23)), open(at(18, 25))];
    const signed = wallet();
    await render(open(at(18, 23)));
    expect(button(/^Post with NEAR wallet$/)).toBeTruthy();
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(200);
    expect(signed).toHaveLength(0);
    expect(document.body.textContent).toContain('Today’s window just closed. Nothing was sent.');
  });

  it('says only what it saw when the wallet declines: no job reached the board', async () => {
    rounds = [open(at(18, 10))];
    const signed = wallet({ decline: true });
    await render(open(at(18, 10)));
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    // A wallet that failed may still have sent: the board is read five times before anything is said (and once before
    // the wallet was asked, for a job of that id already open).
    await settle(10_000);
    expect(signed).toHaveLength(1);
    expect(asked.filter((u) => u.startsWith('/api/jobs/race-0004-')).length).toBe(1 + 5);
    expect(document.body.textContent).toContain('No job reached the board. Your NEAR wallet shows whether anything was sent.');
    expect(document.body.textContent).not.toContain('Your job is live');
    expect(button(/^Post with NEAR wallet$/)).toBeTruthy();
  }, 20_000);

  it('runs one flow for every button of the page: a second button shows the wallet at work, never a second job', async () => {
    rounds = [open(at(18, 10))];
    const signed = wallet({ hold: 1500 });
    await render(open(at(18, 10)), true);
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(200);
    expect(button(/^Confirm in NEAR wallet$/)).toBeTruthy();
    // Escape is the wallet's while it is up: the sheet stays.
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async () => (document.querySelector('[aria-label="Close"]') as HTMLElement).click());
    await act(async () => button(/^Post this job$/)!.click());
    await settle(100);
    expect(button(/^Confirm in NEAR wallet$/)?.getAttribute('aria-disabled')).toBe('true');
    await act(async () => button(/^Confirm in NEAR wallet$/)!.click());
    await settle(3500);
    expect(signed).toHaveLength(1);
    expect(document.body.textContent).toContain('Your job is live');
  }, 15_000);

  it('lets the person start over when the wallet never answers, and an answer after that changes nothing', async () => {
    rounds = [open(at(18, 10))];
    let answer: (hash: string) => void = () => {};
    const signed: unknown[] = [];
    window.__jobsSigner = {
      accountId: 'alice.near',
      call: (_, action) => {
        signed.push(action);
        return new Promise<string>((r) => (answer = r));
      },
    };
    await render(open(at(18, 10)));
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(200);
    expect(button(/Start over/)).toBeUndefined();
    await settle(15_200);
    await act(async () => button(/^Wallet not answering\? Start over$/)!.click());
    expect(document.body.textContent).toContain('Started over. If your NEAR wallet still shows the last request, reject it there.');
    expect(button(/^Post with NEAR wallet$/)?.getAttribute('aria-disabled')).toBe('false');
    // The old wallet answers late: the sheet stays where the person is.
    await act(async () => answer('LateTx'));
    await settle(1500);
    expect(document.body.textContent).not.toContain('Your job is live');
    expect(signed).toHaveLength(1);
    // The job it signed is noted on this device: if it opens after all, its page offers it back.
    expect(JSON.parse(localStorage.getItem('maskwars.jobs.mine')!)).toHaveLength(1);
    // A new post asks for the same job: whichever request the person approves, at most one job opens.
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(200);
    expect(signed).toHaveLength(2);
    const ids = (signed as { params: { args: { id: string } } }[]).map((a) => a.params.args.id);
    expect(ids[1]).toBe(ids[0]);
  }, 25_000);

  it('after Start over, shows the job the old request opened after all, and signs nothing more; a job taken back gets a new id', async () => {
    rounds = [open(at(18, 10))];
    let answer: (hash: string) => void = () => {};
    const first: { params: { args: { id: string; reward: string; spec: string } } }[] = [];
    window.__jobsSigner = { accountId: 'alice.near', call: (_, action) => (first.push(action as never), new Promise<string>((r) => (answer = r))) };
    await render(open(at(18, 10)));
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(15_200);
    await act(async () => button(/^Wallet not answering\? Start over$/)!.click());
    // The old request is approved in the wallet after all: the job is on the board under its id.
    const { id, reward, spec } = first[0]!.params.args;
    jobs[id] = { id, client: 'alice.near', phase: 'enlisting', openedAt: at(18, 11), workUntil: at(18, 45), reward, spec, txs: { open: 'FirstTx' } };
    void answer;
    const again = wallet();
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(400);
    // The same job, already open: shown with its own transaction, and the wallet is not asked again.
    expect(again).toHaveLength(0);
    expect(document.body.textContent).toContain('Your job is live');
    expect(document.body.textContent).toContain(id);
    expect(button(/The transaction/)?.getAttribute('href')).toBe('https://nearblocks.io/txns/FirstTx');
  }, 25_000);

  it('never shows a job taken back, or of another line, as the one just posted: a new id is asked for', async () => {
    rounds = [open(at(18, 10))];
    let answer: (hash: string) => void = () => {};
    const first: { params: { args: { id: string; reward: string; spec: string } } }[] = [];
    window.__jobsSigner = { accountId: 'alice.near', call: (_, action) => (first.push(action as never), new Promise<string>((r) => (answer = r))) };
    await render(open(at(18, 10)));
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(15_200);
    await act(async () => button(/^Wallet not answering\? Start over$/)!.click());
    const { id, reward, spec } = first[0]!.params.args;
    // The old request opened the job, and the person took it back on its page.
    jobs[id] = { id, client: 'alice.near', phase: 'cancelled', openedAt: at(18, 11), workUntil: at(18, 45), reward, spec, txs: { open: 'FirstTx' } };
    void answer;
    const again = wallet();
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(1500);
    expect(again).toHaveLength(1);
    const next = (again[0]!.action.params.args as { id: string }).id;
    expect(next).not.toBe(id);
    expect(next).toMatch(/^race-0004-[a-z0-9]{6}$/);
    expect(document.body.textContent).toContain('Your job is live');
    expect(document.body.textContent).toContain(next);
  }, 25_000);

  it('never calls an earlier request’s job the one just posted when that request won the id', async () => {
    rounds = [open(at(18, 10))];
    let answer: (hash: string) => void = () => {};
    const first: { params: { args: { id: string; reward: string; spec: string } } }[] = [];
    window.__jobsSigner = { accountId: 'alice.near', call: (_, action) => (first.push(action as never), new Promise<string>((r) => (answer = r))) };
    await render(open(at(18, 10)));
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(15_200);
    await act(async () => button(/^Wallet not answering\? Start over$/)!.click());
    void answer;
    // A new line and reward, the same id. While the wallet signs it, the old request is approved and takes the id.
    await act(async () => {
      type(input('The job'), 'Drain it in ten minutes.');
      type(input('Reward'), '5');
    });
    const { id, reward, spec } = first[0]!.params.args;
    const second: { params: { args: { id: string } } }[] = [];
    window.__jobsSigner = {
      accountId: 'alice.near',
      async call(_, action) {
        second.push(action as never);
        jobs[id] = { id, client: 'alice.near', phase: 'enlisting', openedAt: at(18, 11), workUntil: at(18, 45), reward, spec, txs: { open: 'FirstTx' } };
        return 'FailedTx';
      },
    };
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(3000);
    expect(second.map((a) => a.params.args.id)).toEqual([id]);
    expect(document.body.textContent).not.toContain('Your job is live');
    expect(document.body.textContent).toContain(`Your earlier request opened ${id} first: it is on the board. This one did not open.`);
  }, 30_000);

  it('back from a wallet that took the page away, opens the sheet by itself on the job it signed', async () => {
    rounds = [open(at(18, 12))];
    const id = 'race-0004-k3x9qa';
    const spec = createHash('sha256').update('Drain the house vault in race-0004.').digest('hex');
    sessionStorage.setItem('maskwars.jobs.pending', JSON.stringify({ id, account: 'alice.near', want: { spec, reward: '1000000000000000000000000' }, at: Date.now() }));
    jobs[id] = { id, client: 'alice.near', phase: 'enlisting', openedAt: at(18, 11), workUntil: at(18, 45), reward: '1000000000000000000000000', spec, txs: { open: 'RedirectTx' } };
    const drain = drainSheet(board, MAINNET, open(at(18, 12)), MAINNET.explorer)!;
    box = document.createElement('div');
    document.body.appendChild(box);
    root = createRoot(box);
    await act(async () => root!.render(<PostJob calls={calls} drain={drain} resume className="go">Post a job</PostJob>));
    await settle(1500);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Your job is live');
    expect(button(/The transaction/)?.getAttribute('href')).toBe('https://nearblocks.io/txns/RedirectTx');
    expect(sessionStorage.getItem('maskwars.jobs.pending')).toBeNull();
  });

  it('asks the wallet for nothing when the person started over while it connected', async () => {
    rounds = [open(at(18, 10))];
    const signed = wallet();
    let connect: (s: Signer) => void = () => {};
    // A wallet that takes its time to connect (a login in another tab).
    hook.slow = new Promise<Signer>((r) => (connect = r));
    await render(open(at(18, 10)));
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(15_200);
    expect(button(/^Pick your NEAR wallet$/)).toBeTruthy();
    await act(async () => button(/^Wallet not answering\? Start over$/)!.click());
    // The login finishes after the person started over: that flow asks the wallet for nothing and notes no job.
    await act(async () => connect(window.__jobsSigner!));
    await settle(1500);
    expect(signed).toHaveLength(0);
    expect(sessionStorage.getItem('maskwars.jobs.pending')).toBeNull();
    expect(localStorage.getItem('maskwars.jobs.mine')).toBeNull();
    expect(button(/^Post with NEAR wallet$/)?.getAttribute('aria-disabled')).toBe('false');
  }, 25_000);

  it('starts afresh on the board after "See your job": the old result does not come back', async () => {
    rounds = [open(at(18, 10))];
    wallet();
    await render(open(at(18, 10)));
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(1500);
    await act(async () => button(/^See your job$/)!.click());
    await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = '';
    await render(open(at(18, 10)));
    expect(document.body.textContent).not.toContain('Your job is live');
    expect(button(/^Post with NEAR wallet$/)).toBeTruthy();
  });

  it('says so when the wallet approved after posting closed: the masks may not take the job in time', async () => {
    rounds = [open(at(18, 10))];
    wallet({ openedAt: at(18, 31) });
    await render(open(at(18, 10)));
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(1500);
    expect(document.body.textContent).toContain('Your job is live');
    expect(document.body.textContent).toContain('Your NEAR wallet approved it after today’s window closed: the masks may not take it in time.');
  });

  it('asks for a reward the arena’s masks take a job for, and reads no thousands separator, before any wallet opens', async () => {
    rounds = [open(at(18, 10))];
    const signed = wallet();
    await render(open(at(18, 10)));
    await act(async () => type(input('Reward'), '1,000'));
    expect(document.body.textContent).toContain('Write the reward as 1000 or 1.5.');
    for (const small of ['0.1', '0.49']) {
      await act(async () => type(input('Reward'), small));
      expect(document.body.textContent, small).toContain('The reward is at least 0.5 NEAR: the arena’s masks take a job from that.');
    }
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(200);
    expect(signed).toHaveLength(0);
    await act(async () => type(input('Reward'), '0.5'));
    expect(document.body.textContent).toContain('Locks 1.14 NEAR.');
  });

  it('when the arena’s masks are booked on the round, says so and asks no wallet', async () => {
    rounds = [booked(at(18, 10))];
    const signed = wallet();
    await render(booked(at(18, 10)));
    expect(document.querySelector('[role="dialog"]')?.textContent).toMatch(/Booked · next in 23:5\d:\d\d/);
    const go = button(/^Booked till 18:04 UTC$/)!;
    expect(go.getAttribute('aria-disabled')).toBe('true');
    expect(document.body.textContent).toContain('The arena’s masks are booked for today’s round.');
    await act(async () => go.click());
    await settle(200);
    expect(signed).toHaveLength(0);
  });

  it('signs nothing when the masks got booked while the sheet was open, or the account has a job with them already', async () => {
    rounds = [open(at(18, 10)), booked(at(18, 11))];
    const signed = wallet();
    await render(open(at(18, 10)));
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(200);
    expect(signed).toHaveLength(0);
    expect(document.body.textContent).toContain('The arena’s masks are booked on today’s round. Nothing was sent.');
    await act(async () => root?.unmount());
    document.body.innerHTML = '';
    forgetPostFlow();
    // The masks take one live job at a time from each account: alice.near holds one.
    rounds = [open(at(18, 12), { left: 1, full: ['alice.near'] })];
    await render(open(at(18, 12), { left: 1, full: ['alice.near'] }));
    await act(async () => button(/^Post with NEAR wallet$/)!.click());
    await settle(400);
    expect(signed).toHaveLength(0);
    expect(document.body.textContent).toContain('alice.near has a job with the arena’s masks already: they take one at a time from each account. Nothing was sent.');
  });
});
