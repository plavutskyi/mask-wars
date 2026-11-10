# @maskwars/near

Mask money on NEAR: an Agent API client, a safe-money wrapper, a fake for working without keys, and `intents.near`
balance reads through two RPCs.

## Page 1. How to connect

### One interface, two engines

```ts
import { HttpAgentApi, FakeAgentApi, SafeMoney, MemoryIdempotencyStore, VirtualClock, systemClock, USDC, BTC } from "@maskwars/near";

// Production: the key and grant tokens stay on the backend; they never reach the browser or the model.
const api = new HttpAgentApi({
  apiKey: process.env.NEAR_INTENTS_AGENT_API_KEY!,
  grants: { [agentId]: process.env.GRANT_TOKEN! },
});

// Fake: the same methods, the same errors, virtual time.
const clock = new VirtualClock();
const fake = new FakeAgentApi({ clock, seed: 1 });
```

`AgentApiPort` is `getTokens`, `listAgents`, `getAgent`, `getWallet`, `getBalances`, `quoteSwap`, `swap`, `transfer`,
`withdraw`, `deposit`, `getStatus`, `getOperationProof`. The types come from the Agent API OpenAPI spec (through
`@near-intents-agent-api/sdk` 0.7.3, MIT). The SDK itself is not a dependency: it requires Node 24 and CI runs on 22.

### Money only through `SafeMoney`

```ts
const money = new SafeMoney({ api, store: new MemoryIdempotencyStore(), clock: systemClock });

const out = await money.execute({
  kind: "swap",
  agentId,
  logicalId: "f-1-42:left:entry", // one logical action = one id forever
  body: { origin_asset: USDC, destination_asset: BTC, amount: "1000000", min_amount_out, confidential: false },
});
```

| `out.state` | What the engine does |
| --- | --- |
| `SUCCESS` | Computes the result from `details.amount_out` |
| `REFUNDED`, `FAILED` | Final. A new attempt only on purpose: `money.reopen(logicalId)`, then `execute` |
| `UNCERTAIN` | The money may have gone. Only wait and call `execute` again with the same `logicalId` |
| `NEEDS_REVIEW` | Stop, quarantine the wallet, call a person |
| `PENDING` | The deadline passed in `PROCESSING`, or the response was lost. Call `execute` again with the same key |
| `REFUSED` | A proven refusal, nothing was sent. `out.code` says why |

What the wrapper guarantees:

- `Idempotency-Key` is written to the store before the call. After a process crash the retry uses the same key.
- A new key is issued only after a recorded refusal (`wallet_busy`, `route_unavailable`, policy, budget). Never for
  `UNCERTAIN`, `sponsor_busy`, 5xx or a dropped connection.
- One money request per wallet at a time. `wallet_busy` is recorded as a refusal, and the next attempt uses a new key.
- Its own custody counter: 100 operations per wallet in a rolling 24 h. `provider_limit_reached` blocks the wallet until
  `available_at`. Before a fight: `money.custody.assertFightEntry(agentId)` checks for the two operations of a fight
  plus a reserve.
- `StatusPoller` polls statuses separately from the wallet queue, with at most 10 long polls at once.

Production needs durable storage: implement `IdempotencyStore` and `CustodyLog` on a database (Supabase).
The in-memory implementations are for tests and the fake.

### The fake and scenarios

```ts
fake.next("refunded");          // the next operation only
fake.setMode("slow");           // all that follow
fake.failNext("spend_budget_exceeded");
```

Scenarios: `ok`, `refunded`, `failed`, `uncertain`, `needs_review`, `busy`, `quota`, `slow`. All hashes start with
`FAKE-`, and the proof origin is `fake.agentsonintents.local/log`. Over HTTP: `serveFake(fake)` serves the same paths on
`127.0.0.1`, and `HttpAgentApi` with `baseUrl` talks to it.

### Balances from the chain

```ts
const rpc = new NearRpc({ crossCheck: true }); // free.rpc.fastnear.com, fallback near.drpc.org
const { value } = await rpc.mtBatchBalanceOf(wallet.near_account_id, [USDC, BTC]);
```

The client switches to the fallback RPC only on a dropped connection or a server error. "Account does not exist" and a
contract panic do not switch. `crossCheck` re-reads the same block on the second RPC and returns no numbers if they do
not match.

### Gate 1

```sh
node scripts/gate/run.mjs           # fake: 10 swaps, a transfer, ACTIVE, a deposit
node scripts/gate/run.mjs --live    # production, fleet keys required; every step that moves money asks y/N
```

Variables for `--live` go in `.env` (it is not in git): `NEAR_INTENTS_AGENT_API_KEY`, `GATE_AGENT_A`, `GATE_GRANT_A`,
`GATE_AGENT_B`, `GATE_GRANT_B`, and optionally `GATE_NEW_AGENT` and `GATE_DEPOSIT_ORIGIN`. The fake run writes its
report to `scripts/gate/out/`. The live run writes a local report file; `--out <path>` sets where.

## Page 2. What policy cannot do

The rules are signed by the fleet account and enforced by the attested Agent API and the OutLayer TEE wallet, not by a
contract. Below are the limits and what this package does about each.

| # | Limit | What we do |
| --- | --- | --- |
| 1 | **Buying is not restricted.** `assets` covers only what is sold | The engine allows only the basket BTC, ETH, SOL, wNEAR, ZEC |
| 2 | **There is no price rule.** `min_amount_out` is optional; a swap below the minimum becomes `NEEDS_REVIEW` and the budget is spent | `min_amount_out` is −3% from `dry`; `NEEDS_REVIEW` stops the wallet |
| 3 | **A compromised backend can destroy value within the budget** without withdrawing funds | `destinations` is empty; limits and the budget cap the loss |
| 4 | **The budget counts turnover, not loss.** Periods are fixed | Fighters get `budget: null`; the cap is the per-asset limits |
| 5 | **Point of no return.** After `dispatch_committed_at`, a freeze or a grant revocation does not stop the action | `UNCERTAIN` is only polled, never duplicated |
| 6 | **`native` bypasses almost everything** | Not enabled |
| 7 | **No recovery** of the fleet key | The fleet belongs to `maskwars.near`, not a passkey |
| 8 | **`agent_delete` destroys the balance** | Deletion only after withdrawal, never from engine code |
| 9 | **One money request per wallet at a time**, otherwise `wallet_busy` | `WalletQueue` and a new key after a recorded refusal |
| 10 | **OutLayer signs the swap on trust** | We state this plainly; the fight result is checked against `mt_balance_of` |

Two more things policy does not see:

- **Provider quota** (100 custody operations per wallet in a rolling 24 h) does not show in `/v1/quotas`. We count it
  ourselves (`CustodyCounter`); entering a fight without a reserve is forbidden.
- **`dry` does not refuse**, it only warns, using the same codes. The gate treats any warning other than `high_fee` as
  a refusal.
