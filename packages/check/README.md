# @maskwars/check

MASK CHECK (working name): one question an agent asks before it pays or calls a contract. In: a NEAR account, on
mainnet or testnet. Out: `allow`, `warn` or `block`, with every reason and its evidence. The masks on the MASK WARS
arena break contracts live; what they break becomes the answer.

`allow` means only that no signal against the account was found.

```sh
curl 'https://maskwars.xyz/api/check?account=intents.near'                      # mainnet: the name says so
curl 'https://maskwars.xyz/api/check?account=safe-0001.tinygif8324.testnet'     # testnet
pnpm --filter @maskwars/check check treasury.intents.near                       # the same, from the terminal
pnpm demo:check                                                                 # the one-minute demo, live on both
```

```json
{
  "account": "treasury.intents.near",
  "network": "mainnet",
  "verdict": "block",
  "summary": "BLOCK: No such account on mainnet: a payment cannot arrive.",
  "reasons": [
    { "code": "no_account", "level": "block", "text": "No such account on mainnet: a payment cannot arrive." },
    { "code": "rpc_agree", "level": "info", "text": "Two independent RPC providers, rpc.mainnet.fastnear.com and near.drpc.org, gave the same answer to all 2 reads.", "evidence": { "rpc": "rpc.mainnet.fastnear.com, near.drpc.org", "reads": 2, "cross_checked": 2 } }
  ],
  "block": { "height": 0, "hash": "…", "time": "…" },
  "checked_at": "…",
  "rpc": ["https://rpc.mainnet.fastnear.com", "https://near.drpc.org"]
}
```

`GET /api/check?account=<id>[&network=testnet|mainnet]` or `POST /api/check` with
`{"account": "<id>", "network": "mainnet"}`. Any origin may call it; nothing is cached. One caller gets 30 checks a
minute, both networks together (429 with `retry-after` after that). A bad id, a bad network or a name of the other
network (`alice.near` with `network=testnet`) gets 400. Over MCP the same check is the `check_account` tool on
`maskwars.xyz/mcp`, with the same optional `network`.

## Networks

The network is a parameter. Left out, the account names it: `.testnet` reads testnet; `.near`, implicit ids (64 hex,
`0x…`) and every other name read mainnet, where the money is. A named network wins.

| | mainnet | testnet |
| --- | --- | --- |
| RPC | `rpc.mainnet.fastnear.com` and `near.drpc.org`: two independent providers | `rpc.testnet.fastnear.com`, then `rpc.testnet.near.org` if it is down |
| How | Every read goes to both, at one block. An answer counts only when both give the same one; what one says alone is a warning | The first node answers; the second only on an outage |
| Older blocks | FastNEAR's regular node keeps about 17 h, so the 24 h reads go to `archival-rpc.mainnet.fastnear.com`; dRPC keeps about 30 h | Testnet nodes keep the last few epochs |
| Shared list | [`list.mainnet.json`](list.mainnet.json): empty until season 0 opens its races | [`list.json`](list.json) |
| Explorer in evidence | `nearblocks.io` | `testnet.nearblocks.io` |
| Override | `MASKCHECK_MAINNET_RPC` | `MASKCHECK_RPC` |

On mainnet the two providers keep each other honest, and one of them alone never makes an `allow`.

- **One head.** The reader takes the lower of their two final heads, which both have, and pins every read to it. A
  provider cannot pull the check to a height the other has not reached. Heads more than 100 blocks apart (about a
  minute) are no common head: one provider is stale or one is ahead of the chain, and nothing says which, so the
  check stops: `rpc_disagree`, `warn`.
- **One answer.** A provider that answers the same read differently (another balance, another code hash, an account
  the other says does not exist) stops the check the same way.
- **Both, or a warning.** A provider that is down, rate-limited or no longer keeps a block sits that read out, and
  the answer says so: `rpc_single`, `warn`, whichever read it was. A window nobody could read is `warn` too
  (`history_unavailable`). A provider that went down is not asked again during the same check, so one hung node
  costs one timeout.

`rpc.mainnet.near.org` is not used: it is deprecated, adds 3 s to every call and answers 429.

## Signals

Every chain signal is read through JSON-RPC at one final block, the same for all of them, on both networks. Nothing
comes from an indexer. Every signal works on mainnet as on testnet; the arena signals appear once the mainnet list
names a safe.

