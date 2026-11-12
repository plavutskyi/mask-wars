// @vitest-environment happy-dom
// "Take it back" on a job's page: the client's own `cancel`, with the stand-in wallet of NEXT_PUBLIC_JOBS_TEST=1. It
// shows only on the device that posted the job, signs only from the job's client, and says "Taken back" only once the
// board reads the job as cancelled.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Signer } from './wallet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const refresh = vi.fn();
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children?: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));

const { TakeBack } = await import('./TakeBack');
const { mine } = await import('./mine');

const ID = 'race-0004-k3x9qa';
let phase = 'enlisting';
let root: Root | null = null;

function wallet(accountId: string) {
  const signed: { receiverId: string; action: Parameters<Signer['call']>[1] }[] = [];
  window.__jobsSigner = {
    accountId,
    async call(receiverId, action) {
      signed.push({ receiverId, action });
      phase = 'cancelled';
      return 'CancelTx';
    },
  };
  return signed;
}

const settle = (ms = 60) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const button = (text: RegExp) => [...document.querySelectorAll('button')].find((b) => text.test(b.textContent ?? ''));

async function render() {
  const box = document.createElement('div');
  document.body.appendChild(box);
  root = createRoot(box);
  await act(async () => root!.render(<TakeBack id={ID} client="alice.near" contract="jobs.maskwars.near" explorer="https://nearblocks.io" />));
  await settle();
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_JOBS_TEST', '1');
  localStorage.clear();
  phase = 'enlisting';
  refresh.mockClear();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(`/api/jobs/${ID}?missing=null&at=`)) return Response.json({ id: ID, client: 'alice.near', phase });
    return new Response('{}', { status: 404 });
  });
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  delete window.__jobsSigner;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('taking a job back', () => {
  it('is not offered on a device that did not post the job', async () => {
    wallet('alice.near');
    await render();
    expect(button(/Take it back/)).toBeUndefined();
  });

  it('signs the client’s `cancel` with no NEAR attached, and says so once the board reads the job as taken back', async () => {
    mine(ID);
    const signed = wallet('alice.near');
    await render();
    await act(async () => button(/^Take it back$/)!.click());
    await settle(1500);
    expect(signed).toEqual([{ receiverId: 'jobs.maskwars.near', action: { type: 'FunctionCall', params: { methodName: 'cancel', args: { id: ID }, gas: '200000000000000', deposit: '0' } } }]);
    expect(document.body.textContent).toContain('Taken back. Your NEAR is on its way to your account.');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('asks no signature from a wallet that is not the job’s client, and lets the person switch to the client’s', async () => {
    mine(ID);
    const signed = wallet('bob.near');
    await render();
    await act(async () => button(/^Take it back$/)!.click());
    await settle();
    expect(signed).toHaveLength(0);
    expect(document.body.textContent).toContain('This is bob.near: only alice.near can take this job back. Nothing was sent.');
    const right = wallet('alice.near');
    await act(async () => button(/^Use another wallet$/)!.click());
    await settle(1500);
    expect(right.map((x) => x.action.params.methodName)).toEqual(['cancel']);
    expect(document.body.textContent).toContain('Taken back.');
  });
});
