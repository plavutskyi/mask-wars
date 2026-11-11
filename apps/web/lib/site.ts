// One product on two sites. MASK WARS runs on two NEAR networks and the site is built for one of them
// (MASKWARS_NETWORK), so it is deployed twice; MASKWARS_SIBLING_URL names the other deployment. Which part of the
// product is on chain on which network is stated in packages/network/<network>.json (`sections`). From the two, this
// file answers for every page: where a link goes, which network it is marked with, and where a visitor who opens a
// page of a part that is not on this network is sent. With no sibling named, every answer is "here": one site, as before.
import { NETWORK_ID, NETWORKS, otherNetwork, whereIs, type Network, type NetworkId, type Section } from '@maskwars/network';

const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * The other deployment's origin as MASKWARS_SIBLING_URL names it: `null` when it is not set, the origin when it is one
 * (`https://testnet.maskwars.xyz`; plain http only for a local run). Anything else throws: a typo must stop the build,
 * not ship a menu whose links lead nowhere. `next.config.ts` holds the build to the same rule.
 */
export function siblingOf(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  if (v === '') return null;
  let origin = '';
  try {
    origin = new URL(v).origin;
  } catch {
    /* not a URL at all */
  }
  if (origin !== v || !(v.startsWith('https://') || LOCAL.test(v))) {
    throw new Error(`MASKWARS_SIBLING_URL: an https origin like https://testnet.maskwars.xyz, not "${v}"`);
  }
  return v;
}

/** MASKWARS_SIBLING_URL of this build. Written out in full so the site's build inlines it into the browser's code. */
function siblingFromEnv(): string | undefined {
  try {
    return process.env.MASKWARS_SIBLING_URL;
  } catch {
    return undefined;
  }
}

/** One of the two deployments: the network it is built for, where the other one lives, and what is on chain where. */
export interface Site {
  readonly network: NetworkId;
  readonly sibling: string | null;
  readonly networks: Readonly<Record<NetworkId, Pick<Network, 'sections' | 'masks'>>>;
}

/** This deployment. */
export const SITE: Site = { network: NETWORK_ID, sibling: siblingOf(siblingFromEnv()), networks: NETWORKS };

/** The part of the product a page belongs to, or `null` for a page that is the same on both networks. */
export function sectionOf(pathname: string): Section | null {
  if (pathname === '/forge') return 'forge';
  if (pathname === '/jobs' || pathname.startsWith('/jobs/')) return 'jobs';
  return null;
}

/**
 * The network a visitor has to go to for `section`: the other one when the part is on chain there and not here and
 * the other site is named; `null` when it is here, nowhere yet, or there is no other site.
 */
export function awayFor(section: Section | null, site: Site = SITE): NetworkId | null {
  if (!section || !site.sibling) return null;
  const at = whereIs(section, site.network, site.networks);
  return at !== null && at !== site.network ? at : null;
}

export interface SiteLink {
  /** A path of this site, or the full address of the same page on the other one. */
  readonly href: string;
  /** The network the link leaves for, to mark it with before the click; `null` for a page of this site. */
  readonly away: NetworkId | null;
}

