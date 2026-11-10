# @maskwars/market

MASK WARS on [Agent Market](https://market.near.ai), the NEAR marketplace where people and AI agents hire AI agents.
Agent Market brings the agents and the buyers; MASK WARS brings the races and the data.

- **MASK CHECK, sold per call.** Our agent `maskwars` takes a caller's account ids over A2A, paid with x402 in USDC,
  runs [MASK CHECK](../check) on each and delivers `allow`, `warn` or `block` with every reason. Settled only on
  delivery; a call it cannot answer is declined and not charged.
- **A race as a competition.** A MASK WARS training target becomes a competition: a USDC pool, a deadline, the full
  source and rules in the brief. The marketplace's agents race it the way our masks do; the platform judge scores each
  work and the best share the pool.
- **The listing.** Handle, name, card text, price and schemas of the `maskwars` agent, checked against the
  marketplace's rules.

```sh
pnpm --filter @maskwars/market listing                                    # the listing, field by field
pnpm --filter @maskwars/market competition open-admin --pool 50 --hours 72  # a race, written as a competition
MARKET_API_TOKEN=aat_… pnpm --filter @maskwars/market worker               # work MASK CHECK jobs, polling
pnpm --filter @maskwars/market status                                     # where the listing stands, read-only
```

## Who may do what

The marketplace splits the work by credential, and this package follows it.

| Action | Who | Here |
| --- | --- | --- |
| Create the account and the agent, set the price, the webhook and the listing | the agent's owner, in the web app | `listing` prints every field |
| Post a competition: the pool is debited into escrow | the owner only (`POST /v1/jobs/competition` refuses agent tokens) | `competition` prints the brief and the body |
| Read assignments, start, submit, decline | the agent's `aat_` token | `MarketClient`, `worker`, the webhook handler |
| Read the catalog, prices, platform stats, x402 payees | anyone | `MarketClient`, `status` |

The token pins one agent. It cannot move money, hire, or act as the owner.

## MASK CHECK as a service

A paid call becomes a job for our agent. Its brief is the caller's message: the first line is the title, the rest the
text.

1. **In.** `parseCheckRequest` matches NEAR testnet account ids (`*.testnet`, implicit) in the text, in order, once
   each, at most five. A mainnet name is refused with a reason. No model reads the message, so nothing written in it
   can change what is checked or answered.
2. **Check.** `answerBrief` runs MASK CHECK on each account.
3. **Out.** `renderAnswer`: the verdict as the title, a table of reasons per account with a link to the evidence
   transaction, and one JSON block holding the whole answer (`LISTING.output_schema`).
4. **Decline** instead of delivering when the message names no testnet account (`rejected`), when a check throws, or
   when the chain could not be read at all (`failed`). The caller is not charged.

`serveAssignment` works one assignment end to end: `start`, answer, `submit` or `decline`. A row that moved on meanwhile
is skipped; a retryable failure is thrown so the next poll tries again.

### Push: the webhook

The marketplace POSTs signed events to the agent's `webhook_url`. `createWebhookHandler` returns a
`(Request) => Promise<Response>` for any route that hands over a `Request`:

- checks `X-Market-Signature` (HMAC-SHA256 over `<timestamp>.<raw body>`, constant-time) and refuses a timestamp more
  than 5 minutes off;
- answers `200` at once, takes each `X-Market-Delivery` once, and works a `hire.created` after the answer, through
  `waitUntil`;
- reads the assignment back from the API before any work, as the marketplace asks.

```ts
// app/api/market/hook/route.ts in a Next.js app
import { after } from "next/server";
import { ChainReader, maskCheck, sharedList } from "@maskwars/check";
import { MarketClient, createWebhookHandler } from "@maskwars/market";

const reader = new ChainReader();
let handle: ((request: Request) => Promise<Response>) | undefined;

export function POST(request: Request): Promise<Response> {
  // Built on the first delivery, so a build without the secrets still builds.
  handle ??= createWebhookHandler({
    secret: process.env.MARKET_WEBHOOK_SECRET ?? "",
    client: new MarketClient({ token: process.env.MARKET_API_TOKEN ?? "" }),
    check: (account) => maskCheck(account, { reader, list: sharedList }),
    waitUntil: (task) => after(task),
  });
  return handle(request);
}
```

### Pull: the worker

`runWorker` polls the agent's assignments every 30 seconds and works each one in progress; it needs no inbound
endpoint. A failed poll backs off up to five minutes; a `401` stops it, because a revoked token does not come back by
waiting. Next to the webhook it is the safety net: a missed push is picked up on the next poll, and a row the
webhook started less than a minute ago is left to it, so one job is never delivered twice.

| Variable | What |
| --- | --- |
| `MARKET_API_TOKEN` | the agent's `aat_…` token, minted by the owner on the agent's page |
| `MARKET_WEBHOOK_SECRET` | the secret set beside `webhook_url`, 32 characters or more (`listing --secret` makes one) |
| `MASKCHECK_RPC` | optional, comma-separated NEAR testnet RPC endpoints |
| `MARKET_ORIGIN` | optional, another marketplace origin |

## A race as a competition

`raceCompetition(challenge, { pool, hours })` builds the `POST /v1/jobs/competition` body from a training target in
[`contracts/challenges`](../../contracts/challenges). The brief carries the world (accounts, balances, setup), the full
source, the public kit, the only win, the plan format of the [race runner](../race) and what a complete work holds.

- The pool is USDC with at most 6 decimals; the deadline 2 to 719 hours ahead (the marketplace takes 1 hour to 30
  days).
- A target whose source names its own hole is refused: every work would find it at once.
- After the deadline the platform judge scores each work 0–100. The works holding the two best distinct scores of 80
  and up share the pool in proportion to score. If no work reaches 80, the pool returns to the buyer.
- `planFromWork` takes the plan out of a paid work and holds it to the runner's format, ready to replay in the sandbox.

## Tests

`pnpm --filter @maskwars/market test` runs against the marketplace's own answers, without a token:

- `test/fixtures/recorded/`: live answers of market.near.ai (platform stats, x402 payees, a catalog row, refusals).
- `test/fixtures/docs/`: the token-gated answers as the published schema and the marketplace's docs give them.
- `test/fixtures/openapi.subset.json`: the published schemas of every body we read or send. Every fixture holds to
  them, and every body we send holds to them field for field.

`pnpm --filter @maskwars/market record` records all three parts again from the live API, read-only. A test that fails
after a fresh recording means the API changed under us.

## Agent skill

[`skill/SKILL.md`](skill/SKILL.md) is the skill a caller's AI reads: when to ask, how to call (the free endpoint or
A2A with x402), how to read the answer and what to do with it.
