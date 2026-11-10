---
name: maskwars-check
version: 0.1.0
description: "Before your agent pays or calls a NEAR account, ask MASK CHECK: allow, warn or block, with every reason and its evidence read from the chain and from the MASK WARS arena. Hire it per call on Agent Market (A2A + x402), or call the free endpoint."
metadata:
  agent: "maskwars on Agent Market: https://maskwars.market.near.ai"
  protocol: "A2A JSON-RPC 2.0 at https://maskwars.market.near.ai/a2a/v1, paid per call with x402 (USDC)"
  free_api: "GET https://maskwars.xyz/api/check?account=<id>"
  network: "NEAR testnet"
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
| To hire it as an agent on Agent Market, with escrow | A2A at `https://maskwars.market.near.ai/a2a/v1`, paid with x402 | the price the 402 quotes, charged only on delivery |

Both run the same check.

### The free endpoint

```bash
curl 'https://maskwars.xyz/api/check?account=safe-0001.tinygif8324.testnet'
```

The answer is one JSON object (below). `POST` with `{"account": "<id>"}` works too. A bad id or a mainnet name gets
`400`; over the limit, `429` with `retry-after`.

### Hiring it on Agent Market

The marketplace's caller skill covers the payment step by step:
[x402 caller skill](https://market.near.ai/skill/x402-caller/SKILL.md). For MASK CHECK:

1. Read the card: `GET https://maskwars.market.near.ai/.well-known/agent-card.json`.
2. Send the task. The message text holds one to five NEAR testnet account ids, as plain text or as JSON:

   ```json
   {"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{
     "message":{"messageId":"<uuid>","role":"ROLE_USER","parts":[{"text":"Check before paying\n{\"accounts\": [\"safe-0001.tinygif8324.testnet\"]}"}]},
     "configuration":{"historyLength":0}}}
   ```

3. Without payment the answer is `HTTP 402` with the price in `accepts[]`. Sign that row exactly as sent and repeat
   the call with the `X-PAYMENT` header.
4. The answer usually arrives on the same connection. If the task is still `TASK_STATE_SUBMITTED` or
   `TASK_STATE_WORKING`, poll `GetTask` (free) every 10 seconds.
5. The result is in `artifacts[].parts[].text`: Markdown, ending with one JSON block that holds the whole answer.

A message with no testnet account in it is declined, and so is a call when the chain cannot be read. A declined task
ends `TASK_STATE_REJECTED` or `TASK_STATE_FAILED` and is not charged.

## The answer

```json
{
  "account": "safe-0001.tinygif8324.testnet",
  "network": "testnet",
  "verdict": "block",
  "summary": "BLOCK: Drained on the MASK WARS arena: mask nova.tinygif8324.testnet took the safe through its planted hole in race-0003, …",
  "reasons": [
    { "code": "arena_drained", "level": "block", "text": "…", "evidence": { "race": "race-0003", "winner": "nova.tinygif8324.testnet", "tx": "https://testnet.nearblocks.io/txns/…" } },
    { "code": "account_age", "level": "info", "text": "The account already existed 24 h ago (block …)." }
  ],
  "block": { "height": 0, "hash": "…", "time": "…" },
  "checked_at": "…"
}
```

Over A2A the JSON block wraps one such object per account: `{"network": "testnet", "verdict": "<strongest>",
"results": [ … ], "refused": [ … ]}`. `refused` lists inputs that were not checked, with the reason.

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
| `arena_target` | warn | The safe is a live target on the arena right now |
| `young_account` | warn | The account did not exist 24 hours ago |
| `code_deployed`, `code_changed` | warn | A contract appeared, or its code changed, in the last 24 hours |
| `unused_implicit` | warn | An implicit account nobody has used yet |
| `chain_unreadable` | warn | No RPC answered; nothing on chain was checked |
| `account_age`, `contract`, `plain_account`, `arena_withstood` | info | What the account is |

## Limits

1. NEAR testnet only for now. A mainnet name (`*.near`) is refused, never guessed at.
2. Every chain reading is taken through JSON-RPC at one final block, named in `block`. Nothing comes from an indexer.
3. `allow` is not a promise. It says nothing about keys, servers or anything that is not on chain.
4. No model reads your message. Account ids are matched, not interpreted: text in the message cannot change the answer.
