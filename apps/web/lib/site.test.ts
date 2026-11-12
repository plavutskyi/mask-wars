import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NETWORKS, SECTIONS, type NetworkId, type Section } from '@maskwars/network';
import { describe, expect, it } from 'vitest';
import { acrossOf, acrossPath, acrossUrl, awayFor, CODE_URL, elsewhere, footerOf, footerOn, forgeStated, type JobsAnswer, jobsShown, jobsStated, linkTo, maskElsewhere, menuMore, menuOf, passkeyHost, sectionOf, siblingOf, siteOrigin, type Site } from './site';

// The rules are proved on pictures written out here, not on the network files: what is on chain where changes (one
// word in packages/network/<network>.json), the rules do not. The last block holds the real files to the same rules.

type Parts = Partial<Record<Section, boolean>>;
const parts = (on: Parts): Record<Section, boolean> => ({ arena: true, season: false, forge: false, jobs: false, ...on });
/** Both networks with the arena, and what else each has. */
const world = (mainnet: Parts, testnet: Parts): Site['networks'] => ({
  mainnet: { sections: parts(mainnet), masks: NETWORKS.mainnet.masks },
  testnet: { sections: parts(testnet), masks: NETWORKS.testnet.masks },
});

const MAIN_AT = 'https://maskwars.xyz';
const TEST_AT = 'https://testnet.maskwars.xyz';
/** The two deployments of one picture: each names the other. */
const sites = (networks: Site['networks']) => ({
  main: { network: 'mainnet', sibling: TEST_AT, networks } satisfies Site,
  test: { network: 'testnet', sibling: MAIN_AT, networks } satisfies Site,
});
const alone = (site: Site): Site => ({ ...site, sibling: null });

/** The season and the jobs market on testnet only; the forge on chain nowhere. */
const JOBS_ON_TESTNET = sites(world({}, { season: true, jobs: true }));
/** The same, the day the factory of people's masks is on testnet too. */
const FORGE_ON_TESTNET = sites(world({}, { season: true, jobs: true, forge: true }));
/** Everything on both networks. */
const ALL_ON_BOTH = sites(world({ season: true, jobs: true, forge: true }, { season: true, jobs: true, forge: true }));
/** Nothing but the arena anywhere. */
const ARENA_ONLY = sites(world({}, {}));

describe('MASKWARS_SIBLING_URL', () => {
  it('is nothing when unset, and an https origin when set', () => {
    expect(siblingOf(undefined)).toBeNull();
    expect(siblingOf('')).toBeNull();
    expect(siblingOf('  ')).toBeNull();
    expect(siblingOf('https://testnet.maskwars.xyz')).toBe('https://testnet.maskwars.xyz');
    expect(siblingOf(' https://maskwars.xyz ')).toBe('https://maskwars.xyz');
  });

  it('takes plain http only for a local run', () => {
    expect(siblingOf('http://localhost:3101')).toBe('http://localhost:3101');
    expect(siblingOf('http://127.0.0.1:3101')).toBe('http://127.0.0.1:3101');
    expect(() => siblingOf('http://testnet.maskwars.xyz')).toThrow('MASKWARS_SIBLING_URL');
    expect(() => siblingOf('http://localhost.evil.example')).toThrow('MASKWARS_SIBLING_URL');
  });

  it('stops on anything that is not an origin: a path, a slash, a query, a name without a scheme', () => {
    for (const bad of ['https://testnet.maskwars.xyz/', 'https://testnet.maskwars.xyz/forge', 'https://maskwars.xyz?x=1', 'testnet.maskwars.xyz', 'https://user@maskwars.xyz', 'javascript:alert(1)', 'ftp://maskwars.xyz']) {
      expect(() => siblingOf(bad), bad).toThrow('MASKWARS_SIBLING_URL');
    }
  });
});

describe('which part of the product a page belongs to', () => {
  it('the forge and the jobs board are parts; every other page is the same on both networks', () => {
    expect(sectionOf('/forge')).toBe('forge');
    expect(sectionOf('/jobs')).toBe('jobs');
    expect(sectionOf('/jobs/job-0007')).toBe('jobs');
    for (const p of ['/', '/league', '/race/race-0001', '/mask/nova', '/wallet', '/mcp/connect', '/hire', '/hire/embed', '/check', '/break', '/verified', '/forgery', '/jobsite']) {
      expect(sectionOf(p), p).toBeNull();
    }
  });
});

