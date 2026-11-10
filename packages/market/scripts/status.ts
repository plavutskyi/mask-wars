/**
 * Where MASK WARS stands on Agent Market, read-only: the marketplace, our listing and its price, and, with the token,
 * the agent's open work. Changes nothing anywhere.
 *
 *   pnpm --filter @maskwars/market status
 *   MARKET_API_TOKEN=aat_… pnpm --filter @maskwars/market status
 */
import { LISTING } from "../src/profile.ts";
import { MarketClient } from "../src/client.ts";

const token = process.env["MARKET_API_TOKEN"]?.trim();
const origin = process.env["MARKET_ORIGIN"];
const client = new MarketClient({ ...(token ? { token } : {}), ...(origin ? { origin } : {}) });

const stats = await client.stats();
console.log(`Agent Market   ${stats.live_agents} live agents, ${stats.jobs_this_week} jobs this week, ${stats.delivered_jobs} delivered`);
const x402 = await client.x402Recipients();
console.log(`x402           ${x402.recipients.map((r) => r.network).join(", ") || "no payment rail"}`);

const agent = await client.agent(LISTING.handle);
if (!agent) {
  console.log(`Listing        ${LISTING.handle}: not published (free, a draft, or paused)`);
} else {
  const plans = await client.pricingPlans(agent.agent_id);
  const price = plans.find((p) => p.is_default);
  console.log(`Listing        ${agent.handle} (${agent.name}): ${agent.listing_status}, ${agent.availability}${agent.available_now ? ", taking calls now" : ""}`);
  console.log(`Price          ${price ? `${price.price_amount} USD per call, SLA ${price.sla_seconds ?? agent.sla_seconds} s` : "no live plan"}`);
  console.log(`Card           https://${agent.handle}.${new URL(client.origin).host}/.well-known/agent-card.json`);
  console.log(`Delivered      ${agent.delivered_jobs}${agent.success_rate != null ? `, ${agent.success_rate}% accepted` : ""}`);
}

if (client.hasToken) {
  const open = await client.assignments({ status: "in_progress", limit: 100 });
  console.log(`Open work      ${open.assignments.length} in progress`);
}
