// The site's signed MASK CHECK: what it sends OutLayer, and that it hands on an answer only when the published key
// signed exactly it. Every answer here is signed for real with ed25519, by the seed the module's own tests use (RFC 8032
// test 1) or by a forger's; OutLayer is a stand-in. The canonical verifier, services/check/verify.mjs, must agree.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BREAKER, MAX_AGE_SECONDS, SITE_RULES, STALE_RULES, TEE_DEPLOYMENT, attestationOf, canSign, createTees, isPublished, moduleAnswerOf, verifySigned } from './check-tee';
import { DEPLOYED, FORGER, NOW, PROJECT, RULES, SAMPLE, WASM, checkOf, run, signedAnswer } from './check-tee.fixtures';

/** A stand-in OutLayer that answers with `reply` to the account asked, and keeps every request it got. */
function outlayer(reply: (account: string) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return reply((JSON.parse(String(init?.body)) as { input: { account: string } }).input.account);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const tees = (o: Parameters<typeof createTees>[0] = {}) => createTees({ deployment: DEPLOYED, paymentKey: 'maskwars.near:3:secret', now: () => NOW, ...o });

describe('the signed answer from the TEE', () => {
  it('asks the published build for a signed answer, pays its price, and hands on the answer with what proves it', async () => {
    const o = outlayer(() => json(run(signedAnswer(checkOf()))));
    const t = tees({ fetch: o.fetch });
    expect(t.ready).toBe(true);
    const got = await t.ask('safe-0001.maskwars.near', 'mainnet', '198.51.100.1');
    expect(o.calls).toHaveLength(1);
    expect(o.calls[0]!.url).toBe('https://api.outlayer.ai/call/maskwars.near/check');
    expect(o.calls[0]!.init.method).toBe('POST');
    expect(o.calls[0]!.init.headers).toEqual({ 'content-type': 'application/json', 'x-payment-key': 'maskwars.near:3:secret', 'x-attached-deposit': '10000' });
    expect(JSON.parse(String(o.calls[0]!.init.body))).toEqual({ input: { account: 'safe-0001.maskwars.near', network: 'mainnet', signed: true }, version_key: WASM });
    if (!('check' in got)) throw new Error(got.why);
    expect(got.check).toEqual(checkOf());
    expect(got.tee).toMatchObject({
      signed: true,
      outlayer: 'mainnet',
      project: 'maskwars.near/check',
      requested_wasm_sha256: WASM,
      key: PROJECT.key,
      module: { version: '0.2.0', rules: RULES },
      attestation_url: 'https://api.outlayer.ai/attestations/call-1',
      call_id: 'call-1',
    });
    // Whoever gets the answer can check it again offline: the message and the signature travel with it.
    expect(verifySigned({ check: got.check, signed: { alg: 'ed25519', key: got.tee.key, message: got.tee.message, signature: got.tee.signature } }, DEPLOYED as { key: string; rules: string }, NOW).ok).toBe(true);
  });

  it('takes the key the module signs with from the same seed as the module itself', () => {
    expect(PROJECT.key).toBe(SAMPLE.output.signed.key);
  });

  it('reads the module output whether OutLayer hands it as JSON or as a string', () => {
    const module = signedAnswer(checkOf());
    expect(moduleAnswerOf(run(module))).toEqual(module);
    expect(moduleAnswerOf({ call_id: 'call-2', status: 'completed', output: JSON.stringify({ success: true, output: module, error: null }) })).toEqual(module);
    expect(moduleAnswerOf({ output: 'not json' })).toBeNull();
  });

  it.each([
    ['a forger signs with its own key and names it', () => signedAnswer(checkOf(), { by: FORGER }), 'signed by another key than the published one'],
    ['a forger names the published key over its own signature', () => signedAnswer(checkOf(), { by: FORGER, names: PROJECT.key }), 'the signature does not match the message'],
    ['the answer shows another verdict than the one signed', () => signedAnswer(checkOf(), { shown: { ...checkOf(), verdict: 'allow', reasons: [] } }), 'the answer is not what was signed'],
    ['other rules made it', () => signedAnswer(checkOf(), { rules: 'f'.repeat(64) }), 'made by other rules than the published ones'],
    ['it was read from the chain too long ago', () => signedAnswer(checkOf('safe-0001.maskwars.near', MAX_AGE_SECONDS + 60)), `read from the chain ${MAX_AGE_SECONDS + 60} s ago`],
    ['its block is from the future', () => signedAnswer(checkOf('safe-0001.maskwars.near', -600)), "the block's time is ahead of the site's clock"],
  ])('hands on nothing it cannot verify: %s', async (_case, answer, why) => {
    const o = outlayer(() => json(run(answer())));
    const got = await tees({ fetch: o.fetch }).ask('safe-0001.maskwars.near', 'mainnet', '198.51.100.2');
    expect(got).toEqual({ signed: false, why: `the TEE's answer did not verify (${why}): the site read this one itself` });
  });

  it('hands on no signed answer about another account than the one asked', async () => {
    const o = outlayer(() => json(run(signedAnswer(checkOf('intents.near')))));
    expect(await tees({ fetch: o.fetch }).ask('safe-0001.maskwars.near', 'mainnet', '198.51.100.3')).toEqual({
      signed: false,
      why: 'the TEE answered about another account: the site read this one itself',
    });
  });

  it('says why when OutLayer does not give a signed answer', async () => {
    const preview = { tier: 'preview', check: { account: 'safe-0001.maskwars.near', verdict: 'block' }, signed: null };
    const cases: [() => Response | Promise<Response>, string][] = [
      [() => json({ error: 'insufficient balance' }, 402), 'OutLayer answered HTTP 402: the site read this answer itself'],
      [() => json(run(preview)), 'the module answered preview, not signed: the site read this answer itself'],
      [() => json(run(null, { status: 'failed', output: null })), 'the run on OutLayer ended failed: the site read this answer itself'],
      [() => json({ status: 'completed', output: 'garbage' }), 'OutLayer returned no MASK CHECK answer: the site read this one itself'],
      [() => Promise.reject(new TypeError('fetch failed')), 'OutLayer could not be reached: the site read this answer itself'],
      [() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')), 'OutLayer did not answer in time: the site read this answer itself'],
    ];
    for (const [reply, why] of cases) {
      const o = outlayer(reply);
      expect(await tees({ fetch: o.fetch }).ask('safe-0001.maskwars.near', 'mainnet', '198.51.100.4'), why).toEqual({ signed: false, why });
    }
  });
});

describe('when there is nothing to sign with', () => {
  it('sends nothing until the module is published and the site holds a payment key, and says which is missing', async () => {
    const o = outlayer(() => json(run(signedAnswer(checkOf()))));
    for (const missing of ['key', 'wasm_sha256', 'rules'] as const) {
      const t = createTees({ deployment: { ...DEPLOYED, [missing]: null }, paymentKey: 'k', fetch: o.fetch });
      expect(t.ready).toBe(false);
      expect(await t.ask('intents.near', 'mainnet', 'x')).toEqual({ signed: false, why: 'MASK CHECK is not published in its TEE yet: the site read this answer itself' });
    }
    for (const paymentKey of [undefined, '', '  ']) {
      const t = createTees({ deployment: DEPLOYED, paymentKey, fetch: o.fetch });
      expect(t.ready).toBe(false);
      expect(await t.ask('intents.near', 'mainnet', 'x')).toEqual({ signed: false, why: 'the site holds no OutLayer payment key yet: it read this answer itself' });
    }
    expect(o.calls).toHaveLength(0);
  });

  it('is what the repo says today: published once the first calls record the key, on OutLayer mainnet', () => {
    expect(TEE_DEPLOYMENT).toMatchObject({ outlayer: 'mainnet', api: 'https://api.outlayer.ai', project: 'maskwars.near/check', price_usd_micro: 10_000 });
    expect(isPublished(TEE_DEPLOYMENT)).toBe(TEE_DEPLOYMENT.key !== null);
  });

  it("holds a recorded version to this checkout's rules: the shared list it carries is the one the site reads", () => {
    // SITE_RULES is the module's own answer in sample.json, which `cargo test` holds to the sources and the two lists.
    expect(SITE_RULES).toBe(SAMPLE.output.module.rules);
    expect(SITE_RULES).toMatch(/^[0-9a-f]{64}$/);
    // Nothing recorded yet: nothing to compare. Once recorded, a new safe in the list without a new version published
    // and recorded fails here (and in services/check `cargo test`), not quietly on the site.
    if (TEE_DEPLOYMENT.rules !== null) {
      expect(TEE_DEPLOYMENT.rules, 'deployment.json names a module built from another shared list: publish this build and record it (live.mjs --record)').toBe(SITE_RULES);
    }
  });

  it('pays for nothing while the published module was built from another shared list than the site reads', async () => {
    const o = outlayer(() => json(run(signedAnswer(checkOf(), { rules: 'f'.repeat(64) }))));
    const stale = { ...DEPLOYED, rules: 'f'.repeat(64) };
    expect(canSign(stale, 'k')).toBe(false);
    expect(canSign(DEPLOYED, 'k')).toBe(true);
    const t = createTees({ deployment: stale, paymentKey: 'k', fetch: o.fetch, now: () => NOW });
    expect(t.ready).toBe(false);
    expect(await t.ask('safe-0001.maskwars.near', 'mainnet', 'x')).toEqual({ signed: false, why: STALE_RULES });
    // And a site whose own rules moved on refuses the published module's answer the same way.
    const moved = createTees({ deployment: DEPLOYED, siteRules: 'e'.repeat(64), paymentKey: 'k', fetch: o.fetch, now: () => NOW });
    expect(await moved.ask('safe-0001.maskwars.near', 'mainnet', 'x')).toEqual({ signed: false, why: STALE_RULES });
    expect(o.calls).toHaveLength(0);
  });
});

describe('when OutLayer is slow, down or out of credit', () => {
  const failing = (status: number) => outlayer(() => json({ error: 'no' }, status));

  it('waits 6 s at most, and stops asking for a minute after 3 failed runs in a row or one 402', () => {
    expect(BREAKER).toEqual({ timeoutMs: 6_000, failuresToPause: 3, pauseMs: 60_000 });
  });

  it('gives up on a run that takes longer than its timeout', async () => {
    // An OutLayer that never answers: only the request's own timeout ends the wait.
    const slow = (async (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch;
    const started = Date.now();
    expect(await tees({ fetch: slow, timeoutMs: 50 }).ask('safe-0001.maskwars.near', 'mainnet', 'x')).toEqual({
      signed: false,
      why: 'OutLayer did not answer in time: the site read this answer itself',
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('asks nothing for a minute after three failed runs in a row, then tries again', async () => {
    let at = NOW;
    const o = failing(500);
    const t = tees({ fetch: o.fetch, now: () => at, perCaller: 100 });
    for (let i = 0; i < 3; i++) expect(await t.ask(`a${i}.near`, 'mainnet', 'x')).toEqual({ signed: false, why: 'OutLayer answered HTTP 500: the site read this answer itself' });
    expect(o.calls).toHaveLength(3);
    at += 1_000;
    expect(await t.ask('a3.near', 'mainnet', 'x')).toEqual({ signed: false, why: 'OutLayer failed just now, so signed answers are paused for 59 s: the site read this one itself' });
    expect(o.calls).toHaveLength(3);
    at += 59_000;
    await t.ask('a4.near', 'mainnet', 'x');
    expect(o.calls).toHaveLength(4);
  });

  it('counts failures in a row only: a signed answer between them starts the count again', async () => {
    let fail = true;
    const o = outlayer((account) => (fail ? json({}, 503) : json(run(signedAnswer(checkOf(account))))));
    const t = tees({ fetch: o.fetch, perCaller: 100 });
    for (const [account, f] of [['a.near', true], ['b.near', true], ['c.near', false], ['d.near', true], ['e.near', true]] as const) {
      fail = f;
      await t.ask(account, 'mainnet', 'x');
    }
    expect(o.calls).toHaveLength(5);
    fail = true;
    await t.ask('f.near', 'mainnet', 'x');
    expect(o.calls).toHaveLength(6);
    expect((await t.ask('g.near', 'mainnet', 'x')) as unknown).toMatchObject({ signed: false, why: expect.stringMatching(/^OutLayer failed just now/) });
    expect(o.calls).toHaveLength(6);
  });

  it('stops at once when OutLayer asks for more money (402)', async () => {
    let at = NOW;
    const o = failing(402);
    const t = tees({ fetch: o.fetch, now: () => at, perCaller: 100 });
    expect(await t.ask('a.near', 'mainnet', 'x')).toEqual({ signed: false, why: 'OutLayer answered HTTP 402: the site read this answer itself' });
    expect(await t.ask('b.near', 'mainnet', 'x')).toEqual({ signed: false, why: 'OutLayer failed just now, so signed answers are paused for 60 s: the site read this one itself' });
    at += 60_000;
    await t.ask('c.near', 'mainnet', 'x');
    expect(o.calls).toHaveLength(2);
  });

  it('keeps one instance\'s breaker to itself', async () => {
    const down = failing(402);
    await tees({ fetch: down.fetch }).ask('a.near', 'mainnet', 'x');
    const up = outlayer((account) => json(run(signedAnswer(checkOf(account)))));
    expect('check' in (await tees({ fetch: up.fetch }).ask('b.near', 'mainnet', 'x'))).toBe(true);
  });
});

describe('what OutLayer sends that the site does not expect', () => {
  it('keeps an attestation link only on the API origin over https', () => {
    const api = 'https://api.outlayer.ai';
    expect(attestationOf('/attestations/call-1', api)).toBe('https://api.outlayer.ai/attestations/call-1');
    expect(attestationOf('https://api.outlayer.ai/attestations/call-1', api)).toBe('https://api.outlayer.ai/attestations/call-1');
    for (const bad of ['http://[', 'https://evil.example/attestations/call-1', '//evil.example/a', 'http://api.outlayer.ai/attestations/call-1', 'javascript:alert(1)', 'https://api.outlayer.ai.evil.example/a', '', 7, null]) {
      expect(attestationOf(bad, api), String(bad)).toBeNull();
    }
    expect(attestationOf('/a', 'not a url')).toBeNull();
    expect(attestationOf('/a', 'http://api.outlayer.ai')).toBeNull();
  });

  it.each([
    ['a malformed attestation link', 'http://['],
    ['an attestation link on another host', 'https://evil.example/attestations/call-1'],
  ])('hands on the signed answer without %s', async (_case, link) => {
    const o = outlayer(() => json(run(signedAnswer(checkOf()), { attestation_url: link })));
    const got = await tees({ fetch: o.fetch }).ask('safe-0001.maskwars.near', 'mainnet', '198.51.100.5');
    if (!('check' in got)) throw new Error(got.why);
    expect(got.tee).toMatchObject({ signed: true, attestation_url: null, call_id: 'call-1' });
  });

  it('answers unsigned, never throws, whatever the answer holds', async () => {
    const odd = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        get status(): string {
          throw new Error('a field that cannot be read');
        },
      }),
    })) as unknown as typeof fetch;
    expect(await tees({ fetch: odd }).ask('safe-0001.maskwars.near', 'mainnet', '198.51.100.6')).toEqual({
      signed: false,
      why: "the TEE's answer could not be read: the site read this one itself",
    });
    const notJson = outlayer(() => new Response('<html>', { status: 200 }));
    expect(await tees({ fetch: notJson.fetch }).ask('safe-0001.maskwars.near', 'mainnet', '198.51.100.6')).toEqual({
      signed: false,
      why: 'OutLayer answered something that is not JSON: the site read this answer itself',
    });
  });
});

describe('what signed answers cost the site', () => {
  it('reuses a signed answer about one account for a minute, and pays again after it', async () => {
    let at = NOW;
    const o = outlayer((account) => json(run(signedAnswer(checkOf(account, (NOW - at) / 1000 + 12)))));
    const t = tees({ fetch: o.fetch, now: () => at });
    const first = await t.ask('safe-0001.maskwars.near', 'mainnet', 'caller');
    at += 30_000;
    // Within the minute: the answer already in hand, with the block and the time it was read at; no second payment.
    expect(await t.ask('safe-0001.maskwars.near', 'mainnet', 'another caller')).toEqual(first);
    expect(o.calls).toHaveLength(1);
    at += 31_000;
    const again = await t.ask('safe-0001.maskwars.near', 'mainnet', 'caller');
    expect(o.calls).toHaveLength(2);
    if (!('check' in again) || !('check' in first)) throw new Error('not signed');
    expect(again.check.block!.time).not.toBe(first.check.block!.time);
  });

  it('gives one caller a few signed answers a minute and the rest read by the site', async () => {
    const o = outlayer((account) => json(run(signedAnswer(checkOf(account)))));
    const t = tees({ fetch: o.fetch, perCaller: 2 });
    expect('check' in (await t.ask('safe-0001.maskwars.near', 'mainnet', 'caller'))).toBe(true);
    expect('check' in (await t.ask('intents.near', 'mainnet', 'caller'))).toBe(true);
    expect(await t.ask('treasury.intents.near', 'mainnet', 'caller')).toEqual({ signed: false, why: 'signed answers are paused for a moment: the site read this one itself' });
    expect('check' in (await t.ask('treasury.intents.near', 'mainnet', 'someone else'))).toBe(true);
    expect(o.calls).toHaveLength(3);
  });

  it('keeps an instance to its share of runs a minute', async () => {
    const o = outlayer((account) => json(run(signedAnswer(checkOf(account)))));
    const t = tees({ fetch: o.fetch, perMinute: 3, perCaller: 100 });
    const got = [];
    for (let i = 0; i < 5; i++) got.push(await t.ask(`a${i}.near`, 'mainnet', `ip${i}`));
    expect(o.calls).toHaveLength(3);
    expect(got.slice(3)).toEqual([0, 0].map(() => ({ signed: false, why: 'signed answers are paused for a moment: the site read this one itself' })));
  });

  it('runs no more than its share on OutLayer at once', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const o = outlayer(async () => {
      await gate;
      return json(run(signedAnswer(checkOf())));
    });
    const t = tees({ fetch: o.fetch, inFlight: 2, perCaller: 100 });
    const pending = [t.ask('safe-0001.maskwars.near', 'mainnet', 'a'), t.ask('safe-0001.maskwars.near', 'mainnet', 'b')];
    expect(await t.ask('safe-0001.maskwars.near', 'mainnet', 'c')).toEqual({ signed: false, why: 'signed answers are paused for a moment: the site read this one itself' });
    release();
    for (const p of await Promise.all(pending)) expect('check' in p).toBe(true);
  });
});

describe('the same verdict as services/check/verify.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maskwars-check-'));
  const verify = (answer: unknown, key: string, rules: string) => {
    const file = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(run(answer)));
    const script = fileURLToPath(new URL('../../../services/check/verify.mjs', import.meta.url));
    return spawnSync(process.execPath, [script, file, key, '--rules', rules], { encoding: 'utf8' }).status;
  };

  it.each([
    ['the published key over the very answer', () => signedAnswer(checkOf()), 0],
    ['a forger with its own key', () => signedAnswer(checkOf(), { by: FORGER }), 1],
    ['a forger naming the published key', () => signedAnswer(checkOf(), { by: FORGER, names: PROJECT.key }), 1],
    ['another verdict shown than signed', () => signedAnswer(checkOf(), { shown: { ...checkOf(), verdict: 'allow' } }), 1],
    ['other rules', () => signedAnswer(checkOf(), { rules: 'f'.repeat(64) }), 1],
  ])('%s', (_case, answer, exit) => {
    const a = answer();
    expect(verify(a, PROJECT.key, RULES)).toBe(exit);
    // The site's own check, without the age, which verify.mjs counts from this machine's clock.
    expect(verifySigned(a, { key: PROJECT.key, rules: RULES }, NOW).ok).toBe(exit === 0);
  });
});
