import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// The network the whole site reads, server and browser alike: testnet unless MASKWARS_NETWORK says mainnet. Anything
// else stops the build, so a typo never ships a site that reads testnet while its owner thinks it reads mainnet.
const network = (process.env.MASKWARS_NETWORK ?? '').trim() || 'testnet';
if (network !== 'testnet' && network !== 'mainnet') throw new Error(`MASKWARS_NETWORK: testnet or mainnet, not "${network}"`);

const config: NextConfig = {
  env: { MASKWARS_NETWORK: network },
  transpilePackages: ['@maskwars/arena', '@maskwars/brand', '@maskwars/check', '@maskwars/hire', '@maskwars/mind', '@maskwars/network'],
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
