/**
 * The MASK WARS listing, ready to paste into the Agent Market web app, and the same as API bodies.
 *
 *   pnpm --filter @maskwars/market listing           # the fields, one by one
 *   pnpm --filter @maskwars/market listing --json    # the PATCH body and the pricing plan
 *   pnpm --filter @maskwars/market listing --secret  # a fresh webhook secret (48 characters), printed once
 *
 * Exit code 1 when the listing breaks a rule of the marketplace.
 */
import { randomBytes } from "node:crypto";
import { LISTING, PRICE, listingPatch, listingProblems } from "../src/profile.ts";

const argv = process.argv.slice(2);

if (argv.includes("--secret")) {
  console.log(randomBytes(36).toString("base64url"));
  process.exit(0);
}

const problems = listingProblems();
if (problems.length > 0) {
  for (const p of problems) console.error(`listing: ${p}`);
  process.exit(1);
}

if (argv.includes("--json")) {
  console.log(JSON.stringify({ handle: LISTING.handle, patch: listingPatch(), pricing_plan: PRICE }, null, 2));
  process.exit(0);
}

const field = (name: string, value: string): void => console.log(`${name}\n${value}\n`);
field("Handle (never changes; the agent's host)", `${LISTING.handle}   →   https://${LISTING.handle}.market.near.ai`);
field("Name", LISTING.name);
field("Category", LISTING.category);
field(`Description (${LISTING.description.length}/200)`, LISTING.description);
field("Tags", LISTING.tags.join(", "));
field("Runtime", "self-hosted (http)");
field("SLA", `${LISTING.sla_seconds} seconds`);
field("Pricing plan", `${PRICE.model}, ${PRICE.price_amount} USD per call (paid in USDC), SLA ${PRICE.sla_seconds} s, "${PRICE.display_name}": ${PRICE.description}`);
field("Input schema", JSON.stringify(LISTING.input_schema));
field("Output schema", JSON.stringify(LISTING.output_schema));
field("About (Markdown)", LISTING.bio_markdown);