describe('a part that is on chain only on the other network', () => {
  const { main, test } = JOBS_ON_TESTNET;

  it('is a link to the same page of the other site, marked with that network', () => {
    expect(linkTo('/jobs', main)).toEqual({ href: `${TEST_AT}/jobs`, away: 'testnet' });
    expect(linkTo('/jobs/break-safe-0004', main)).toEqual({ href: `${TEST_AT}/jobs/break-safe-0004`, away: 'testnet' });
    expect(linkTo('/jobs?page=2', main)).toEqual({ href: `${TEST_AT}/jobs?page=2`, away: 'testnet' });
    expect(awayFor('jobs', main)).toBe('testnet');
    expect(awayFor('season', main)).toBe('testnet');
  });

  it('is its own page on the site that has it', () => {
    expect(linkTo('/jobs', test)).toEqual({ href: '/jobs', away: null });
    expect(awayFor('jobs', test)).toBeNull();
    expect(awayFor('season', test)).toBeNull();
  });

  it('opened on the site without it, is answered by the same page of the other site, query and all', () => {
    expect(elsewhere('/jobs', '', main)).toBe(`${TEST_AT}/jobs`);
    expect(elsewhere('/jobs/break-safe-0004', '', main)).toBe(`${TEST_AT}/jobs/break-safe-0004`);
    expect(elsewhere('/jobs', '?page=2', main)).toBe(`${TEST_AT}/jobs?page=2`);
    expect(elsewhere('/jobs', '', test)).toBeNull();
    expect(elsewhere('/jobs/break-safe-0004', '', test)).toBeNull();
  });

  it('works the same in the other direction: a part only mainnet has leads there from testnet', () => {
    const { main: m, test: t } = sites(world({ jobs: true }, {}));
    expect(linkTo('/jobs', t)).toEqual({ href: `${MAIN_AT}/jobs`, away: 'mainnet' });
    expect(elsewhere('/jobs/job-0001', '', t)).toBe(`${MAIN_AT}/jobs/job-0001`);
    expect(linkTo('/jobs', m)).toEqual({ href: '/jobs', away: null });
    expect(elsewhere('/jobs', '', m)).toBeNull();
  });

  it('holds for the forge the day its factory is on testnet', () => {
    const { main: m, test: t } = FORGE_ON_TESTNET;
    expect(linkTo('/forge', m)).toEqual({ href: `${TEST_AT}/forge`, away: 'testnet' });
    expect(linkTo('/forge?copy=kira', m)).toEqual({ href: `${TEST_AT}/forge?copy=kira`, away: 'testnet' });
    expect(elsewhere('/forge', '?copy=kira', m)).toBe(`${TEST_AT}/forge?copy=kira`);
    expect(linkTo('/forge', t)).toEqual({ href: '/forge', away: null });
    expect(elsewhere('/forge', '', t)).toBeNull();
  });
});

describe('a part that is on chain nowhere yet', () => {
  it('stays on the site that was asked: an ordinary link, and no site sends a visitor to the other for it', () => {
    for (const site of Object.values(JOBS_ON_TESTNET)) {
      expect(linkTo('/forge', site), site.network).toEqual({ href: '/forge', away: null });
      expect(elsewhere('/forge', '', site), site.network).toBeNull();
      expect(elsewhere('/forge', '?copy=kira', site), site.network).toBeNull();
      expect(awayFor('forge', site), site.network).toBeNull();
    }
    for (const site of Object.values(ARENA_ONLY)) {
      for (const p of ['/forge', '/jobs', '/jobs/job-0001']) {
        expect(linkTo(p, site), `${site.network} ${p}`).toEqual({ href: p, away: null });
        expect(elsewhere(p, '', site), `${site.network} ${p}`).toBeNull();
      }
    }
  });

  it('never sends a person’s mask anywhere either: there is no forge to look for it on', () => {
    for (const site of Object.values(JOBS_ON_TESTNET)) expect(maskElsewhere('kira', site), site.network).toBeNull();
  });
});

