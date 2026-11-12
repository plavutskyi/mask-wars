import { readFileSync } from 'node:fs';
import type { Dossier } from '@maskwars/dossier';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fresh server instance with a page already in Vercel Blob: the page DeepSeek wrote in a TEE for safe-0001 on mainnet
// (packages/dossier/test/fixtures/written). This instance shows a stored page only once its own attestation of the
// model names the page's signer. It waits a few seconds for that attestation; while it is still on its way the page
// says so and asks again, and never says there is no page.
vi.setConfig({ testTimeout: 30_000 });

const written = JSON.parse(readFileSync(new URL('../../../packages/dossier/test/fixtures/written/safe-0001.maskwars.near.page.json', import.meta.url), 'utf8'));
const SIGNER: string = written.attestation.signature.signingAddress;

const blob = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@vercel/blob', () => blob);
const attest = vi.hoisted(() => ({ verifyModel: vi.fn() }));
vi.mock('@maskwars/mind/attestation', async (original) => ({ ...(await original<object>()), verifyModel: attest.verifyModel }));
/** What the server would run after the answer. */
const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({ ...(await original<object>()), after: (fn: () => unknown) => void later.push(fn) }));

const d = { account: written.account, evidenceHash: written.evidenceHash } as Dossier;
const stored = () => ({ statusCode: 200, stream: new Response(JSON.stringify(written)).body });
const passed = () => ({ model: written.model, outcome: 'pass', checkedAt: new Date().toISOString(), nonce: 'ab'.repeat(32), nodes: [{ signer: SIGNER }] });

async function fresh() {
  vi.resetModules();
  return import('./dossier');
}

beforeEach(() => {
  vi.stubEnv('MASKWARS_NETWORK', 'mainnet');
  vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'test-token');
  vi.stubEnv('ARENA_FIXTURE', '');
  vi.stubEnv('NEARAI_CLOUD_API_KEY', '');
  vi.stubEnv('NEAR_AI_API_KEY', '');
  later.length = 0;
  blob.get.mockReset();
  attest.verifyModel.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('a stored page on a server that has just started', () => {
  it('shows on the first view when the attestation comes in within the wait', async () => {
    const { pageFor } = await fresh();
    blob.get.mockImplementation(async () => stored());
    attest.verifyModel.mockImplementation(() => new Promise((done) => setTimeout(() => done(passed()), 50)));
    const state = await pageFor(d);
    expect(state.verifying).toBe(false);
    expect(state.page?.account).toBe('safe-0001.maskwars.near');
    expect(state.page?.attestation.signature?.signingAddress).toBe(SIGNER);
    expect(attest.verifyModel).toHaveBeenCalledTimes(1);
  });

  it('says it is verifying while the attestation is still on its way, then shows the page', async () => {
    const { pageFor, ATTEST_WAIT_MS } = await fresh();
    blob.get.mockImplementation(async () => stored());
    let resolve!: (v: unknown) => void;
    attest.verifyModel.mockImplementation(() => new Promise((done) => (resolve = done)));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = pageFor(d);
    await vi.advanceTimersByTimeAsync(ATTEST_WAIT_MS);
    expect(await first).toEqual({ page: null, writing: false, verifying: true });
    vi.useRealTimers();
    // The attestation goes on after the answer and comes in: the next view shows the page, with no new attestation.
    expect(later.length).toBeGreaterThan(0);
    resolve(passed());
    await Promise.all(later.map((fn) => fn()));
    const next = await pageFor(d);
    expect(next.verifying).toBe(false);
    expect(next.page?.evidenceHash).toBe(written.evidenceHash);
    expect(attest.verifyModel).toHaveBeenCalledTimes(1);
  });

  it('does not wait when nothing is stored for these facts', async () => {
    const { pageFor } = await fresh();
    blob.get.mockImplementation(async () => null);
    expect(await pageFor(d)).toEqual({ page: null, writing: false, verifying: false });
    expect(attest.verifyModel).not.toHaveBeenCalled();
  });

  it('shows no page signed by a key its own attestation does not name', async () => {
    const { pageFor } = await fresh();
    blob.get.mockImplementation(async () => stored());
    attest.verifyModel.mockImplementation(async () => ({ ...passed(), nodes: [{ signer: '0x0000000000000000000000000000000000000001' }] }));
    expect(await pageFor(d)).toEqual({ page: null, writing: false, verifying: false });
  });
});
