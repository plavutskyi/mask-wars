import { deflateRawSync } from 'node:zlib';
import type { Race } from '@maskwars/arena';
import type { MindRecord } from '@maskwars/arena/minds';
import { describe, expect, it } from 'vitest';
import { githubHarvest, lookable, memoryStore, MISS_MS, mindsReader, unzipOne } from './minds';

const NOW = Date.parse('2026-11-12T20:00:00Z');

/** A zip as GitHub serves an artifact: one entry per file, deflated or stored, a central directory and its end. */
function zip(files: Record<string, string>, deflate = true): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}

const record = (over: Partial<MindRecord> = {}): MindRecord => ({
  v: 1,
  network: 'testnet',
  race: 'race-0003',
  at: NOW - 3_600_000,
  near: { usd: 3.69, at: null },
  masks: [{ account: 'nova.tinygif8324.testnet', name: 'NOVA', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', answers: 2, billed: 2, unanswered: 0, tokens: { prompt: 32_756, completion: 20_000, cached: 16_300 }, usd: 0.0301 }],
  ...over,
});

const race = (over: Partial<Race> = {}) => ({ id: 'race-0003', official: true, kind: 'safe', phase: 'broken', openedAt: NOW - 2 * 3_600_000, ...over }) as Race;

interface Art {
  id: number;
  run: number;
  branch?: string;
  fork?: boolean;
  expired?: boolean;
  body?: Uint8Array;
}

/** GitHub's Actions API for one repository: the artifacts by name, each zip behind a short-lived link. */
function github(arts: Art[]) {
  const seen: { url: string; auth: string | null }[] = [];
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, auth: (init.headers as Record<string, string> | undefined)?.authorization ?? null });
    if (url.startsWith('https://api.github.com/repos/plavutskyi/mask-wars/actions/artifacts?')) {
      const name = new URL(url).searchParams.get('name');
      const artifacts = arts.map((a) => ({
        id: a.id,
        name,
        expired: a.expired ?? false,
        created_at: '2026-11-12T19:00:00Z',
        archive_download_url: `https://api.github.com/repos/plavutskyi/mask-wars/actions/artifacts/${a.id}/zip`,
        workflow_run: { id: a.run, head_branch: a.branch ?? 'main', repository_id: 7, head_repository_id: a.fork ? 8 : 7 },
      }));
      return new Response(JSON.stringify({ total_count: artifacts.length, artifacts }), { status: 200 });
    }
    const zipOf = /\/artifacts\/(\d+)\/zip$/.exec(url);
    if (zipOf) {
      expect(init.redirect).toBe('manual');
      return new Response(null, { status: 302, headers: { location: `https://blob.example/zip/${zipOf[1]}?sig=1` } });
    }
    const blob = /^https:\/\/blob\.example\/zip\/(\d+)/.exec(url);
    if (blob) {
      const a = arts.find((x) => x.id === Number(blob[1]));
      return a?.body ? new Response(Buffer.from(a.body), { status: 200 }) : new Response('gone', { status: 404 });
    }
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  return { fetch: f, seen };
}

describe('unzipOne', () => {
  it('reads a deflated or a stored entry by its name, and nothing else', () => {
    const text = JSON.stringify(record());
    expect(unzipOne(zip({ 'minds.json': text }), 'minds.json')).toBe(text);
    expect(unzipOne(zip({ 'other.txt': 'x', 'minds.json': text }, false), 'minds.json')).toBe(text);
    expect(unzipOne(zip({ 'other.txt': 'x' }), 'minds.json')).toBeNull();
    expect(unzipOne(new Uint8Array([1, 2, 3]), 'minds.json')).toBeNull();
  });
});