describe('a part that is on chain on both networks, and a page both have', () => {
  it('is each site’s own page', () => {
    for (const site of Object.values(ALL_ON_BOTH)) {
      for (const p of ['/forge', '/jobs', '/jobs/job-0001']) {
        expect(linkTo(p, site), `${site.network} ${p}`).toEqual({ href: p, away: null });
        expect(elsewhere(p, '', site), `${site.network} ${p}`).toBeNull();
      }
      expect(maskElsewhere('kira', site)).toBeNull();
    }
  });

  it('a page that belongs to no part never leaves the site, whatever is on chain where', () => {
    for (const pair of [JOBS_ON_TESTNET, FORGE_ON_TESTNET, ALL_ON_BOTH, ARENA_ONLY]) {
      for (const site of Object.values(pair)) {
        for (const p of ['/', '/league', '/wallet', '/mcp/connect', '/hire', '/check', '/break', '/race/race-0001']) {
          expect(linkTo(p, site)).toEqual({ href: p, away: null });
          expect(elsewhere(p, '', site)).toBeNull();
        }
      }
    }
  });
});

describe('a site with no sibling named', () => {
  it('keeps every link and every page here, as a single site always has', () => {
    for (const pair of [JOBS_ON_TESTNET, FORGE_ON_TESTNET, ARENA_ONLY]) {
      for (const site of Object.values(pair).map(alone)) {
        for (const p of ['/forge', '/jobs', '/jobs/job-0001', '/league']) {
          expect(linkTo(p, site)).toEqual({ href: p, away: null });
          expect(elsewhere(p, '', site)).toBeNull();
        }
        for (const part of SECTIONS) expect(awayFor(part, site)).toBeNull();
        expect(maskElsewhere('kira', site)).toBeNull();
        expect(acrossUrl('/', site)).toBeNull();
        expect(acrossOf(site)).toBeNull();
      }
    }
  });

  it('asks its factory, and shows Forge only while it is open', () => {
    const test = alone(FORGE_ON_TESTNET.test);
    expect(forgeStated(test)).toBe(false);
    expect(menuOf(false, test).map((i) => i.place)).toEqual(['league', 'jobs', 'agents', 'vault', 'near']);
    expect(menuOf(true, test).map((i) => i.place)).toEqual(['forge', 'league', 'jobs', 'agents', 'vault', 'near']);
    for (const item of menuOf(true, test)) expect(item.away).toBeNull();
  });

  it('asks its chain whether jobs run here, and until it answers keeps to what its network states', () => {
    // maskwars.xyz on mainnet alone: the arena is on chain, the jobs contract is not yet.
    const main = alone(JOBS_ON_TESTNET.main);
    expect(jobsStated(main)).toBe(false);
    expect(jobsShown(null, main)).toBe(false);
    expect(menuOf(false, main).map((i) => i.place)).toEqual(['league', 'agents', 'vault', 'near']);
    expect(jobsShown(null, alone(JOBS_ON_TESTNET.test))).toBe(true);
    expect(jobsShown(null, alone(ALL_ON_BOTH.main))).toBe(true);
    expect(menuOf(false, alone(ALL_ON_BOTH.main)).map((i) => i.place)).toEqual(['league', 'jobs', 'agents', 'vault', 'near']);
  });

  it('shows Jobs only while the chain says the jobs and crews contracts are there, whatever the network states', () => {
    // The statement says the contracts are on chain, the chain says they are not: Jobs leaves the menu.
    const test = alone(JOBS_ON_TESTNET.test);
    expect(jobsShown(false, test)).toBe(false);
    expect(menuOf(false, test, false).map((i) => i.place)).toEqual(['league', 'agents', 'vault', 'near']);
    // The contracts went on chain before the statement was changed: Jobs comes in.
    const main = alone(JOBS_ON_TESTNET.main);
    expect(jobsShown(true, main)).toBe(true);
    expect(menuOf(true, main, true).map((i) => i.place)).toEqual(['forge', 'league', 'jobs', 'agents', 'vault', 'near']);
    expect(menuOf(false, main, true).find((i) => i.place === 'jobs')).toEqual({ place: 'jobs', label: 'Jobs', href: '/jobs', away: null });
  });

  it('keeps to the statement when no RPC answers: contracts that are there are only out of reach', () => {
    expect(jobsShown('silent', alone(JOBS_ON_TESTNET.test))).toBe(true);
    expect(jobsShown('silent', alone(JOBS_ON_TESTNET.main))).toBe(false);
    expect(menuOf(false, alone(JOBS_ON_TESTNET.main), 'silent').map((i) => i.place)).toEqual(['league', 'agents', 'vault', 'near']);
  });
});

