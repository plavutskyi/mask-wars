import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkHire, jobHash, jobIdOk, proofHash, proofMessage, proofTime, type ProofAsk, type VaultProof } from '@maskwars/hire';
import { accountOf, base64, base64url, concat, keyText, utf8, type Coin, type QuoteView } from '@maskwars/pay';

// The hire routes against 1Click and NEAR Intents in memory (PAY_FIXTURE=1), set before anything reads it.
process.env.PAY_FIXTURE = '1';

type Post = { POST: (req: Request) => Promise<Response> };
type Both = Post & { GET: (req: Request) => Promise<Response> };
const quoteRoute = () => import('./quote/route') as Promise<Post>;
const previewRoute = () => import('./preview/route') as Promise<Post>;
const proofRoute = () => import('./proof/route') as Promise<Both>;
const catalogRoute = () => import('./catalog/route') as Promise<{ GET: (req: Request) => Promise<Response> }>;

const SITE = 'https://maskwars.xyz';
const PAGE = 'https://northwind.example';
let ip = 0;
/** A request as the checkout frame sends it: same origin as the site, naming the page around it. */
function frame(path: string, o: { body?: unknown; site?: string | null; origin?: string | null; page?: string | null } = {}): Request {
  const post = o.body !== undefined;
  const headers: Record<string, string> = { 'x-real-ip': `10.1.${Math.floor(++ip / 250)}.${ip % 250}` };
  if (o.site !== null) headers['sec-fetch-site'] = o.site ?? 'same-origin';
  if (post && o.origin !== null) headers.origin = o.origin ?? SITE;
  if (post) headers['content-type'] = 'application/json';
  if (o.page !== null) headers['x-hire-page'] = o.page ?? PAGE;
  return new Request(`${SITE}/api/hire/${path}`, { method: post ? 'POST' : 'GET', headers, ...(post ? { body: JSON.stringify(o.body) } : {}) });
}

/** A payer's passkey on maskwars.xyz: its vault, and its proof for a job as the vault window makes it. */
function payer() {
  const secret = p256.utils.randomSecretKey();
  const key = p256.getPublicKey(secret, false).slice(1);
  return {
    vault: accountOf(key),
    prove(job: { text: string; target: string }, o: { page?: string | null; at?: string } = {}): VaultProof {
      const ask: ProofAsk = { text: job.text, target: job.target, page: o.page === undefined ? PAGE : o.page, at: o.at ?? proofTime() };
      const nonce = crypto.getRandomValues(new Uint8Array(32));
      const authenticatorData = concat(sha256(utf8('maskwars.xyz')), Uint8Array.of(0x05), new Uint8Array(4));
      const clientDataJSON = utf8(
        JSON.stringify({ type: 'webauthn.get', challenge: base64url(proofHash(proofMessage(ask), nonce, 'maskwars.xyz')), origin: SITE }),
      );
      const signature = p256.sign(sha256(concat(authenticatorData, sha256(clientDataJSON))), secret, { prehash: false, format: 'der' });
      return {
        kind: 'passkey',
        ask,
        nonce: base64(nonce),
        recipient: 'maskwars.xyz',
        key: keyText(key),
        authenticatorData: base64url(authenticatorData),
        clientDataJSON: base64url(clientDataJSON),
        signature: base64url(signature),
      };
    },
  };
}

const text = 'Attack my vault before launch';
const target = 'vault.acme.testnet';
const me = payer();
const job = { text, target, team: me.vault };
let usdc: Coin;
let near: Coin;

beforeAll(async () => {
  const { catalog } = await import('@/lib/pay');
  const c = await catalog();
  usdc = c.chains.find((x) => x.id === 'sol')!.coins.find((x) => x.symbol === 'USDC')!;
  near = c.near;
});

