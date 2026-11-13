// MASK CHECK on Agent Market (market.near.ai), as the site takes part in it. The marketplace is the A2A server: it
// quotes the price (402), checks and holds the caller's x402 payment, and turns the call into a hire for our agent.
// The site is the agent's webhook: it works the hire and delivers the verdict.
//
// Everything here stays closed until the owner has created the agent and set the variables:
// - MARKET_API_TOKEN: the agent's `aat_…` token, shown once on the agent's page;
// - MARKET_WEBHOOK_SECRET: the signing secret beside the webhook URL, shown once;
// - MARKET_AGENT_HANDLE: the agent's handle, set once the listing is live; the page then shows the way to hire it;
// - MARKET_ORIGIN: another marketplace origin, for a test run only.
import { type CheckFn, MARKET_ORIGIN, MIN_SECRET_LENGTH, MarketClient, tokenOk } from '@maskwars/market';
import type { Limiter } from './limit';

type Env = Record<string, string | undefined>;

export interface MarketSecrets {
  token: string;
  secret: string;
  origin: string;
}

/** What is still missing before the hook can take the marketplace's events, by variable; empty when nothing is. */
export function marketNeeds(env: Env = process.env): string[] {
  const needs: string[] = [];
  const token = (env.MARKET_API_TOKEN ?? '').trim();
  const secret = (env.MARKET_WEBHOOK_SECRET ?? '').trim();
  if (!token) needs.push('MARKET_API_TOKEN: not set');
  else if (!tokenOk(token)) needs.push('MARKET_API_TOKEN: not an aat_ token');
  if (!secret) needs.push('MARKET_WEBHOOK_SECRET: not set');
  else if (secret.length < MIN_SECRET_LENGTH) needs.push(`MARKET_WEBHOOK_SECRET: shorter than ${MIN_SECRET_LENGTH} characters`);
  return needs;
}

function originOf(env: Env): string {
  return (env.MARKET_ORIGIN ?? '').trim().replace(/\/+$/, '') || MARKET_ORIGIN;
}

/** The agent's token and its webhook secret, when the owner has set both and both are well formed. */
export function marketSecrets(env: Env = process.env): MarketSecrets | null {
  if (marketNeeds(env).length > 0) return null;
  return { token: (env.MARKET_API_TOKEN as string).trim(), secret: (env.MARKET_WEBHOOK_SECRET as string).trim(), origin: originOf(env) };
}

/** A check that takes from a shared budget first, as `GET /api/check` does per instance: over it, the check is refused. */
export function budgeted(check: CheckFn, budget: Limiter): CheckFn {
  return (account, network) => {
    if (budget.take('all') !== null) return Promise.reject(new Error('too many checks right now'));
    return check(account, network);
  };
}

export interface MarketListing {
  handle: string;
  name: string;
  /** The agent's own host, where agents call it: `https://<handle>.market.near.ai`. */
  url: string;
  /** The agent's page on the marketplace, where a person reads about it and hires it: `<origin>/a/<handle>`. */
  page: string;
  /** USDC per call as the marketplace quotes it, `"0.10"`; `null` when it states no price. */
  price: string | null;
}

/** A plan's price as people read it: two decimals at least, no zeros after them. `"0.1000"` is `"0.10"`. */
export function priceText(amount: unknown): string | null {
  const m = typeof amount === 'string' ? /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(amount.trim()) : null;
  if (!m) return null;
  const text = `${BigInt(m[1] as string)}.${(m[2] ?? '').replace(/0+$/, '').padEnd(2, '0')}`;
  return Number(text) > 0 ? text : null;
}

/** What a call costs: the live per-call plan the marketplace quotes (`is_default`). No such plan, or no answer: no price. */
async function quotedPrice(client: MarketClient, agentId: string): Promise<string | null> {
  try {
    const plans: unknown = await client.pricingPlans(agentId);
    if (!Array.isArray(plans)) return null;
    const plan = plans.find((p) => p?.is_default === true && p.model === 'per_call' && p.listing_status === 'live');
    return priceText(plan?.price_amount);
  } catch {
    return null;
  }
}

export interface ListingOptions {
  env?: Env;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long the page may wait for the marketplace. Default 1.5 s. */
  timeoutMs?: number;
}

/** An answer of the marketplace is kept this long; a failure to reach it, a tenth of that. */
const FRESH_MS = 5 * 60_000;

/**
 * Reads whether the listing is live, from the marketplace itself: the agent named by MARKET_AGENT_HANDLE, published
 * under that handle, and the price of a call it quotes. Without the variable nothing is asked. Any other answer, or
 * none, is "not listed": the page shows the way to hire only while the marketplace says there is one. One reading
 * serves an instance for five minutes.
 */
export function listingReader(options: ListingOptions = {}): () => Promise<MarketListing | null> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const handle = (env.MARKET_AGENT_HANDLE ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{2,29}$/.test(handle)) return async () => null;
  const origin = originOf(env);
  const client = new MarketClient({ origin, timeoutMs: options.timeoutMs ?? 1_500, ...(options.fetch ? { fetch: options.fetch } : {}) });
  let kept: { at: number; forMs: number; value: MarketListing | null } | null = null;
  let reading: Promise<MarketListing | null> | null = null;

  const read = async (): Promise<MarketListing | null> => {
    try {
      const agent = await client.agent(handle);
      const live = agent !== null && agent.handle === handle && agent.listing_status === 'live';
      const value = live
        ? {
            handle,
            name: String(agent.name).slice(0, 80),
            url: `https://${handle}.${new URL(origin).host}`,
            page: `${origin}/a/${handle}`,
            price: await quotedPrice(client, agent.agent_id),
          }
        : null;
      kept = { at: now(), forMs: FRESH_MS, value };
      return value;
    } catch {
      kept = { at: now(), forMs: FRESH_MS / 10, value: null };
      return null;
    } finally {
      reading = null;
    }
  };

  return () => {
    if (kept && now() - kept.at < kept.forMs) return Promise.resolve(kept.value);
    reading ??= read();
    return reading;
  };
}

/** The live listing as this instance last read it. */
export const marketListing = listingReader();
