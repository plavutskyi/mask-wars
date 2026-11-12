import { llmsText } from '@/lib/llms';
import { SITE, siteOrigin } from '@/lib/site';

// /llms.txt: the site in one page for an AI that reads it. Built once: nothing in it changes between visits.
export const dynamic = 'force-static';

export function GET() {
  return new Response(llmsText(siteOrigin(), SITE.network), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}
