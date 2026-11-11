// POST /api/pick/link: one touch of a vault's passkey over a short dated line makes the person their vault's account.
// The signature is checked here, as NEAR Intents checks it; a line for another site, an old one or a forged one is
// refused, and nothing changes.
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { accountOf, base64url, challengeOf, concat, signedWebauthn, utf8 } from '@maskwars/pay';
import { describe, expect, it, vi } from 'vitest';
import { linkPayload } from '@/lib/pick';

vi.mock('@/lib/arena', () => ({ readArena: async () => ({ network: 'testnet', races: [], now: null, next: null, league: [], readAt: 0 }), asOf: () => null, pickNow: () => Date.now() }));
const { POST } = await import('./route');
const { seal, whoOf } = await import('@/lib/picks');

const secret = p256.utils.randomSecretKey();
const key = p256.getPublicKey(secret, false).slice(1);

/** What the browser's passkey gives for a line, on `origin`. */
function sign(payload: string, origin = 'https://maskwars.xyz') {
  const authenticatorData = concat(sha256(utf8('maskwars.xyz')), Uint8Array.of(0x05), new Uint8Array(4));
  const clientDataJSON = utf8(JSON.stringify({ type: 'webauthn.get', challenge: base64url(challengeOf(payload)), origin }));
  const signature = p256.sign(sha256(concat(authenticatorData, sha256(clientDataJSON))), secret, { prehash: false, format: 'der' });
  return signedWebauthn(payload, key, { authenticatorData, clientDataJSON, signature })!;
}

const send = (signed: unknown, cookie = '') =>
  POST(
    new Request('https://maskwars.xyz/api/pick/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: 'https://maskwars.xyz', 'x-real-ip': '10.1.1.1', cookie },
      body: JSON.stringify({ signed }),
    }),
  );

describe('POST /api/pick/link', () => {
  it('a passkey signature over a fresh line makes the person their vault', async () => {
    const device = 'dDEVICEDEVICEDEVICEDEV';
    const res = await send(sign(linkPayload('maskwars.xyz', Date.now())), `mw_who=${seal(device)}`);
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('mw_who='))!;
    expect(whoOf(cookie.split(';')[0]!.slice('mw_who='.length))).toBe(`a${accountOf(key)}`);
  });

  it('refuses a line for another site, an old line, a page on another origin and a forged signature', async () => {
    expect((await send(sign(linkPayload('evil.example', Date.now())))).status).toBe(401);
    expect((await send(sign(linkPayload('maskwars.xyz', Date.now() - 11 * 60_000)))).status).toBe(401);
    expect((await send(sign(linkPayload('maskwars.xyz', Date.now()), 'https://evil.example'))).status).toBe(401);
    const good = sign(linkPayload('maskwars.xyz', Date.now()));
    const other = p256.getPublicKey(p256.utils.randomSecretKey(), false).slice(1);
    const { keyText } = await import('@maskwars/pay');
    expect((await send({ ...good, public_key: keyText(other) })).status).toBe(401);
  });
});