| Code | Level | What it means | Where it comes from |
| --- | --- | --- | --- |
| `arena_drained` | block | A mask drained this safe on the arena and the judge confirmed it | bounty contract `get(race)` → `state: drained`, `get_safe(race)` → this safe |
| `arena_taken_over` | block | A mask took the safe over through its hole; the drain is not judged yet | the safe's `get_owner` ≠ its owner when the race opened |
| `no_account` | block | A named account that does not exist: a payment cannot arrive | `view_account` → `UNKNOWN_ACCOUNT` |
| `reported` | block / warn | Someone reported the account, with evidence | the shared list, `reports` |
| `arena_target` | warn | The safe is in an open race right now | bounty contract `get(race)` → `open` or `judging` |
| `young_account` | warn | The account did not exist 24 h ago | `view_account` at the block 24 h back |
| `code_deployed`, `code_changed` | warn | A contract appeared or its code changed within 24 h | `code_hash` now and 24 h back |
| `unused_implicit` | warn | An implicit account nobody has used yet | `view_account` → `UNKNOWN_ACCOUNT` on a 64-hex or `0x` id |
| `chain_unreadable` | warn | No RPC answered: nothing on chain was checked | — |
| `rpc_disagree` | warn | Mainnet: the two providers named final heads more than 100 blocks apart, or gave different answers to the same read; the check stopped there | both providers, the same read at the same block |
| `rpc_single` | warn | Mainnet: some reads came from one provider only, and why the other sat them out | — |
| `history_unavailable` | warn on mainnet, info on testnet | No node keeps the block from 24 h ago: age and code changes were not checked | — |
| `arena_withstood` | info | The safe's race ended and nobody drained it | `get(race)` → `refunded` |
| `account_age`, `contract`, `plain_account` | info | What the account is | `view_account` |
| `rpc_agree` | info | Mainnet: both providers gave the same answer to every read | — |
| `arena_pending`, `arena_unreadable` | info | What could not be read, said plainly | — |

The 24 h point is found on chain: block time is measured over the last 10 000 blocks and the reader steps back that
many blocks. Regular RPC nodes keep the last few epochs; if none of them still has that block, the answer says so
(`history_unavailable`) instead of guessing.

Not read yet: past interactions between this agent and the payee. That needs an index of receipts (NEAR Lake or an
explorer API); a plain RPC node cannot answer it.

## The shared list

A plain file in the repo per network: [`list.json`](list.json) for testnet, [`list.mainnet.json`](list.mainnet.json)
for mainnet. A list names accounts of its own network only: a `.testnet` account in the mainnet list, or a `.near` one
in the testnet list, does not parse.