describe('the menu of two sites that know each other', () => {
  const ORDER = ['forge', 'league', 'jobs', 'agents', 'vault', 'near'];

  it('is the same items in the same order on both sites, whatever is on chain where and whatever the chain answers', () => {
    for (const pair of [JOBS_ON_TESTNET, FORGE_ON_TESTNET, ALL_ON_BOTH, ARENA_ONLY]) {
      for (const site of Object.values(pair)) {
        expect(forgeStated(site)).toBe(true);
        expect(jobsStated(site)).toBe(true);
        for (const factoryOpen of [false, true]) {
          for (const jobs of [null, 'silent', false, true] as const) expect(menuOf(factoryOpen, site, jobs).map((i) => i.place)).toEqual(ORDER);
        }
      }
      expect(menuOf(false, pair.main).map((i) => i.label)).toEqual(menuOf(false, pair.test).map((i) => i.label));
    }
  });

  it('jobs on testnet, forge nowhere: mainnet marks Jobs with testnet and links it there; Forge is its own unmarked page', () => {
    expect(menuOf(false, JOBS_ON_TESTNET.main)).toEqual([
      { place: 'forge', label: 'Forge', href: '/forge', away: null },
      { place: 'league', label: 'League', href: '/league', away: null },
      { place: 'jobs', label: 'Jobs', href: `${TEST_AT}/jobs`, away: 'testnet' },
      { place: 'agents', label: 'Agents', href: '/mcp/connect', away: null },
      { place: 'vault', label: 'Wallet', href: '/wallet', away: null },
      { place: 'near', label: 'Get NEAR', href: '/near', away: null },
    ]);
  });

  it('on the site that has every part that is on chain, nothing is marked', () => {
    for (const pair of [JOBS_ON_TESTNET, FORGE_ON_TESTNET]) {
      for (const item of menuOf(false, pair.test)) expect(item.away, item.place).toBeNull();
      expect(menuOf(false, pair.test).map((i) => i.href)).toEqual(['/forge', '/league', '/jobs', '/mcp/connect', '/wallet', '/near']);
    }
  });

  it('marks Forge too, the day its factory is on testnet', () => {
    expect(menuOf(false, FORGE_ON_TESTNET.main).filter((i) => i.away).map((i) => [i.place, i.away, i.href])).toEqual([
      ['forge', 'testnet', `${TEST_AT}/forge`],
      ['jobs', 'testnet', `${TEST_AT}/jobs`],
    ]);
  });

  it('marks nothing once every part is on both networks', () => {
    for (const site of Object.values(ALL_ON_BOTH)) for (const item of menuOf(false, site)) expect(item.away, `${site.network} ${item.place}`).toBeNull();
  });
});

