// An outside agent's sign-up for the house's daily round, as the site files it: only a NEP-413 signature of this very
// round's message by a full-access key of an account that is on NEAR, holds enough for the round's gas and is not one of
// the arena's own; the first to come keeps its place; a round holds at most GUEST_CAP.
import { createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { agentsClosed, fillingSlot, nep413Hash, signupMessage, signupNonce } from '@maskwars/arena/guests';
import { NETWORKS } from '@maskwars/network';
import { describe, expect, it } from 'vitest';
import { chainProblems, fileSignup, GUEST_CAP, readableSlots, readSignups } from './guests';
import { memoryPicks } from './picks';

const NET = NETWORKS.testnet;
const NOW = Date.UTC(2026, 10, 12, 12, 0);
const SLOT = fillingSlot(NET, NOW);
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (b: Uint8Array) => {
  let n = BigInt(`0x${Buffer.from(b).toString('hex') || '0'}`);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
};

function agent() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const public_key = `ed25519:${b58(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12))}`;
  const signed = (account: string, slot = SLOT, network: 'testnet' | 'mainnet' = 'testnet') => {
    const m = signupMessage(network, slot, account);
    return sign(null, nep413Hash(m, signupNonce(m)), privateKey).toString('base64');
  };
  return { public_key, signed };
}

/** A chain where `accounts` hold `amount` yocto and each has its one key with `permission`. */
function chain(accounts: Record<string, { amount: string; key: string; permission: unknown }>) {
  const asked: string[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    const p = JSON.parse(String(init.body)).params as { request_type: string; account_id: string; public_key?: string };
    asked.push(`${p.request_type} ${p.account_id}`);
    const a = accounts[p.account_id];
    if (!a) return Response.json({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } });
    if (p.request_type === 'view_account') return Response.json({ result: { amount: a.amount, storage_usage: 182 } });
    if (p.public_key !== a.key) return Response.json({ error: { cause: { name: 'UNKNOWN_ACCESS_KEY' } } });
    return Response.json({ result: { nonce: 1, permission: a.permission } });
  }) as unknown as typeof fetch;
  return { f, asked };
}

const NEAR = 10n ** 24n;

