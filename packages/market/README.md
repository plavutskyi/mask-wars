# @maskwars/market

MASK WARS on [Agent Market](https://market.near.ai), the NEAR marketplace where people and AI agents hire AI agents.
Agent Market brings the agents and the buyers; MASK WARS brings the races and the data.

- **MASK CHECK, sold per call.** Our agent `maskwars` takes a caller's account ids over A2A, paid with x402 in USDC
  on NEAR, runs [MASK CHECK](../check) on each, on mainnet, and delivers `allow`, `warn` or `block` with every reason
  and a link to its evidence on chain. Settled only on delivery; a call it cannot answer is declined and not charged.
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

## Who checks the payment

The marketplace does, and only the marketplace. It is the A2A server of every listed agent, on the agent's own host:

1. A caller POSTs `SendMessage` to `https://maskwars.market.near.ai/a2a/v1` and gets `HTTP 402` with the price of our
   default plan: `0.10` USD is `"amount": "100000"` atomic USDC on `near:mainnet`, payable to the marketplace treasury.
2. The caller signs that row (one delegated `ft_transfer`) and repeats the call with `X-PAYMENT`. The marketplace
   verifies the payment, holds it, opens a hire for our agent and signs a `hire.created` event to our webhook.
3. We deliver, and the payment settles then. A header used twice, a forged or altered one, never becomes a hire.

Our agent never sees the caller, the header or the money, so it trusts none of them. For us a hire exists when two
things hold: the event carries the marketplace's signature, and the assignment is there, in progress, when we read it
back with the agent's own token. `test/paid.test.ts` walks the whole call on a stand-in for the marketplace
(`test/a2a.ts`) built from its docs and from a live 402 of a real agent (`test/fixtures/recorded/quote-live.json`).

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

1. **In.** `parseCheckRequest` reads the accounts, in order, once each, at most five. The JSON form
   (`{"accounts": ["…"]}`) names any valid NEAR id; a value that is not one is refused by its place (`accounts[1]`)
   and never repeated back. In free text only what cannot be a word counts: `*.near`, `*.tg`, `*.testnet` and implicit
   ids. No model reads the message, so nothing written in it can change what is checked or answered.
2. **Check.** `answerBrief` runs MASK CHECK on each account, on the network its name says, by the rule of
   `GET /api/check`: `*.testnet` reads testnet, everything else mainnet. `liveCheck` wires it as the site does: on
   mainnet two independent RPC providers answer every read and must agree. An answer about another account or
   another network is never delivered.
3. **Out.** `renderAnswer`: the verdict as the title; per account the block it was read at, a link to the account on
   the explorer and a table of reasons with links to the evidence (the drain's transaction, a report's sources); then
   one JSON block holding the whole answer (`LISTING.output_schema`), each result the same object the free endpoint
   returns.
4. **Decline** instead of delivering when the message names no account (`rejected`), when a check throws, or when
   the chain could not be read at all (`failed`). The caller is not charged.

`networks` (on the handler, the worker and `answerBrief`) narrows an agent to one network; a name of the other is
then refused with a reason. The site's agent answers for the network the site is built for: on maskwars.xyz, mainnet
only.

`serveAssignment` works one assignment end to end: `start`, answer, `submit` or `decline`. A row that moved on meanwhile
is skipped; a retryable failure is thrown so the next poll tries again.

### Push: the webhook

The marketplace POSTs signed events to the agent's `webhook_url`. `createWebhookHandler` returns a
`(Request) => Promise<Response>` for any route that hands over a `Request`:

- checks `X-Market-Signature` (HMAC-SHA256 over `<timestamp>.<raw body>`, constant-time) and refuses a timestamp more
  than 5 minutes off;
- answers `200` at once, takes each `X-Market-Delivery` once, and works the assignment after the answer, through
  `waitUntil`: on `hire.created`, on a buyer's `hire.changes_requested` and on a dispute sent back to redo;
- reads the assignment back from the API before any work, as the marketplace asks, and tries again (after 2 s, then
  6 s) when the marketplace fails in a way it calls retryable.

The site mounts it at [`apps/web/app/api/market/hook`](../../apps/web/app/api/market/hook/route.ts):
`https://maskwars.xyz/api/market/hook` is the agent's `webhook_url`. Until the owner sets the token and the secret the
route answers `503` and says it is not open.

```ts
import { after } from "next/server";
import { MarketClient, createWebhookHandler, liveCheck } from "@maskwars/market";

const handle = createWebhookHandler({
  secret: process.env.MARKET_WEBHOOK_SECRET ?? "",
  client: new MarketClient({ token: process.env.MARKET_API_TOKEN ?? "" }),
  check: liveCheck({ env: process.env }),
  waitUntil: (task) => after(task),
});
```

### Pull: the worker

`runWorker` polls the agent's assignments every 30 seconds and works each one in progress; it needs no inbound
endpoint. A failed poll backs off up to five minutes; a `401` stops it, because a revoked token does not come back by
waiting. Next to the webhook it is the safety net the marketplace asks every agent to keep: a push that never arrived
is picked up on the next poll, and a row the webhook started less than a minute ago is left to it, so one job is
never delivered twice. The site runs no poll of its own; `worker --once` is one poll from any machine.

| Variable | What |
| --- | --- |
| `MARKET_API_TOKEN` | the agent's `aat_…` token, minted by the owner on the agent's page |
| `MARKET_WEBHOOK_SECRET` | the signing secret beside `webhook_url` (`whsec_…` from the form), 32 characters or more |
| `MARKET_AGENT_HANDLE` | the site only: the agent's handle, set once the listing is live; `/mcp/connect` then shows the way to hire it, for as long as the marketplace says the listing is live |
| `MASKCHECK_MAINNET_RPC`, `MASKCHECK_RPC` | optional, comma-separated NEAR RPC endpoints of mainnet and of testnet |
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

- `test/fixtures/recorded/`: live answers of market.near.ai (platform stats, x402 payees, a catalog row, refusals, the
  unpaid 402 of a live agent beside its plan) and of NEAR RPC (what MASK CHECK reads about the accounts of the
  paid-call tests).
- `test/a2a.ts`: a stand-in for the marketplace's half of a paid call (the 402, the payment check, the hire, the
  signed webhook, the settlement), held to that live 402 field for field. `test/paid.test.ts` runs whole calls on it:
  no payment, a paid verdict, the same payment twice, payments that are not valid, the two networks, and a caller's
  text that tries to give orders.
- `test/fixtures/docs/`: the token-gated answers as the published schema and the marketplace's docs give them.
- `test/fixtures/openapi.subset.json`: the published schemas of every body we read or send. Every fixture holds to
  them, and every body we send holds to them field for field.

`pnpm --filter @maskwars/market record` records all three parts again from the live API, read-only. A test that fails
after a fresh recording means the API changed under us.

## Agent skill

[`skill/SKILL.md`](skill/SKILL.md) is the skill a caller's AI reads: when to ask, how to call (the free endpoint or
A2A with x402), how to read the answer and what to do with it.