describe('the footer', () => {
  const links = (site: Site, forgeOpen = false, jobs: JobsAnswer = null) => footerOf(forgeOpen, site, jobs).flatMap((g) => g.links);
  const labels = (site: Site, forgeOpen = false, jobs: JobsAnswer = null) => footerOf(forgeOpen, site, jobs).map((g) => [g.title, ...g.links.map((l) => l.label)]);
  const paths = (site: Site, forgeOpen = false, jobs: JobsAnswer = null) => links(site, forgeOpen, jobs).map((l) => l.path);

  it('names every page a visitor can open, in three short groups', () => {
    expect(labels(ALL_ON_BOTH.main)).toEqual([
      ['Play', 'The race', 'League', 'Forge', 'Jobs'],
      ['Money', 'Get NEAR', 'Swap', 'Wallet'],
      ['Agents & trust', 'Connect an agent', 'MASK CHECK', 'Hire the swarm', 'Private minds'],
    ]);
    expect(paths(ALL_ON_BOTH.main)).toEqual(['/', '/league', '/forge', '/jobs', '/near', '/swap', '/wallet', '/mcp/connect', '/check', '/hire', '/verified']);
  });

  it('every link is a page of this site that exists', () => {
    const app = fileURLToPath(new URL('../app', import.meta.url));
    for (const path of paths(ALL_ON_BOTH.main)) {
      expect(path.startsWith('/'), path).toBe(true);
      expect(existsSync(`${app}${path === '/' ? '' : path}/page.tsx`), path).toBe(true);
    }
  });

  it('has the four pages nothing else on the site leads to, on either network and on a site on its own', () => {
    for (const site of [...Object.values(JOBS_ON_TESTNET), ...Object.values(ARENA_ONLY), alone(ARENA_ONLY.main)]) {
      for (const page of ['/swap', '/check', '/hire', '/verified']) {
        expect(links(site, false, false).find((l) => l.path === page), `${site.network} ${page}`).toMatchObject({ href: page, away: null });
      }
    }
  });

  it('shows Forge and Jobs exactly while the menu shows them, and leads where the menu leads, whatever the chain answered', () => {
    const pictures = [JOBS_ON_TESTNET, FORGE_ON_TESTNET, ALL_ON_BOTH, ARENA_ONLY].flatMap((p) => [p.main, p.test, alone(p.main), alone(p.test)]);
    for (const site of pictures) {
      for (const forgeOpen of [false, true]) {
        for (const jobs of [null, true, false, 'silent'] as const) {
          const menu = menuOf(forgeOpen, site, jobs);
          const foot = links(site, forgeOpen, jobs);
          for (const place of ['forge', 'jobs'] as const) {
            const item = menu.find((i) => i.place === place) ?? null;
            const link = foot.find((l) => l.path === `/${place}`) ?? null;
            const where = `${site.network} sibling=${site.sibling} forgeOpen=${forgeOpen} jobs=${jobs} ${place}`;
            expect(link !== null, where).toBe(item !== null);
            if (item && link) expect({ href: link.href, away: link.away }, where).toEqual({ href: item.href, away: item.away });
          }
        }
      }
    }
  });

  it('a site on its own with its factory shut and no jobs contracts has neither, and both once the chain says so', () => {
    const site = alone(ARENA_ONLY.main);
    expect(labels(site, false, false)).toEqual([
      ['Play', 'The race', 'League'],
      ['Money', 'Get NEAR', 'Swap', 'Wallet'],
      ['Agents & trust', 'Connect an agent', 'MASK CHECK', 'Hire the swarm', 'Private minds'],
    ]);
    expect(paths(site, true, true).slice(0, 4)).toEqual(['/', '/league', '/forge', '/jobs']);
  });

  it('sends a part that is on chain only on the other network to the other site, as the menu does; the rest stays here', () => {
    const { main } = JOBS_ON_TESTNET;
    expect(links(main).find((l) => l.path === '/jobs')).toEqual({ label: 'Jobs', path: '/jobs', href: `${TEST_AT}/jobs`, away: 'testnet' });
    for (const l of links(main)) if (l.path !== '/jobs') expect(l, l.path).toMatchObject({ href: l.path, away: null });
  });

  it('holds on the two sites as packages/network states them: no link points at a page this network sends away unmarked', () => {
    for (const site of Object.values(sites(NETWORKS))) {
      for (const l of links(site)) {
        const away = elsewhere(l.path, '', site);
        expect(l.href, `${site.network} ${l.path}`).toBe(away ?? l.path);
        expect(l.away !== null, `${site.network} ${l.path}`).toBe(away !== null);
      }
    }
  });

  it('links the code in the public repository', () => {
    expect(CODE_URL).toBe('https://github.com/plavutskyi/mask-wars');
  });

  it('closes every page but the hire checkout’s frame and window and the lab', () => {
    for (const p of ['/', '/league', '/forge', '/jobs', '/jobs/job-0007', '/near', '/swap', '/wallet', '/mcp/connect', '/check', '/hire', '/verified', '/break', '/race/race-0002', '/mask/nova', '/contract/safe-0001.maskwars.near', '/nothing-here', '/hired', '/hire/embedded', '/laboratory']) {
      expect(footerOn(p), p).toBe(true);
    }
    for (const p of ['/hire/embed', '/hire/embed/', '/hire/prove', '/lab', '/lab/arena']) expect(footerOn(p), p).toBe(false);
  });
});

describe('the open menu’s second group', () => {
  it('is the pages the footer names and the menu has no item for', () => {
    for (const site of [...Object.values(JOBS_ON_TESTNET), ...Object.values(ALL_ON_BOTH), alone(ARENA_ONLY.main)]) {
      expect(menuMore(site), site.network).toEqual([
        { label: 'Swap', path: '/swap', href: '/swap', away: null },
        { label: 'MASK CHECK', path: '/check', href: '/check', away: null },
        { label: 'Hire the swarm', path: '/hire', href: '/hire', away: null },
        { label: 'Private minds', path: '/verified', href: '/verified', away: null },
      ]);
    }
  });

  it('with the race and the menu’s own items, reaches every page of the footer', () => {
    const site = ALL_ON_BOTH.main;
    const reached = new Set(['/', ...menuOf(true, site, true).map((i) => i.href), ...menuMore(site).map((l) => l.href)]);
    for (const l of footerOf(true, site, true).flatMap((g) => g.links)) expect(reached.has(l.href), l.path).toBe(true);
  });
});