describe('a sign-up for the house round', () => {
  const a = agent();
  const ok = chain({ 'agent.testnet': { amount: String(NEAR), key: a.public_key, permission: 'FullAccess' } });
  const signup = (o: Record<string, unknown> = {}) => ({ network: 'testnet', account: 'agent.testnet', public_key: a.public_key, signature: a.signed('agent.testnet'), slot: SLOT, ...o });

  it('is filed for the round sign-ups fill now, with its place', async () => {
    const store = memoryPicks();
    const filed = await fileSignup(NET, signup(), NOW, { store, fetch: ok.f });
    expect(filed).toMatchObject({ ok: true, slot: SLOT, place: 1, message: signupMessage('testnet', SLOT, 'agent.testnet') });
    expect(ok.asked).toEqual(['view_account agent.testnet', 'view_access_key agent.testnet']);
    const list = await readSignups(NET, SLOT, store);
    expect(list).toEqual([{ account: 'agent.testnet', public_key: a.public_key, signature: signup().signature, slot: SLOT, at: NOW }]);
  });

  it('signing up again keeps the first place', async () => {
    const store = memoryPicks();
    const b = agent();
    const both = chain({
      'agent.testnet': { amount: String(NEAR), key: a.public_key, permission: 'FullAccess' },
      'second.testnet': { amount: String(NEAR), key: b.public_key, permission: 'FullAccess' },
    });
    await fileSignup(NET, signup(), NOW, { store, fetch: both.f });
    const second = { network: 'testnet', account: 'second.testnet', public_key: b.public_key, signature: b.signed('second.testnet'), slot: SLOT };
    expect(await fileSignup(NET, second, NOW + 1000, { store, fetch: both.f })).toMatchObject({ ok: true, place: 2 });
    expect(await fileSignup(NET, signup(), NOW + 2000, { store, fetch: both.f })).toMatchObject({ ok: true, place: 1, at: NOW });
    expect((await readSignups(NET, SLOT, store)).map((s) => [s.account, s.at])).toEqual([
      ['agent.testnet', NOW],
      ['second.testnet', NOW + 1000],
    ]);
  });

  it('is refused for another network, another round or another account, before the chain is asked', async () => {
    const store = memoryPicks();
    const none = chain({});
    expect(await fileSignup(NET, signup({ network: 'mainnet' }), NOW, { store, fetch: none.f })).toMatchObject({ ok: false, status: 400 });
    const next = SLOT + NET.round.every_minutes * 60_000;
    expect(await fileSignup(NET, signup({ slot: next, signature: a.signed('agent.testnet', next) }), NOW, { store, fetch: none.f })).toMatchObject({ ok: false, status: 400 });
    const r = await fileSignup(NET, signup({ account: 'other.testnet' }), NOW, { store, fetch: none.f });
    expect(r.ok ? [] : r.problems[0]).toMatch(/^signature:/);
    expect(none.asked).toEqual([]);
    expect(await readSignups(NET, SLOT, store)).toEqual([]);
  });

  it('is refused for a function-call key, a key of someone else, a poor account, no account, or one of the arena', async () => {
    const store = memoryPicks();
    const why = async (accounts: Parameters<typeof chain>[0], s = signup()) => {
      const r = await fileSignup(NET, s, NOW, { store, fetch: chain(accounts).f });
      return r.ok ? 'filed' : r.problems.join('; ');
    };
    expect(await why({ 'agent.testnet': { amount: String(NEAR), key: a.public_key, permission: { FunctionCall: { receiver_id: 'x.testnet' } } } })).toMatch(/function-call key/);
    expect(await why({ 'agent.testnet': { amount: String(NEAR), key: agent().public_key, permission: 'FullAccess' } })).toMatch(/is not a key of agent.testnet/);
    expect(await why({ 'agent.testnet': { amount: String(NEAR / 100n), key: a.public_key, permission: 'FullAccess' } })).toMatch(/less than 0.05 NEAR/);
    expect(await why({})).toMatch(/is not on NEAR testnet/);
    const nova = NET.masks.NOVA!;
    expect(await why({}, signup({ account: nova, signature: a.signed(nova) }))).toMatch(/one of the arena's own/);
    expect(await readSignups(NET, SLOT, store)).toEqual([]);
  });

  it('on mainnet, whose round seats no outside agent yet, is refused with why and files nothing', async () => {
    const MAIN = NETWORKS.mainnet;
    expect(MAIN.guests.agents).toBe(0);
    const store = memoryPicks();
    const none = chain({});
    const slot = fillingSlot(MAIN, NOW);
    const r = await fileSignup(MAIN, { network: 'mainnet', account: 'agent.near', public_key: a.public_key, signature: a.signed('agent.near', slot, 'mainnet'), slot }, NOW, { store, fetch: none.f });
    expect(r).toMatchObject({ ok: false, status: 403 });
    expect(r.ok ? '' : r.problems[0]).toBe(agentsClosed(MAIN));
    expect(r.ok ? '' : r.problems[0]).toMatch(/^The house round on NEAR mainnet seats no outside agents yet: they come back with an entry stake/);
    expect(none.asked).toEqual([]);
    expect(await readSignups(MAIN, slot, store)).toEqual([]);
    expect(agentsClosed(NET)).toBeNull();
  });

  it('says the chain did not answer when no RPC does', async () => {
    const down = (async () => {
      throw new Error('down');
    }) as unknown as typeof fetch;
    expect(await fileSignup(NET, signup(), NOW, { store: memoryPicks(), fetch: down })).toMatchObject({ ok: false, status: 503 });
    await expect(chainProblems(NET, 'agent.testnet', a.public_key, down)).rejects.toThrow('no RPC answered');
  });

  it(`holds at most ${GUEST_CAP} accounts a round that the chain still backs`, async () => {
    const backed: Record<string, { amount: string; key: string; permission: unknown }> = { 'agent.testnet': { amount: String(NEAR), key: a.public_key, permission: 'FullAccess' } };
    const store = memoryPicks();
    for (let i = 0; i < GUEST_CAP; i++) {
      backed[`a${i}.testnet`] = { amount: String(NEAR), key: a.public_key, permission: 'FullAccess' };
      await store.write(`guests/v1/testnet/${SLOT}/a${i}.testnet`, JSON.stringify({ account: `a${i}.testnet`, public_key: a.public_key, slot: SLOT, at: i }));
    }
    expect(await fileSignup(NET, signup(), NOW, { store, fetch: chain(backed).f })).toMatchObject({ ok: false, status: 409 });
  });

  it('a full list makes room by dropping the sign-ups the chain no longer backs: shared NEAR keeps one place', async () => {
    const store = memoryPicks();
    // 64 accounts that once held 0.05 NEAR each in turn: now none of them does.
    for (let i = 0; i < GUEST_CAP; i++) await store.write(`guests/v1/testnet/${SLOT}/a${i}.testnet`, JSON.stringify({ account: `a${i}.testnet`, public_key: a.public_key, slot: SLOT, at: i }));
    const filed = await fileSignup(NET, signup(), NOW, { store, fetch: ok.f });
    expect(filed).toMatchObject({ ok: true, place: 1 });
    expect((await readSignups(NET, SLOT, store)).map((f) => f.account)).toEqual(['agent.testnet']);
  });

  it('is read for the round being filled and the round that just came, nothing else', () => {
    const just = SLOT + 2 * 60_000;
    expect(readableSlots(NET, just)).toEqual([SLOT + NET.round.every_minutes * 60_000, SLOT]);
  });
});