/** Where a link to `path` goes on this site. */
export function linkTo(path: string, site: Site = SITE): SiteLink {
  const away = awayFor(sectionOf(path.split(/[?#]/)[0]!), site);
  return away ? { href: `${site.sibling}${path}`, away } : { href: path, away: null };
}

/**
 * Where a request for a page is sent instead of being answered here: the same page on the other site, when its part is
 * on chain only there. `null`: this site answers.
 */
export function elsewhere(pathname: string, search = '', site: Site = SITE): string | null {
  return awayFor(sectionOf(pathname), site) ? `${site.sibling}${pathname}${search}` : null;
}

/** A mask a person forged, by the name in its address: `/mask/<name>`. The arena's own masks are not people's. */
const PERSON = /^[a-z][a-z0-9]{2,15}$/;

/**
 * Where `/mask/<name>` is sent when this network knows no such mask: a person's mask lives where the forge is, so on
 * a site without the forge the same page on the other site answers. `null`: nowhere to send, the page is not found.
 */
export function maskElsewhere(name: string, site: Site = SITE): string | null {
  return PERSON.test(name) && awayFor('forge', site) ? `${site.sibling}/mask/${name}` : null;
}

/**
 * The page the network switch opens on the other site: the same page where it exists there, else the nearest one that
 * does. A race or a job is its own network's, so the switch leads to the other arena or board; a person's mask leads
 * to the other league; a part that is on chain only here leads to the other site's home.
 */
export function acrossPath(pathname: string, site: Site = SITE): string {
  const other = otherNetwork(site.network);
  const section = sectionOf(pathname);
  // A part that is here and not there: the other site would only send the visitor back.
  if (section && site.networks[site.network].sections[section] && !site.networks[other].sections[section]) return '/';
  if (pathname.startsWith('/race/')) return '/';
  if (pathname.startsWith('/jobs/')) return '/jobs';
  if (pathname.startsWith('/mask/')) {
    const name = pathname.slice('/mask/'.length).toLowerCase();
    return Object.keys(site.networks[other].masks).some((m) => m.toLowerCase() === name) ? `/mask/${name}` : '/league';
  }
  return pathname;
}

/** The other site's address for the page the switch opens from `pathname`, or `null` when there is no other site. */
export function acrossUrl(pathname: string, site: Site = SITE): string | null {
  return site.sibling ? `${site.sibling}${acrossPath(pathname, site)}` : null;
}

// ---- The menu: the same items in the same order on both sites ----

export type Place = 'race' | 'league' | 'jobs' | 'forge' | 'agents' | 'vault' | 'break';

export interface MenuItem extends SiteLink {
  readonly place: Place;
  readonly label: string;
}

const ITEMS: readonly { place: Place; path: string; label: string }[] = [
  { place: 'forge', path: '/forge', label: 'Forge' },
  { place: 'league', path: '/league', label: 'League' },
  { place: 'jobs', path: '/jobs', label: 'Jobs' },
  { place: 'agents', path: '/mcp/connect', label: 'Agents' },
  { place: 'vault', path: '/wallet', label: 'Vault' },
];

/**
 * Whether Forge is in the menu without asking the chain: two sites that know each other show one menu, so Forge is
 * always in it. Where the forge is on chain only on the other network the item leads there, marked; otherwise it is
 * this site's own page, which says itself whether its factory is open. `false`: the menu asks this network's factory,
 * as a single site always has, and shows Forge only while it is open.
 */
export function forgeStated(site: Site = SITE): boolean {
  return site.sibling !== null;
}

/**
 * Whether Jobs is in the menu. Two sites that know each other show one menu, and the item leads to wherever the board
 * is on chain. A single site shows it only while its own network has the jobs contract: the menu never leads to a
 * board that cannot open.
 */
export function jobsShown(site: Site = SITE): boolean {
  return site.sibling !== null || site.networks[site.network].sections.jobs;
}

/** The menu's items. `forgeOpen`: what this network's factory answered, for a site that has to ask (`forgeStated`). */
export function menuOf(forgeOpen: boolean, site: Site = SITE): readonly MenuItem[] {
  return ITEMS.filter((i) => (i.place !== 'forge' || forgeStated(site) || forgeOpen) && (i.place !== 'jobs' || jobsShown(site))).map((i) => ({
    place: i.place,
    label: i.label,
    ...linkTo(i.path, site),
  }));
}

// ---- The home page's one line about the other network ----

export interface Across {
  /** `season`: the daily season runs on the other network. `real`: races for real NEAR run there. */
  readonly kind: 'season' | 'real';
  readonly network: NetworkId;
  /** The other site's home. */
  readonly href: string;
}

/**
 * What the home page says about the other network between races: on a site without the season, that the daily season
 * runs on the other; on the testnet site, that races for real NEAR run on mainnet. `null`: nothing to say.
 */
export function acrossOf(site: Site = SITE): Across | null {
  if (!site.sibling) return null;
  const other = otherNetwork(site.network);
  const href = `${site.sibling}/`;
  if (awayFor('season', site)) return { kind: 'season', network: other, href };
  if (other === 'mainnet' && site.networks.mainnet.sections.arena) return { kind: 'real', network: other, href };
  return null;
}

// ---- This site's own address ----

/**
 * This deployment's own origin, for canonical addresses and cards: APP_ORIGIN (the same variable /api/pay checks a
 * page's origin against), `https://maskwars.xyz` when it is not set. Read on the server only.
 */
export function siteOrigin(env: string | undefined = process.env.APP_ORIGIN): string {
  const v = (env ?? '').trim().replace(/\/+$/, '');
  try {
    if (v && new URL(v).origin === v) return v;
  } catch {
    /* not an origin: the site's own name stands */
  }
  return 'https://maskwars.xyz';
}

/** Whether a page on `host` may use the passkeys of `rpId`: the domain itself or any name under it (WebAuthn's rule). */
export function passkeyHost(host: string, rpId: string): boolean {
  return host === rpId || host.endsWith(`.${rpId}`);
}
