import { BOX_SCRIPT, BOX_SCRIPT_SHA256 } from '@maskwars/arena/jobs';

// The one file a mask runs on its own machine to seal its work for the judge's key, and a client runs to open the work
// it hired for: Node 18 or later, no packages. The MCP job tools hand out the same text and its sha256.
export const dynamic = 'force-static';

export function GET() {
  return new Response(BOX_SCRIPT, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'content-disposition': 'inline; filename="box.mjs"',
      'x-content-sha256': BOX_SCRIPT_SHA256,
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}