describe('githubHarvest', () => {
  it('reads minds-<race> from runs on main of the repository itself, adds the runs up, and names the first run', async () => {
    const later = record({ at: NOW - 1_800_000, masks: [{ ...record().masks[0]!, answers: 1, billed: 1, usd: 0.01 }] });
    const gh = github([
      { id: 1, run: 100, body: zip({ 'minds.json': JSON.stringify(record()) }) },
      { id: 2, run: 101, body: zip({ 'minds.json': JSON.stringify(later) }) },
      { id: 3, run: 102, fork: true, body: zip({ 'minds.json': JSON.stringify(record({ masks: [{ ...record().masks[0]!, usd: 999 }] })) }) },
      { id: 4, run: 103, branch: 'evil', body: zip({ 'minds.json': JSON.stringify(record({ masks: [{ ...record().masks[0]!, usd: 999 }] })) }) },
      { id: 5, run: 104, expired: true },
    ]);
    const got = await githubHarvest({ token: 't', fetch: gh.fetch })('race-0003');
    expect(got?.masks[0]).toMatchObject({ answers: 3, billed: 3 });
    expect(got?.masks[0]?.usd).toBeCloseTo(0.0401, 9);
    expect(got?.run).toBe('https://github.com/plavutskyi/mask-wars/actions/runs/100');
    // The token goes to GitHub's API only, never on to the zip's own link.
    expect(gh.seen.filter((s) => s.url.startsWith('https://blob.example/')).every((s) => s.auth === null)).toBe(true);
    expect(gh.seen.filter((s) => s.url.startsWith('https://api.github.com/')).every((s) => s.auth === 'Bearer t')).toBe(true);
    expect(gh.seen.some((s) => /artifacts\/(3|4|5)\/zip/.test(s.url))).toBe(false);
  });

  it("takes no record that names another race, another network, or is not one", async () => {
    const gh = github([
      { id: 1, run: 100, body: zip({ 'minds.json': JSON.stringify(record({ race: 'race-0009' })) }) },
      { id: 2, run: 101, body: zip({ 'minds.json': JSON.stringify(record({ network: 'mainnet' })) }) },
      { id: 3, run: 102, body: zip({ 'minds.json': '{"v":1}' }) },
      { id: 4, run: 103, body: zip({ 'minds.json': 'not json' }) },
    ]);
    expect(await githubHarvest({ token: 't', fetch: gh.fetch })('race-0003')).toBeNull();
  });
});

describe('mindsReader', () => {
  it('shows a kept record without asking GitHub', async () => {
    let asked = 0;
    const r = mindsReader({ store: memoryStore([record()]), harvest: async () => (asked++, null), now: () => NOW });
    expect((await r.of([race()])).get('race-0003')?.masks[0]?.name).toBe('NOVA');
    expect(asked).toBe(0);
  });

  it('asks GitHub for a finished race once, keeps what it finds, and asks again for a miss only after a while', async () => {
    const store = memoryStore();
    const asked: string[] = [];
    let t = NOW;
    const kept: Promise<void>[] = [];
    const r = mindsReader({
      store,
      harvest: async (id) => (asked.push(id), id === 'race-0003' ? record() : null),
      now: () => t,
      background: (w) => void kept.push(w),
    });
    const races = [race(), race({ id: 'race-0002' }), race({ id: 'race-0004', phase: 'sealing' }), race({ id: 'race-0005', official: false })];
    expect([...(await r.of(races)).keys()]).toEqual(['race-0003']);
    await Promise.all(kept);
    expect((await store.all()).has('race-0003')).toBe(true);
    expect(asked).toEqual(['race-0003', 'race-0002']);
    await r.of(races);
    expect(asked).toHaveLength(2);
    t += MISS_MS + 1;
    await r.of(races);
    expect(asked).toEqual(['race-0003', 'race-0002', 'race-0002']);
  });

  it("keeps GitHub's \"no record yet\" where a cold instance reads it, and asks again only after a while", async () => {
    const store = memoryStore();
    const asked: string[] = [];
    let t = NOW;
    const work: Promise<void>[] = [];
    const instance = () =>
      mindsReader({ store, harvest: async (id) => (asked.push(id), null), now: () => t, background: (w) => void work.push(w) });
    await instance().of([race()]);
    await Promise.all(work);
    expect(asked).toEqual(['race-0003']);
    expect(await store.missedAt('race-0003')).toBe(NOW);
    // Another instance, cold, a minute later: it takes the miss and asks GitHub nothing.
    t += 60_000;
    expect((await instance().of([race()])).size).toBe(0);
    expect(asked).toHaveLength(1);
    // Once the miss is old, a cold instance asks again.
    t = NOW + MISS_MS + 1;
    await instance().of([race()]);
    expect(asked).toEqual(['race-0003', 'race-0003']);
  });

  it('shows the record of a race still on its way without keeping it yet', async () => {
    const store = memoryStore();
    const kept: Promise<void>[] = [];
    const r = mindsReader({ store, harvest: async () => record(), now: () => NOW, background: (w) => void kept.push(w) });
    expect((await r.of([race({ phase: 'racing' })])).has('race-0003')).toBe(true);
    expect(kept).toHaveLength(0);
  });

  it('looks only for the arena’s own rounds past sealing within the artifacts’ 90 days', () => {
    expect(lookable(race(), NOW)).toBe(true);
    expect(lookable(race({ phase: 'sealing' }), NOW)).toBe(false);
    expect(lookable(race({ official: false }), NOW)).toBe(false);
    expect(lookable(race({ kind: 'sandbox' }), NOW)).toBe(false);
    expect(lookable(race({ openedAt: NOW - 91 * 24 * 3_600_000 }), NOW)).toBe(false);
  });
});
