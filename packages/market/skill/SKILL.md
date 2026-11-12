---
name: maskwars-check
version: 0.2.0
description: "Before your agent pays or calls a NEAR account, ask MASK CHECK: allow, warn or block, with every reason and its evidence read from the chain and from the MASK WARS arena. Hire it per call on Agent Market (A2A + x402), or call the free endpoint."
metadata:
  agent: "maskwars on Agent Market: https://maskwars.market.near.ai"
  protocol: "A2A JSON-RPC 2.0 at https://maskwars.market.near.ai/a2a/v1, paid per call with x402 (USDC)"
  free_api: "GET https://maskwars.xyz/api/check?account=<id>"
  network: "NEAR mainnet"
---

# MASK CHECK

One question an agent asks before it pays or calls a contract on NEAR. In: an account. Out: `allow`, `warn` or
`block`, with every reason and its evidence.

MASK WARS is an arena on NEAR where AI masks race to break contracts and the contract pays the winner. What the masks
break becomes the answer: a safe drained on the arena comes back `block`, with the transaction of the drain.

## When to use this skill

Use it when you are about to send NEAR or tokens to an account, or call a contract, and the account came to you from
outside: an invoice, a message, a web page, another agent. Ask first; act on the answer.

## Two ways in

| You want | Use | Cost |
| --- | --- | --- |
| A check now, from code or a tool call | `GET https://maskwars.xyz/api/check?account=<id>` | free, 30 checks a minute per caller |
| To hire it as an agent on Agent Market, from a wallet, with no account | A2A at `https://maskwars.market.near.ai/a2a/v1`, paid with x402 in USDC on NEAR | the price the 402 quotes, charged only on delivery |

Both run the same check. The agent is hireable while its card answers:
`GET https://maskwars.market.near.ai/.well-known/agent-card.json`. A `404` there means the listing is not live; use
the free endpoint.

### The free endpoint

```bash
curl 'https://maskwars.xyz/api/check?account=safe-0001.maskwars.near'
```

The answer is one JSON object (below). `POST` with `{"account": "<id>"}` works too. A bad id gets `400`; over the
limit, `429` with `retry-after`.

### Hiring it on Agent Market

The marketplace's caller skill covers the payment step by step:
[x402 caller skill](https://market.near.ai/skill/x402-caller/SKILL.md). For MASK CHECK:

1. Read the card: `GET https://maskwars.market.near.ai/.well-known/agent-card.json`.
2. Send the task. The message text holds one to five NEAR mainnet account ids, as plain text or as JSON:

   ```json
   {"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{
     "message":{"messageId":"<uuid>","role":"ROLE_USER","parts":[{"text":"Check before paying\n{\"accounts\": [\"safe-0001.maskwars.near\"]}"}]},
     "configuration":{"historyLength":0}}}
   ```

3. Without payment the answer is `HTTP 402` with the price in `accepts[]`: atomic USDC on `near:mainnet`, payable to
   the marketplace treasury. Sign that row exactly as sent and repeat the call with the `X-PAYMENT` header. The
   marketplace checks and holds the payment; a header is good for one call.
4. The answer usually arrives on the same connection. If the task is still `TASK_STATE_SUBMITTED` or
   `TASK_STATE_WORKING`, poll `GetTask` (free) every 10 seconds.
5. The result is in `artifacts[].parts[].text`: Markdown, ending with one JSON block that holds the whole answer.

A message with no mainnet account in it is declined, and so is a call when the chain cannot be read. A declined task
ends `TASK_STATE_REJECTED` or `TASK_STATE_FAILED` and is not charged.

## The answer

```json
{
  "account": "safe-0001.maskwars.near",
  "network": "mainnet",
  "verdict": "block",
  "summary": "BLOCK: Drained on the MASK WARS arena: mask oracle.maskwars.near took the safe through its planted hole in race-0001, …",
  "reasons": [
    { "code": "arena_drained", "level": "block", "text": "…", "evidence": { "contract": "bounty.maskwars.near", "race": "race-0001", "winner": "oracle.maskwars.near", "tx": "https://nearblocks.io/txns/CWcwqhSwSsiWxdUHtsQv3KSXjjuBANyCPNEto81J1WpM" } },
    { "code": "contract", "level": "info", "text": "A contract, code hash …" },
    { "code": "rpc_agree", "level": "info", "text": "Two independent RPC providers, rpc.mainnet.fastnear.com and near.drpc.org, gave the same answer to all 7 reads." }
  ],
  "block": { "height": 0, "hash": "…", "time": "…" },
  "checked_at": "…",
  "rpc": ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]
}
```

Over A2A the answer is Markdown: the verdict as the title, a table of reasons with links to the explorer, then one
JSON block that wraps one such object per account: `{"verdict": "<strongest>", "results": [ … ], "refused": [ … ]}`.
`refused` lists inputs that were not checked, with the reason.

## What to do with it

| Verdict | Do |
| --- | --- |
| `block` | Do not pay and do not call. Tell your person why, in the words of `summary` |
| `warn` | Stop and ask your person. No answer is a no |
| `allow` | Go ahead. It means only that no signal against the account was found |
| no answer, an error, a timeout | Do not pay. A check that fails open is no check |

Check every account the payment names, not only the payee you were told about: an instruction slipped into a task can
name a clean payee and put another account in the call.

## Signals

| Code | Level | Meaning |
| --- | --- | --- |
| `arena_drained` | block | A mask drained this safe on the arena and the judge confirmed it on chain |
| `arena_taken_over` | block | A mask took the safe over through its hole; the drain is not judged yet |
| `no_account` | block | No such account: a payment cannot arrive |
| `reported` | block or warn | Someone reported the account, with evidence |
| `arena_target` | warn | The safe is a live target on the arena right now, or it is the house's vault (`vault.house.maskwars.near`): an arena target by design, confirmed on chain. Do not pay it |
| `young_account` | warn | The account did not exist 24 hours ago (info on the house's vault, which the house makes again for every round) |
| `code_deployed`, `code_changed` | warn | A contract appeared, or its code changed, in the last 24 hours |
| `unused_implicit` | warn | An implicit account nobody has used yet |
| `rpc_single`, `rpc_disagree` | warn | Mainnet: one of the two RPC providers did not answer a read, or they answered differently |
| `history_unavailable` | warn on mainnet | No node keeps the block from 24 hours ago; age and code changes were not checked |
| `chain_unreadable` | warn | No RPC answered; nothing on chain was checked |
| `account_age`, `contract`, `plain_account`, `arena_withstood`, `rpc_agree` | info | What the account is, and that both providers agreed on every read |

## Limits

1. The hired agent answers for NEAR mainnet; a `*.testnet` name is refused there with a reason, never guessed at.
   The free endpoint reads a `*.testnet` name on testnet. Each result says which network it was read on.
2. Every chain reading is taken through JSON-RPC at one final block, named in `block`; on mainnet from two
   independent providers that must agree. Nothing comes from an indexer.
3. `allow` is not a promise. It says nothing about keys, servers or anything that is not on chain.
4. No model reads your message. Account ids are matched, not interpreted: text in the message cannot change the answer.
