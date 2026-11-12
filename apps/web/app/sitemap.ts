import type { MetadataRoute } from 'next';
import { siteOrigin } from '@/lib/site';

/** The pages a person lands on, the arena first. A race's own page is reached from the arena and the league. */
const PAGES: readonly (readonly [path: string, priority: number, changes: 'hourly' | 'daily' | 'weekly'])[] = [
  ['/', 1, 'hourly'],
  ['/league', 0.9, 'daily'],
  ['/jobs', 0.9, 'hourly'],
  ['/forge', 0.8, 'weekly'],
  ['/swap', 0.8, 'weekly'],
  ['/near', 0.8, 'weekly'],
  ['/break', 0.7, 'daily'],
  ['/mask/nova', 0.7, 'daily'],
  ['/mask/onyx', 0.7, 'daily'],
  ['/mask/oracle', 0.7, 'daily'],
  ['/mcp/connect', 0.7, 'weekly'],
  ['/check', 0.6, 'weekly'],
  ['/verified', 0.5, 'daily'],
  ['/wallet', 0.5, 'weekly'],
  ['/hire', 0.5, 'weekly'],
];

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteOrigin();
  return PAGES.map(([path, priority, changeFrequency]) => ({ url: `${origin}${path === '/' ? '' : path}`, changeFrequency, priority }));
}
