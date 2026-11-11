import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The network the whole site reads, server and browser alike: testnet unless MASKWARS_NETWORK says mainnet. Anything
// else stops the build, so a typo never ships a site that reads testnet while its owner thinks it reads mainnet.
const network = (process.env.MASKWARS_NETWORK ?? '').trim() || 'testnet';
if (network !== 'testnet' && network !== 'mainnet') throw new Error(`MASKWARS_NETWORK: testnet or mainnet, not "${network}"`);

// The other deployment of the same site, built for the other network: its origin, or nothing. With it the menu sends a
// visitor there for the parts that are on chain only on that network (apps/web/lib/site.ts, which reads it by the same
// rule). An origin only, https unless it is a local run; anything else stops the build, so a typo never ships links
// that lead nowhere.
const sibling = (process.env.MASKWARS_SIBLING_URL ?? '').trim();
if (sibling) {
  let origin = '';
  try {
    origin = new URL(sibling).origin;
  } catch {
    /* not a URL at all */
  }
  if (origin !== sibling || !(sibling.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(sibling))) {
    throw new Error(`MASKWARS_SIBLING_URL: an https origin like https://testnet.maskwars.xyz, not "${sibling}"`);
  }
  // The two sites are two addresses. This one's own is APP_ORIGIN (maskwars.xyz when unset): canonical links and the
  // vault's API answer to it, so a second site that forgot to name itself must not ship as a copy of the first.
  const own = (process.env.APP_ORIGIN ?? '').trim().replace(/\/+$/, '') || 'https://maskwars.xyz';
  if (own === sibling) throw new Error(`MASKWARS_SIBLING_URL: the other site, not this one. This site is ${own}: set APP_ORIGIN to its own origin`);
}

// Filming only (packages/media `film`): a build whose 3D arena is stepped frame by frame goes to its own folder, so it
// never stands in for the site's build.
const film = process.env.NEXT_PUBLIC_ARENA_FILM === '1';

const config: NextConfig = {
  ...(film ? { distDir: '.next-film' } : {}),
  env: { MASKWARS_NETWORK: network, MASKWARS_SIBLING_URL: sibling },
  transpilePackages: ['@maskwars/arena', '@maskwars/brand', '@maskwars/check', '@maskwars/hire', '@maskwars/market', '@maskwars/mind', '@maskwars/network'],
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  images: { formats: ['image/avif', 'image/webp'], qualities: [75, 85] },
  // What other sites load for <mask-wars-hire>: the script and the brand's faces, readable from any page (a font, and a
  // script checked against `integrity=`, across origins need CORS) and under a strict cross-origin policy. `v1.js` is
  // kept briefly, so a fix reaches every host page within minutes; `v1.<hash>.js` never changes, so it is kept for good.
  async headers() {
    const shared = [
      { key: 'access-control-allow-origin', value: '*' },
      { key: 'cross-origin-resource-policy', value: 'cross-origin' },
      { key: 'x-content-type-options', value: 'nosniff' },
    ];
    return [
      { source: '/hire/:file(v\\d+\\.js)', headers: [...shared, { key: 'cache-control', value: 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400' }] },
      { source: '/hire/:file(v\\d+\\.[0-9a-f]{10}\\.js)', headers: [...shared, { key: 'cache-control', value: 'public, max-age=31536000, immutable' }] },
      { source: '/hire/:file([a-z-]+\\.woff2)', headers: [...shared, { key: 'cache-control', value: 'public, max-age=604800, stale-while-revalidate=2592000' }] },
    ];
  },
};

export default config;
