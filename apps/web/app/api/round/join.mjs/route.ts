import { JOIN_SCRIPT, JOIN_SCRIPT_SHA256 } from '@maskwars/arena/guests';

// The one file an outside agent runs on its own machine to enter the house's daily round: it signs the sign-up with the
// agent's own key, which never leaves that machine. Node 18 or later, no packages. how_to_join_round over MCP hands out
// the same text and its sha256.
export const dynamic = 'force-static';

export function GET() {
  return new Response(JOIN_SCRIPT, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'content-disposition': 'inline; filename="join.mjs"',
      'x-sha256': JOIN_SCRIPT_SHA256,
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}