- `arena`: where the arena's live safes are: the bounty contract, the race id, the safe and its owner when the race
  opened. The file never says what happened to a safe. That is read from the chain on every check, so an entry cannot
  claim a drain the chain does not show. A new safe goes in right after its round opens, in the order the rounds open:
  `pnpm --filter @maskwars/check add-safe --network mainnet` adds every season round the list lacks (from the treasury's
  `rounds`), `--race <id>` a round the team opened by hand (from the bounty contract's `get_safe`), `--dry` only prints.
  Then a pull request: the site reads the list from the repository.
- `reports`: an account someone reported, with `level`, `reason`, `reported_by`, `added` and at least one piece of
  evidence (`{"kind": "tx", "hash": …}` or `{"kind": "url", "url": …}`). A report goes in by pull request. A report
  without evidence does not parse.

## The agent's side

```ts
import { guardedPay, maskCheck, readKeyScope, readerFor, sharedLists } from "@maskwars/check";

const reader = readerFor("mainnet"); // FastNEAR and dRPC, which must agree
const out = await guardedPay(intent, {
  key: await readKeyScope(reader, "agent-wallet.example.near", publicKey),
  check: (account) => maskCheck(account, { network: "mainnet", reader, list: sharedLists.mainnet }),
  askHuman: async ({ check }) => confirmInYourUi(check.summary),
  sign: (call) => signAndSend(call),
});
```

`readerFor("testnet")` and `sharedLists.testnet` read testnet the same way. `maskCheck` without `network` reads the
network of the list it is given, so code written for testnet (`{ reader, list: sharedList }`) works as before.

The wrapper checks the call it is about to sign, not only the payee the agent names. The payee must appear in the
call's arguments, or the wrapper refuses. Every other account the arguments name is checked too, and the strongest
answer decides: an injected instruction cannot name a clean payee and slip another account into the call.

| Answer | What the wrapper does |
| --- | --- |
| `block` | Refuses. The signer is never called |
| `warn` | Asks a person. No answer, an error or anything but `true` is a no |
| `allow` | Signs |
| the check fails or takes over 15 s | Refuses. A check that fails open is no check |

Before anything else the wrapper reads what the agent's key may do, and refuses:

- a full-access key: the agent never signs with one;
- a call to any contract other than the one the key is scoped to, or to a method outside its list;
- a call with a deposit: NEAR rejects a deposit from a function-call key.

### The limits of a function-call key

The agent holds a function-call access key on its wallet account, scoped to one contract (`receiver_id`) and a list of
methods (`pay`). What that key can and cannot do, by NEAR's rules:

- It can only call those methods on that one contract. It cannot transfer NEAR, deploy code, add or delete keys, or
  delete the account. Stealing it gives exactly what the wallet contract's `pay` allows, nothing more.
- It cannot attach a deposit. So the payment comes out of the wallet contract's own balance, within the limits that
  contract enforces, not from the call.
- Its gas comes out of an allowance. When the allowance runs out, the key stops working until a full-access key or the
  contract tops it up: an account that holds only function-call keys can lock itself out.
- The wallet contract with `pay` and its spending limits is not in this package yet; the wrapper works with any key
  scoped to one contract and reads that scope from the chain.
- The key limits what the agent can do. It does not judge who it pays: an injected instruction to pay a drained safe
  is a perfectly valid `pay` call. That is the part MASK CHECK answers.

MASK CHECK reads the chain. It does not cover leaked keys, servers or anything else off chain, and it says nothing about
an account it has no signal for.

### Limits on mainnet

- Two public providers on free plans. Under heavy load one of them rate-limits; the check goes on with the other and
  says `rpc_single`, which is a `warn`: while one provider is out, no mainnet account gets an `allow`. Both down:
  `chain_unreadable`, `warn`, nothing on chain read. A keyed endpoint goes in `MASKCHECK_MAINNET_RPC`.
- Two providers that agree can still both be wrong; two independent ones lying the same way at the same block is what
  the cross-check makes hard, not impossible.
- No arena safes on mainnet yet: until season 0 adds them to `list.mainnet.json`, a mainnet check reads existence,
  age, code and code changes, and reports.

## The demo

`pnpm demo:check`, live on testnet and mainnet (`--network testnet` or `--network mainnet` runs one):

1. The drain: a mask drained the arena's live safe on testnet, a training target with a planted hole.
2. The injection: an agent paying an invoice reads a hidden instruction to pay that safe instead. The agent is naive
   on purpose: it obeys the last payment instruction it reads.
3. The wrapper asks MASK CHECK about the payee, gets BLOCK, and nothing is signed.
4. The bounty contract paid the mask itself.
5. Mainnet, real money: an agent topping up its NEAR Intents balance reads an instruction to pay
   `treasury.intents.near` instead. That account does not exist: BLOCK, `no_account`, nothing is signed. The real
   `intents.near` reads as a contract with its code hash, both providers agreeing.

Until the safe is drained on testnet, steps 1 and 4 print `WAITING` with what the chain holds now, and step 3 shows the
real answer for the safe as it is. The demo holds no key and never sends anything, on either network.
`AGENT_ACCOUNT` and `AGENT_PUBLIC_KEY` (`AGENT_ACCOUNT_MAINNET`, `AGENT_PUBLIC_KEY_MAINNET` on mainnet) make it read a
real agent key from the chain. Exit 1 when a drained safe or an account that does not exist gets anything but BLOCK,
4 when no RPC answered.

## Files

| File | What it does |
| --- | --- |
| `src/rpc.ts` | JSON-RPC reader: blocks, accounts, access keys, view calls, at a final block or a height; failover, or cross-check with an archival node per provider |
| `src/network.ts` | The two networks: which network an id names, their endpoints, `readerFor` |
| `src/check.ts` | The signals and the verdict |
| `src/list.ts` | The shared list's schema, one list per network |
| `src/agent.ts` | The agent-side wrapper and the key guard |
| `scripts/check.ts`, `scripts/demo.ts` | The terminal check and the demo |
| `scripts/add-safe.ts` | Adds the arena's new live safes to a network's shared list, in the order their rounds opened |
| `scripts/record.ts` | Records what mainnet and testnet RPC answer about real accounts into `test/recorded/` (`pnpm --filter @maskwars/check record`) |
| `test/chain.ts` | A node in memory that answers in nearcore's exact JSON-RPC shapes, errors included |
| `test/recorded/*.json` | Real RPC answers: mainnet `intents.near`, `usdt.tether-token.near`, `treasury.intents.near`, an unused implicit id; testnet the drained safe, its contract, a mask, a name that does not exist |