beforeEach(async () => {
  (await import('@/lib/hire')).resetBudgets();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('/api/hire/quote', () => {
  it('answers only the checkout itself: same origin, the site’s Origin', async () => {
    const { POST } = await quoteRoute();
    const b = { job, from: usdc.assetId, usd: 250, proof: me.prove(job) };
    expect((await POST(frame('quote', { body: b, site: 'cross-site' }))).status).toBe(403);
    expect((await POST(frame('quote', { body: b, origin: 'https://app.example' }))).status).toBe(403);
    expect((await POST(frame('quote', { body: b, origin: null }))).status).toBe(403);
    expect((await POST(frame('quote', { body: b, site: null }))).status).toBe(403);
  });

  it('takes only a whole job, a coin from another network and $1 to $9,999.99', async () => {
    const { POST } = await quoteRoute();
    const proof = me.prove(job);
    const bad = [
      { job: { ...job, team: 'acme.testnet' }, from: usdc.assetId, usd: 250, proof },
      { job: { ...job, text: 'hi' }, from: usdc.assetId, usd: 250, proof },
      { job: { ...job, target: 'Not An Account' }, from: usdc.assetId, usd: 250, proof },
      { job, from: 'nep141:wrap.near', usd: 250, proof },
      { job, from: usdc.assetId, usd: 0.5, proof },
      { job, from: usdc.assetId, usd: 10_000, proof },
      // One cent past the season's limit for one hire (limits.hire_usd_max of packages/network/mainnet.json).
      { job, from: usdc.assetId, usd: 250.01, proof },
      { job, from: usdc.assetId, usd: '250', proof },
    ];
    for (const b of bad) expect([b.usd, (await POST(frame('quote', { body: b }))).status]).toEqual([b.usd, 400]);
  });

  // The finding: a page named its own account as the team and the checkout handed out an address paying into it.
  it('gives no address for a vault the payer has not proved: a page can name only a vault its payer holds', async () => {
    const { POST } = await quoteRoute();
    const stranger = payer();
    const theirs = { ...job, team: stranger.vault };
    const ask = async (b: unknown) => {
      const res = await POST(frame('quote', { body: b }));
      return [res.status, ((await res.json()) as { error?: string }).error ?? 'address'];
    };
    // No proof at all.
    expect(await ask({ job: theirs, from: usdc.assetId, usd: 200 })).toEqual([403, 'proof']);
    // The payer proves their own vault, but the page's job pays into another.
    expect(await ask({ job: theirs, from: usdc.assetId, usd: 200, proof: me.prove(theirs) })).toEqual([403, 'vault']);
    // A proof made for another job, another page, or long ago.
    expect(await ask({ job, from: usdc.assetId, usd: 250, proof: me.prove({ text: 'A different job for the masks', target }) })).toEqual([403, 'proof']);
    expect(await ask({ job, from: usdc.assetId, usd: 250, proof: me.prove(job, { page: 'https://evil.example' }) })).toEqual([403, 'proof']);
    expect(await ask({ job, from: usdc.assetId, usd: 250, proof: me.prove(job, { at: proofTime(new Date(Date.now() - 31 * 60_000)) }) })).toEqual([
      403,
      'proof',
    ]);
    // The payer's own vault, proved for this job and page: an address.
    expect(await ask({ job, from: usdc.assetId, usd: 250, proof: me.prove(job) })).toEqual([200, 'address']);
  });

  it('hands out the address only for the proved vault, keeps the job’s ticket by its deposit, and passes the checkout’s read-back', async () => {
    const { POST } = await quoteRoute();
    const res = await POST(
      frame('quote', {
        body: { job: { ...job, team: ` ${me.vault.toUpperCase().replace('0X', '0x')} ` }, from: usdc.assetId, usd: 250, proof: me.prove(job) },
      }),
    );
    expect(res.status).toBe(200);
    const { quote, job: ticket } = (await res.json()) as { quote: QuoteView; job: { id: string; hash: string } };
    expect(quote).toMatchObject({
      dry: false,
      recipient: me.vault,
      recipientType: 'INTENTS',
      refundTo: me.vault,
      refundType: 'INTENTS',
      amountIn: '250000000',
    });
    expect(checkHire(quote, { job, from: usdc, near, usd: 250 })).toEqual({ ok: true });
    expect(jobIdOk(ticket.id)).toBe(true);
    expect(ticket).toMatchObject({ hash: jobHash(job), ...job });
    const { openTicket } = await import('@/lib/hire');
    expect(await openTicket(quote.depositAddress!, quote.depositMemo)).toMatchObject({
      job: ticket,
      network: 'testnet',
      usd: 250,
      page: PAGE,
      proof: 'passkey',
      quote: { depositAddress: quote.depositAddress, correlationId: quote.correlationId, closes: quote.closes },
    });
  });

  it('never hands the 1Click key back to the page', async () => {
    vi.resetModules();
    vi.stubEnv('ONE_CLICK_API_KEY', 'secret-partner-key');
    const { POST } = await quoteRoute();
    const res = await POST(frame('quote', { body: { job, from: usdc.assetId, usd: 30, proof: me.prove(job) } }));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('secret-partner-key');
  });

  it('opens with HIRE_LIVE, its own switch: PAY_LIVE for /wallet does not open hiring', async () => {
    vi.resetModules();
    vi.stubEnv('PAY_FIXTURE', '');
    vi.stubEnv('PAY_LIVE', '1');
    vi.stubEnv('HIRE_LIVE', '');
    const closed = await (await quoteRoute()).POST(frame('quote', { body: { job, from: usdc.assetId, usd: 250, proof: me.prove(job) } }));
    expect(closed.status).toBe(403);
    expect(await closed.json()).toEqual({ error: 'closed' });
    expect((await import('@/lib/hire')).hireLive).toBe(false);
    expect((await import('@/lib/pay')).live).toBe(true);

    vi.resetModules();
    vi.stubEnv('PAY_LIVE', '');
    vi.stubEnv('HIRE_LIVE', '1');
    expect((await import('@/lib/hire')).hireLive).toBe(true);
    expect((await import('@/lib/pay')).live).toBe(false);
  });

  it('takes the site’s cut through appFees only as the owner set it, and reads it back', async () => {
    vi.resetModules();
    vi.stubEnv('HIRE_FEE_BPS', '50');
    vi.stubEnv('HIRE_FEE_ACCOUNT', 'maskwars.near');
    const asked: unknown[] = [];
    const { oneClick } = await import('@/lib/pay');
    const quote = oneClick.quote.bind(oneClick);
    vi.spyOn(oneClick, 'quote').mockImplementation(async (r) => {
      asked.push(r);
      return quote(r);
    });
    const { POST } = await quoteRoute();
    expect((await POST(frame('quote', { body: { job, from: usdc.assetId, usd: 250, proof: me.prove(job) } }))).status).toBe(200);
    expect(asked[0]).toMatchObject({ appFees: [{ recipient: 'maskwars.near', fee: 50 }], recipient: me.vault, refundTo: me.vault });
    // A 1Click answer that dropped the cut, or changed it, gives no address.
    vi.spyOn(oneClick, 'quote').mockImplementation(async (r) => {
      const q = await quote(r);
      return { ...q, quoteRequest: { ...q.quoteRequest, appFees: [{ recipient: 'someone-else.near', fee: 50 }] } as typeof q.quoteRequest };
    });
    expect((await POST(frame('quote', { body: { job, from: usdc.assetId, usd: 250, proof: me.prove(job) } }))).status).toBe(422);
  });

  it('has no cut by default', async () => {
    vi.resetModules();
    const { hireFee } = await import('@/lib/hire');
    expect(hireFee).toBeNull();
  });
});

describe('/api/hire/proof', () => {
  it('reads a proof for the vault window and says whose vault it proves', async () => {
    const { POST } = await proofRoute();
    const res = await POST(frame('proof', { body: { proof: me.prove(job), job: { text, target, team: null } } }));
    expect(await res.json()).toEqual({ vault: me.vault });
    const named = await POST(frame('proof', { body: { proof: me.prove(job), job: { text, target, team: payer().vault } } }));
    expect([named.status, await named.json()]).toEqual([422, { error: 'vault' }]);
    expect((await POST(frame('proof', { body: { proof: me.prove(job), job }, site: 'cross-site' }))).status).toBe(403);
  });

  it('keeps a proof for a checkout cut off from its window under the relay id, and hands it over once', async () => {
    const { POST, GET } = await proofRoute();
    const relay = 'c'.repeat(64);
    const proof = me.prove(job);
    expect((await POST(frame('proof', { body: { proof, job: { text, target }, relay } }))).status).toBe(200);
    expect(await (await GET(frame(`proof?relay=${relay}`))).json()).toEqual({ proof, vault: me.vault });
    expect(await (await GET(frame(`proof?relay=${relay}`))).json()).toEqual({ proof: null });
    expect((await GET(frame('proof?relay=nope'))).status).toBe(400);
  });
});

describe('/api/hire/preview and the budget per page', () => {
  // The finding: any site could open checkouts unseen and spend 1Click's partner key and the RPC nodes for everyone.
  it('spends a fresh look at 1Click from the budget of the page that framed the checkout, and nothing on a shared one', async () => {
    const { POST } = await previewRoute();
    const { BUDGET, overBudget } = await import('@/lib/hire');
    const at = (usd: number, page = 'https://greedy.example') => POST(frame('preview', { body: { team: me.vault, from: usdc.assetId, usd }, page }));
    expect((await at(41)).status).toBe(200);
    // The same price again is shared: no budget is spent on it.
    for (let i = 0; i < 3; i++) expect((await at(41)).status).toBe(200);
    for (let i = 1; i < BUDGET.preview.page; i++) overBudget('preview', 'https://greedy.example');
    expect((await at(41)).status).toBe(200);
    expect((await at(42)).status).toBe(429);
    expect((await at(42, 'https://other.example')).status).toBe(200);
  });

  it('holds all pages together to one line too', async () => {
    const { BUDGET, overBudget } = await import('@/lib/hire');
    for (let i = 0; i < BUDGET.proof.all; i++) expect(overBudget('proof', `https://p${i % 50}.example`)).toBeNull();
    expect(overBudget('proof', 'https://fresh.example')?.status).toBe(429);
  });

  it('the coin list says whether hiring is open (HIRE_LIVE) and the cut, and is cached for everyone', async () => {
    const { GET } = await catalogRoute();
    const res = await GET(frame('catalog'));
    expect(await res.json()).toMatchObject({ live: true, fee: 0, max: 250 });
    expect(res.headers.get('cache-control')).toContain('s-maxage=60');
  });
});
