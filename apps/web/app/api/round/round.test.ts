// The three routes of an outside agent entering the house's round: join.mjs is the script MCP names, byte for byte; a
// sign-up the chain backs is filed and listed for the house; the list is read only for the round sign-ups fill and the
// round the house is opening.
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { fillingSlot, JOIN_SCRIPT, JOIN_SCRIPT_SHA256, nep413Hash, signupMessage, signupNonce } from '@maskwars/arena/guests';
import { NET } from '@maskwars/network';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetGuests } from '@/lib/guests';
import { GET as guests } from './guests/route';
import { POST as join } from './join/route';
import { GET as script } from './join.mjs/route';

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

const post = (body: unknown, ip = '10.0.0.1') =>
  new Request('https://maskwars.xyz/api/round/join', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip }, body: JSON.stringify(body) });

describe('/api/round/join.mjs', () => {
  it('serves the very script MCP hands out, with its sha256', async () => {
    const res = script();
    const text = await res.text();
    expect(text).toBe(JOIN_SCRIPT);
    expect(res.headers.get('x-sha256')).toBe(JOIN_SCRIPT_SHA256);
    expect(createHash('sha256').update(text).digest('hex')).toBe(JOIN_SCRIPT_SHA256);
  });
});

describe('/api/round/join and /api/round/guests', () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const public_key = `ed25519:${b58(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12))}`;
  const account = NET.id === 'mainnet' ? 'agent.near' : 'agent.testnet';

  beforeEach(() => {
    forgetGuests();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const p = JSON.parse(String(init.body)).params as { request_type: string; account_id: string };
      if (p.account_id !== account) return Response.json({ error: { cause: { name: 'UNKNOWN_ACCOUNT' } } });
      if (p.request_type === 'view_account') return Response.json({ result: { amount: String(10n ** 24n), storage_usage: 182 } });
      return Response.json({ result: { nonce: 1, permission: 'FullAccess' } });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('files a signed sign-up and lists it for the house with its signature', async () => {
    const slot = fillingSlot(NET, Date.now());
    const m = signupMessage(NET.id, slot, account);
    const signature = sign(null, nep413Hash(m, signupNonce(m)), privateKey).toString('base64');
    const res = await join(post({ network: NET.id, account, public_key, signature, slot }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, slot, place: 1, message: m });
    const list = await guests(new Request('https://maskwars.xyz/api/round/guests', { headers: { 'x-real-ip': '10.0.0.2' } }));
    const got = (await list.json()) as { slot: number; agents: number; signups: { account: string; signature: string }[] };
    expect(got.slot).toBe(slot);
    expect(got.agents).toBe(NET.guests.agents);
    expect(got.signups.map((s) => [s.account, s.signature])).toEqual([[account, signature]]);
  });

  it('refuses a body that is not a sign-up, and a round nobody can sign up for now', async () => {
    const res = await join(new Request('https://maskwars.xyz/api/round/join', { method: 'POST', headers: { 'content-type': 'text/plain', 'x-real-ip': '10.0.0.3' }, body: 'hi' }));
    expect(res.status).toBe(400);
    const old = await guests(new Request('https://maskwars.xyz/api/round/guests?slot=0', { headers: { 'x-real-ip': '10.0.0.4' } }));
    expect(old.status).toBe(400);
  });
});
