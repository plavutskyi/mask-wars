import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/site';

// Everything on the site is public and read from the chain: search engines and agents may read all of it. The lab is
// a workbench, not a page for people.
export default function robots(): MetadataRoute.Robots {
  const origin = siteOrigin();
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/lab'] }],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
