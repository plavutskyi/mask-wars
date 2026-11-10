import type { Check, ModelVerification, TeeResult } from '@maskwars/mind/attestation';
import { describe, expect, it } from 'vitest';
import { ago, createVerifier, FRESH_MS, gpuCard, modelName, notChecked, overall, reason, RETRY_MS, rows, short, utcTime } from './verified';

const ok = (id: Check['id'], detail?: string): Check => ({ id, name: id, outcome: 'pass', ...(detail ? { detail } : {}) });

const tee = (role: TeeResult['role'], over: Partial<TeeResult> = {}): TeeResult => ({
  role,
  signer: role === 'gateway' ? '0x' + 'ab'.repeat(20) : '0x' + 'cd'.repeat(20),
  tcb: 'UpToDate',
  advisories: [],
  mrtd: 'ef'.repeat(48),
  gpus: role === 'model' ? { count: 8, arch: 'HOPPER', hwmodel: 'GH100', driver: '580.95.05' } : null,
  checks: [ok('quote', 'TCB UpToDate'), ok('debug'), ok('nonce'), ok('signer'), ok('config'), ok('boot'), ...(role === 'model' ? [ok('gpu', '8 × GH100')] : [])],
  ...over,
});

function verification(over: Partial<ModelVerification> = {}): ModelVerification {
  return {
    model: 'z-ai/glm-5.3-flash',
    nonce: '3f'.repeat(32),
    checkedAt: '2026-11-08T09:41:07.000Z',
    ms: 2400,
    outcome: 'pass',
    gateway: tee('gateway'),
    nodes: [tee('model')],
    checks: [ok('report'), ok('nodes', '1 node')],
    ...over,
  };
}

describe('createVerifier', () => {
  it('shares one check between callers and keeps a pass for five minutes', async () => {
    let t = 0;
    let calls = 0;
    const verify = async (model: string) => {
      calls++;
      return verification({ model });
    };
    const v = createVerifier({ verify, now: () => t });
    const [a, b] = await Promise.all([v('m'), v('m')]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    t = FRESH_MS - 1;
    await v('m');
    expect(calls).toBe(1);
    t = FRESH_MS;
    await v('m');
    expect(calls).toBe(2);
    await v('other');
    expect(calls).toBe(3);
  });

  it('tries again after thirty seconds when a check did not pass, and never keeps a crash', async () => {
    let t = 0;
    let calls = 0;
    const v = createVerifier({
      now: () => t,
      verify: async () => {
        calls++;
        if (calls === 2) throw new Error('boom');
        return verification({ outcome: 'unavailable' });
      },
    });
    await v('m');
    t = RETRY_MS - 1;
    await v('m');
    expect(calls).toBe(1);
    t = RETRY_MS;
    await expect(v('m')).rejects.toThrow('boom');
    await v('m');
    expect(calls).toBe(3);
  });
});

describe('rows', () => {
  it('waits with the plain words while the check runs', () => {
    const r = rows(undefined);
    expect(r.map((x) => x.outcome)).toEqual(Array(6).fill('pending'));
    expect(r.map((x) => x.label)).toEqual(['Fresh nonce', 'Intel TDX', 'NVIDIA GPUs', 'Signing keys', 'Measurements', 'Gateway']);
  });

  it('a passing check reads in people words, with the real GPU count across models', () => {
    const r = rows([verification(), verification({ model: 'Qwen/Qwen3.8-27B', nodes: [tee('model'), tee('model')] })]);
    expect(r.every((x) => x.outcome === 'pass')).toBe(true);
    expect(r.find((x) => x.key === 'gpu')?.text).toBe('24 × H100 attested by NVIDIA · secure boot · debug off');
    expect(r.find((x) => x.key === 'intel')?.text).toBe('Quotes signed by Intel · TCB up to date · debug off');
  });

  it('a failed check names the model and the reason, on its own row only', () => {
    const bad = tee('model', {
      checks: [...tee('model').checks.filter((c) => c.id !== 'gpu'), { id: 'gpu', name: 'gpu', outcome: 'fail', detail: 'GPU-3: secure boot off' }],
    });
    const v = verification({ model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', nodes: [bad], outcome: 'fail' });
    const r = rows([verification(), v]);
    expect(r.find((x) => x.key === 'gpu')).toMatchObject({ outcome: 'fail', text: 'DeepSeek V4.1 Flash: GPU-3: secure boot off' });
    expect(r.filter((x) => x.outcome !== 'pass').map((x) => x.key)).toEqual(['gpu']);
    expect(overall([verification(), v])).toBe('fail');
    expect(reason(v)).toEqual({ text: 'GPU-3: secure boot off', detail: 'GPU-3: secure boot off' });
    expect(reason(verification())).toBeNull();
  });

  it('no report: every row carries the reason, nothing turns green', () => {
    const v = verification({
      gateway: null,
      nodes: [],
      outcome: 'unavailable',
      checks: [{ id: 'report', name: 'report', outcome: 'unavailable', detail: 'NEAR AI attestation report: 503' }],
    });
    const r = rows([verification(), v]);
    expect(r.every((x) => x.outcome === 'unavailable' && x.text === 'Not checked: NEAR AI did not answer')).toBe(true);
    expect(overall([verification(), v])).toBe('unavailable');
    expect(reason(v)).toEqual({ text: 'Not checked: NEAR AI did not answer', detail: 'NEAR AI attestation report: 503' });
  });

  it('says who did not answer, in plain words', () => {
    expect(notChecked('NVIDIA attestation: this network was refused (403)')).toBe("Not checked: NVIDIA refused this server's network");
    expect(notChecked('NVIDIA attestation: 503')).toBe('Not checked: NVIDIA did not answer');
    expect(notChecked('Intel collateral: no answer in time')).toBe("Not checked: Intel's certificates did not load");
    expect(notChecked(undefined)).toBe('Not checked this time');
  });
});

describe('words and numbers', () => {
  it('names models and GPUs as people know them', () => {
    expect(modelName('deepseek-ai/DeepSeek-V4.1-Flash-1017')).toBe('DeepSeek V4.1 Flash');
    expect(modelName('acme/New-Model-9B')).toBe('New-Model-9B');
    expect(gpuCard(verification())).toBe('H100');
    expect(gpuCard(undefined)).toBeNull();
  });

  it('times, ages and hashes', () => {
    expect(utcTime('2026-11-08T09:41:07.123Z')).toBe('09:41:07 UTC');
    const at = Date.parse('2026-11-08T09:41:07Z');
    expect(ago('2026-11-08T09:41:07Z', at + 20_000)).toBe('just now');
    expect(ago('2026-11-08T09:41:07Z', at + 50_000)).toBe('1 min ago');
    expect(ago('2026-11-08T09:41:07Z', at + 4 * 60_000)).toBe('4 min ago');
    expect(short('0x' + 'ab'.repeat(20))).toBe('0xabababab…ababab');
    expect(overall(undefined)).toBe('pending');
  });
});
