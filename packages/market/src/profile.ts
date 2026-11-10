// The MASK WARS listing on Agent Market: MASK CHECK, sold per call. The owner pastes these values into the web app (or
// sends them with the account's own credentials); an agent token cannot change a listing. The handle becomes the
// agent's host, `maskwars.market.near.ai`, and never changes.
import type { Category, CreatePricingPlanRequest, PatchAgentRequest } from "./api.ts";

/** At most this many accounts in one paid call. */
export const MAX_ACCOUNTS = 5;

export interface Listing {
  handle: string;
  name: string;
  category: Category;
  /** The card's tagline: at most 200 characters. */
  description: string;
  bio_markdown: string;
  /** At most 10, each 1 to 40 characters. */
  tags: string[];
  /** The window the agent commits to, seconds. */
  sla_seconds: number;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

export const LISTING: Listing = {
  handle: "maskwars",
  name: "MASK CHECK by MASK WARS",
  category: "finance",
  description:
    "Ask before your agent pays a NEAR account: allow, warn or block, with every reason read from the chain and from the MASK WARS arena, where AI masks race to break contracts. Testnet.",
  bio_markdown: [
    "**One question before a payment.** Send a NEAR account. Get `allow`, `warn` or `block`, with every reason and its evidence.",
    "",
    "MASK WARS is an arena on NEAR where AI masks race to break contracts and the contract pays the winner. A safe a mask drained there comes back `block`, with the drain's transaction.",
    "",
    "**Send** one to five NEAR testnet accounts in the message, as text or as `{\"accounts\": [\"…\"]}`.",
    "",
    "**Get back** Markdown: the verdict, a table of reasons, and one JSON block with the full answer for each account.",
    "",
    "| Signal | Level |",
    "| --- | --- |",
    "| Drained or taken over on the arena | block |",
    "| No such account: a payment cannot arrive | block |",
    "| Reported, with evidence | block or warn |",
    "| A live arena target right now | warn |",
    "| Created, or its code changed, in the last 24 h | warn |",
    "| Account age, contract code hash | info |",
    "",
    "Every chain reading is taken at one final block, named in the answer. `allow` means only that no signal against the account was found.",
    "",
    "Testnet only for now; a mainnet name (`*.near`) is refused. No model reads your message: account ids are parsed, not interpreted. If the chain cannot be read, the call is declined and you are not charged.",
  ].join("\n"),
  tags: ["near", "security", "payments", "pre-payment-check", "risk", "smart-contracts", "agents", "testnet", "mask-wars"],
  sla_seconds: 300,
  input_schema: {
    type: "object",
    description: "The message text: one to five NEAR testnet account ids, plain or as this object.",
    required: ["accounts"],
    properties: {
      accounts: {
        type: "array",
        minItems: 1,
        maxItems: MAX_ACCOUNTS,
        items: { type: "string", description: "A named testnet account (`*.testnet`) or an implicit one." },
      },
    },
  },
  output_schema: {
    type: "object",
    description: "The JSON block at the end of the Markdown answer.",
    required: ["network", "verdict", "results"],
    properties: {
      network: { const: "testnet" },
      verdict: { enum: ["allow", "warn", "block"], description: "The strongest answer of all accounts." },
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["account", "verdict", "summary", "reasons", "block", "checked_at"],
          properties: {
            account: { type: "string" },
            verdict: { enum: ["allow", "warn", "block"] },
            summary: { type: "string" },
            reasons: {
              type: "array",
              items: {
                type: "object",
                required: ["code", "level", "text"],
                properties: {
                  code: { type: "string" },
                  level: { enum: ["block", "warn", "info"] },
                  text: { type: "string" },
                  evidence: { type: "object" },
                },
              },
            },
            block: {
              type: ["object", "null"],
              description: "The final block every reading was taken at.",
              properties: { height: { type: "integer" }, hash: { type: "string" }, time: { type: "string" } },
            },
            checked_at: { type: "string" },
          },
        },
      },
      refused: {
        type: "array",
        description: "Inputs that were not checked, and why.",
        items: { type: "object", properties: { input: { type: "string" }, why: { type: "string" } } },
      },
    },
  },
};

/** The default plan: what the x402 challenge quotes. USD per call, paid 1:1 in USDC. */
export const PRICE: CreatePricingPlanRequest = {
  model: "per_call",
  price_amount: "0.10",
  display_name: "One check",
  description: `Up to ${MAX_ACCOUNTS} NEAR testnet accounts in one call.`,
  sla_seconds: 300,
};

/** The listing as a `PATCH /v1/agents/{agent_id}` body. The handle is set once, at creation, and is never patched. */
export function listingPatch(listing: Listing = LISTING): PatchAgentRequest {
  const { handle: _handle, ...rest } = listing;
  return rest;
}

/** What the API would refuse in this listing and plan, in words; empty when it is fine. */
export function listingProblems(listing: Listing = LISTING, price: CreatePricingPlanRequest = PRICE): string[] {
  const out: string[] = [];
  const h = listing.handle;
  if (!/^[a-z][a-z0-9-]{2,29}$/.test(h) || h.endsWith("-") || h.slice(2, 4) === "--") {
    out.push(`handle ${h}: 3 to 30 characters, a lowercase letter first, then lowercase letters, digits and -, no trailing -, no -- at positions 3 and 4`);
  }
  const name = listing.name.trim();
  if (name.length === 0 || name.length > 80) out.push(`name: 1 to 80 characters, not ${name.length}`);
  const description = listing.description.trim();
  if (description.length === 0 || description.length > 200) out.push(`description: 1 to 200 characters, not ${description.length}`);
  if (listing.tags.length > 10) out.push(`tags: at most 10, not ${listing.tags.length}`);
  for (const t of listing.tags) if (t.trim().length < 1 || t.trim().length > 40) out.push(`tag "${t}": 1 to 40 characters`);
  if (new Set(listing.tags).size !== listing.tags.length) out.push("tags: duplicates");
  if (!Number.isInteger(listing.sla_seconds) || listing.sla_seconds < 1 || listing.sla_seconds > 2_592_000) {
    out.push("sla_seconds: 1 second to 30 days");
  }
  if (!/^\d+(\.\d{1,6})?$/.test(price.price_amount) || Number(price.price_amount) <= 0) {
    out.push(`price ${price.price_amount}: a positive decimal string, at most 6 decimals`);
  }
  if (price.sla_seconds !== undefined && (price.sla_seconds < 1 || price.sla_seconds > 2_592_000)) out.push("plan sla_seconds: 1 second to 30 days");
  return out;
}
