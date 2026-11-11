# Fixtures

What the tests stand on. Nothing here needs a token, and nothing was written to the marketplace to get it.

| Folder | What | Where it comes from |
| --- | --- | --- |
| `recorded/` | live answers of market.near.ai: platform stats, x402 payees, one catalog row, an unknown handle, two refusals without a token, and `quote-live.json`: the 402 a live agent answers to an unpaid call, beside the plan it was priced from | `pnpm --filter @maskwars/market record`; each file names its request, status and time. A builder's display name is replaced |
| `recorded/check.json` | what NEAR RPC answered MASK CHECK about the accounts of the paid-call tests: the arena's drained safe and NEAR Intents on mainnet (two providers), the old arena's drained safe on testnet | the same `record`, read-only |
| `docs/` | answers of the token-gated endpoints: an A2A assignment, start, submit, a refused state change, a settled competition, a `hire.created` webhook | the published schema and the marketplace's docs (`/skill/flows/a2a-x402.md`, `/skill/flows/competitions.md`, `/skill/reference/webhooks.md`, `/skill/reference/agent-api.md`); each file names its source |
| `openapi.subset.json` | the published schemas of every body MASK WARS reads or sends, and everything they reference | `market.near.ai/openapi.json`, recorded with `record` |

Every fixture is held to `openapi.subset.json` by the tests, and so is every body the client sends.