describe('a person’s mask on the site without the forge', () => {
  it('is sent to the site where the forge is', () => {
    expect(maskElsewhere('kira', FORGE_ON_TESTNET.main)).toBe(`${TEST_AT}/mask/kira`);
    expect(maskElsewhere('kira', FORGE_ON_TESTNET.test)).toBeNull();
  });

  it('only for a name a mask can have', () => {
    for (const bad of ['ab', 'Kira', '9lives', 'a-b-c', 'x'.repeat(17), '../forge', 'kira/x']) expect(maskElsewhere(bad, FORGE_ON_TESTNET.main), bad).toBeNull();
  });
});

describe('the network switch', () => {
  it('opens the same page on the other site where both answer it', () => {
    for (const p of ['/', '/league', '/wallet', '/mcp/connect', '/check', '/break']) {
      expect(acrossUrl(p, JOBS_ON_TESTNET.main)).toBe(`${TEST_AT}${p}`);
      expect(acrossUrl(p, JOBS_ON_TESTNET.test)).toBe(`${MAIN_AT}${p}`);
    }
    // A part that is on chain nowhere is answered by both sites, each for itself.
    expect(acrossPath('/forge', JOBS_ON_TESTNET.test)).toBe('/forge');
    expect(acrossPath('/forge', JOBS_ON_TESTNET.main)).toBe('/forge');
  });

  it('leads from a race to the other arena, and from a job to the other board', () => {
    expect(acrossPath('/race/race-0001', JOBS_ON_TESTNET.main)).toBe('/');
    expect(acrossPath('/race/s1-0003-d74851', JOBS_ON_TESTNET.test)).toBe('/');
    expect(acrossPath('/jobs/job-0007', ALL_ON_BOTH.test)).toBe('/jobs');
  });

  it('keeps one of the arena’s own masks, and leads from a person’s mask to the other league', () => {
    expect(acrossPath('/mask/nova', JOBS_ON_TESTNET.main)).toBe('/mask/nova');
    expect(acrossPath('/mask/ORACLE', JOBS_ON_TESTNET.test)).toBe('/mask/oracle');
    expect(acrossPath('/mask/kira', FORGE_ON_TESTNET.test)).toBe('/league');
  });

  it('leads home from a part the other site does not have', () => {
    expect(acrossPath('/jobs', JOBS_ON_TESTNET.test)).toBe('/');
    expect(acrossPath('/jobs/break-safe-0004', JOBS_ON_TESTNET.test)).toBe('/');
    expect(acrossPath('/forge', FORGE_ON_TESTNET.test)).toBe('/');
  });

  it('never opens a page the other site would only send back, in any picture', () => {
    for (const pair of [JOBS_ON_TESTNET, FORGE_ON_TESTNET, ALL_ON_BOTH, ARENA_ONLY, sites(world({ jobs: true }, { forge: true }))]) {
      for (const site of Object.values(pair)) {
        const there: Site = site.network === 'mainnet' ? pair.test : pair.main;
        for (const p of ['/', '/forge', '/jobs', '/jobs/job-0001', '/league', '/race/race-0001', '/mask/nova', '/mask/kira', '/wallet', '/check']) {
          expect(elsewhere(acrossPath(p, site), '', there), `${site.network} ${p}`).toBeNull();
        }
      }
    }
  });
});

describe('the home page’s line about the other network', () => {
  it('on the site without the season: the daily season runs on the other network', () => {
    expect(acrossOf(JOBS_ON_TESTNET.main)).toEqual({ kind: 'season', network: 'testnet', href: `${TEST_AT}/` });
  });

  it('on the testnet site: races for real NEAR run on mainnet', () => {
    expect(acrossOf(JOBS_ON_TESTNET.test)).toEqual({ kind: 'real', network: 'mainnet', href: `${MAIN_AT}/` });
  });

  it('says nothing about a season the other network does not have, or about an arena mainnet does not have', () => {
    expect(acrossOf(ARENA_ONLY.main)).toBeNull();
    expect(acrossOf(ALL_ON_BOTH.main)).toBeNull();
    const noArena = sites({ ...world({}, { season: true }), mainnet: { sections: parts({ arena: false }), masks: NETWORKS.mainnet.masks } });
    expect(acrossOf(noArena.test)).toBeNull();
  });
});

