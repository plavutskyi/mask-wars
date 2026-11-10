import { createMcpRoute } from '@maskwars/mcp';
import { getMcp } from './feed';

// MCP for agents: Streamable HTTP at /mcp. The server lives in apps/mcp; this file only mounts it, with the config of
// this environment (./feed.ts), so the arena tools and get_race read the contracts MASKWARS_BOUNTY_CONTRACTS names, as
// the stdio server does. One feed reads the arena for the agents and for /mcp/connect: one reading in flight, the last
// good one served meanwhile. A browser that opens /mcp is sent to /mcp/connect, the page with the one command that
// plugs an agent in.
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const { config, feed } = getMcp();
const route = createMcpRoute({ config, feed, page: '/mcp/connect' });

export const GET = route.GET;
export const POST = route.POST;
export const DELETE = route.DELETE;
export const OPTIONS = route.OPTIONS;
