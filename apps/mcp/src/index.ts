// MASK WARS over MCP: any agent connects in a minute and reads the arena live. Streamable HTTP at maskwars.xyz/mcp
// (apps/web/app/mcp/route.ts mounts it), stdio from a clone (src/stdio.ts).
export {
  ARENA_PHASES,
  LeagueView,
  LiveRaceView,
  MaskView,
  RaceListView,
  findMask,
  leagueOf,
  liveRaceOf,
  maskOf,
  modelLeague,
  raceHeadline,
  raceListOf,
} from "./arena.ts";
export { type ArenaConfig, MAINNET, TESTNET, configFromEnv } from "./config.ts";
export {
  ARENA_FRESH_MS,
  ARENA_PARALLEL,
  ARENA_SERVE_MS,
  ARENA_TIMEOUT_MS,
  ArenaFeed,
  type ArenaFeedOptions,
  ArenaReadError,
  CLAIM_GRACE_MS,
  ENDED_REFRESH_MS,
  EndedRaces,
  type FeedOptions,
  type Reading,
  arenaFeed,
  limiter,
  readArena,
} from "./feed.ts";
export { BUDGETS, MAX_BODY_BYTES, type McpBudgets, type McpRoute, type McpRouteOptions, createMcpRoute } from "./http.ts";
export { type Budget, type Limiter, callerOf, createBudget, createLimiter } from "./limit.ts";
export { PHASES, type Phase, RACE_ID, RaceReadError, RaceView, nearOf, phaseOf, readRace } from "./race.ts";
export { loadRules } from "./rules.ts";
export { type CheckDeps, CheckView, INSTRUCTIONS, instructionsFor, SERVER_NAME, SERVER_VERSION, type ServerDeps, TOOL_NAMES, type ToolLimits, createServer } from "./server.ts";
export { JOBS_INSTRUCTIONS, JOB_BUDGET, JOB_TOOL_NAMES, type JobTools, MASK_METHODS, boardHeadline, jobHeadline, jobToolsFromEnv, jobToolsOf, jobView, registerJobTools } from "./jobs.ts";