describe('this site’s own address', () => {
  it('is APP_ORIGIN, and maskwars.xyz when it is not set or is not an origin', () => {
    expect(siteOrigin(undefined)).toBe('https://maskwars.xyz');
    expect(siteOrigin('')).toBe('https://maskwars.xyz');
    expect(siteOrigin('https://testnet.maskwars.xyz')).toBe('https://testnet.maskwars.xyz');
    expect(siteOrigin('https://testnet.maskwars.xyz/')).toBe('https://testnet.maskwars.xyz');
    expect(siteOrigin('http://localhost:3101')).toBe('http://localhost:3101');
    expect(siteOrigin('testnet.maskwars.xyz')).toBe('https://maskwars.xyz');
    expect(siteOrigin('https://maskwars.xyz/wallet')).toBe('https://maskwars.xyz');
  });
});

describe('where the vault’s passkeys work', () => {
  it('on the passkey’s own domain and on any site under it', () => {
    expect(passkeyHost('maskwars.xyz', 'maskwars.xyz')).toBe(true);
    expect(passkeyHost('testnet.maskwars.xyz', 'maskwars.xyz')).toBe(true);
    expect(passkeyHost('localhost', 'localhost')).toBe(true);
  });

  it('nowhere else: a look-alike, a parent, another site', () => {
    expect(passkeyHost('evilmaskwars.xyz', 'maskwars.xyz')).toBe(false);
    expect(passkeyHost('maskwars.xyz.evil.example', 'maskwars.xyz')).toBe(false);
    expect(passkeyHost('xyz', 'maskwars.xyz')).toBe(false);
    expect(passkeyHost('maskwars.xyz', 'testnet.maskwars.xyz')).toBe(false);
    expect(passkeyHost('mask-wars.vercel.app', 'maskwars.xyz')).toBe(false);
    expect(passkeyHost('localhost', 'maskwars.xyz')).toBe(false);
  });
});

// The two sites as the network files state them today. Nothing here names a part: whatever the files say, each site
// marks exactly the parts that are on chain only on the other network, sends their pages there, and nothing else.
describe('the two sites as packages/network states them', () => {
  const real = sites(NETWORKS);
  const PAGES: Record<'forge' | 'jobs', string[]> = { forge: ['/forge'], jobs: ['/jobs', '/jobs/job-0001'] };
  const onlyThere = (part: Section, here: NetworkId) => {
    const there = here === 'mainnet' ? 'testnet' : 'mainnet';
    return !NETWORKS[here].sections[part] && NETWORKS[there].sections[part] ? there : null;
  };

  it('each menu item is marked exactly when its part is on chain only on the other network', () => {
    for (const site of Object.values(real)) {
      const menu = menuOf(false, site);
      expect(menu.map((i) => i.place)).toEqual(['forge', 'league', 'jobs', 'agents', 'vault', 'near']);
      for (const item of menu) {
        const part = item.place === 'forge' || item.place === 'jobs' ? item.place : null;
        const away = part ? onlyThere(part, site.network) : null;
        expect(item.away, `${site.network} ${item.place}`).toBe(away);
        expect(item.href.startsWith('https://'), `${site.network} ${item.place}`).toBe(away !== null);
        if (away) expect(item.href.startsWith(site.sibling)).toBe(true);
      }
    }
  });

  it('each page of a part is sent to the other site exactly when the part is on chain only there', () => {
    for (const site of Object.values(real)) {
      for (const part of ['forge', 'jobs'] as const) {
        for (const page of PAGES[part]) {
          expect(elsewhere(page, '', site), `${site.network} ${page}`).toBe(onlyThere(part, site.network) ? `${site.sibling}${page}` : null);
        }
      }
      expect(maskElsewhere('kira', site), site.network).toBe(onlyThere('forge', site.network) ? `${site.sibling}/mask/kira` : null);
    }
  });

  it('no part is sent back and forth: a page one site sends away, the other answers', () => {
    for (const site of Object.values(real)) {
      const there = site.network === 'mainnet' ? real.test : real.main;
      for (const page of [...PAGES.forge, ...PAGES.jobs]) if (elsewhere(page, '', site)) expect(elsewhere(page, '', there), page).toBeNull();
    }
  });
});
