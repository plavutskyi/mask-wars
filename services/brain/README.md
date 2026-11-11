# The mask's mind on OutLayer

A person may give their mask one line of strategy. The browser seals it for the mind's key, the mask factory keeps
only the sealed box, and the line opens only inside this module's TEE.

- The mind's X25519 key comes from `PROTECTED_BRAIN_SEED`, a secret OutLayer generates inside the TEE: nobody, the
  arena included, ever sees it.
- `{"action":"key"}` answers with the public half, `{"key":"x25519:<hex>"}`. OutLayer signs the answer with the
  enclave's attestation, so anyone can check that the key the factory publishes came out of this code.
- `open` (in the library) opens a box for this mind and one mask; the line never leaves the TEE.

The format and a test vector the browser checks too: [`vector.json`](vector.json), and the factory's
[README](../../contracts/masks/README.md).

## The mind at play

`{"action":"plan","mask":"kira.masks.tinygif8324.testnet","round":"human-0001","challenge":"live-safe","history":[…]}`:
one attempt of a person's mask in a race ([src/mind.rs](src/mind.rs)). The race job calls it over OutLayer's HTTPS API
(`POST /call/<owner>/brain`, packages/race/src/brain.ts). Inside the TEE, the module:

1. answers only the keeper: the run's signer, which over HTTPS is the payment key's owner, must be in `callers` of
   [`mind.json`](mind.json) (`tinygif8324.testnet`). Anyone else gets no run and spends no token;
2. reads the mask from the factory through the worker's own RPC: its model (Confidential TEE models only), its style,
   and that the keeper armed it for this very round. A factory, a target or a mask it does not know gets no run;
3. opens the owner's strategy with the mind's key, for this mask's account only;
4. asks the mask's model on NEAR AI Cloud (`NEAR_AI_API_KEY`, a secret of the project) with the arena's rules, the
   mask's style and the strategy in the system message, and the target, compiled into the module, as data. Of the past
   attempts the model reads only each verdict and, step by step, the method and whether it went through: no text the
   caller wrote ever reaches it;
5. writes the plan itself. A person's mask plays only `set_owner` and `sweep` on the safe, so the plan that leaves is 1
   to 4 of those calls in the order the model chose, with the mask's own account in every argument and the module's
   amount in a sweep. Numbers, lists, deposits, gas and every other field of the answer stay in the TEE. With the plan
   go the tokens the model used, in steps of 2048 rounded down, for the keeper to charge the mask.

The words the mind is told, [`mind.json`](mind.json), are the arena's own masks' rules and the forge's styles; tests on
both sides keep them the same.

**A copy plays its author's strategy.** When the mask is a copy (`copy_of` on the factory), the module opens the
author's box, not one of the copy's own, for the author's account — inside the TEE, so neither the copy nor its owner
ever sees the line. Everything else holds: only the keeper asks, the mask must be armed for this round, and what leaves
is the module's own plan.

**Nobody reads a strategy, ever.** Playing is the only thing the mind does with a line: no action opens one, re-seals
it for another key or hands it to anyone, the author, a copy's owner and the keeper included. An input asking for
anything else (`view`, `reveal`, `open`) is not one the module reads, and OutLayer gets only `bad input` back.
A view key opens a mask's **race history** (the keeper's sealed notes on each race), never the strategy: the mind
plays no part in it (`contracts/masks/factory/src/view.rs`).

**A factory that names this mind.** Besides the factories in `mind.json`, the module plays the masks of any factory
whose `config()` names this mind's key as the one its strategies are sealed for, and only when that factory's own
`keeper` asks. It opens nothing of anyone else's: a box opens only for the mask account it was sealed for, and that
account is `<name>.<factory>`. And OutLayer still decides who runs at all: the project's secrets, the mind's seed and
the NEAR AI key, reach only the signers their owner whitelisted. A project with no `NEAR_AI_API_KEY` answers
`the mind has no NEAR AI key in its TEE` before it sends anything.

**What can leave, counted.** Whatever the model writes, one attempt's answer is one of 30 plans or one of two errors
(the answer holds no plan; the model spent its tokens before it answered), and a count of answer tokens in one of 12
steps: at most log2(32) + log2(12), under 9 bits, and no character of the line. A model still at work when its time
runs out earns a third error, with no count at all: one more outcome, and still under 9 bits. The
prompt's count, in the same steps, tells at most whether the line's length crosses a step. Nobody can tell the model to
spend those bits on the line: what the caller sends is verdicts and method names, not text. What the module does not
hide: the plan is the strategy's effect, and the mask plays it on chain for all to see; and the run's duration follows
the answer's length.

## Tokens, time and what a race costs

The TEE models think before they answer, and the thinking counts against the allowance: on the live safe's source
(51 KB, some 16 thousand tokens of prompt) they spend 8 to 14 thousand tokens on it and up to three and a half minutes.
One attempt's allowance is written once, in [`mind.json`](mind.json) (`limits`), for the module and for the race job:

| Limit | Value | Whose it is |
| --- | --- | --- |
| Tokens in one answer, thinking included | 24 000 | ours: the allowance the arena's own masks play with |
| One run of the module | 180 s | OutLayer's most (`max_execution_seconds`; 60 when a call names none) |
| One request to the model | 165 s | ours, inside the run: [`manifest.json`](manifest.json) |
| Attempts in one race | 5 | ours: the race job asks a mind no more (`RACE_CALLS`) |

**The manifest.** OutLayer gives a request out of a module 30 seconds unless the module's own manifest names the host
and a longer time, 180 seconds at most and never past the run's end. The manifest is a section of the wasm
(`outlayer.manifest`, written in `src/main.rs`), under the same sha256 as the code; `build.sh` fails when the wasm does
not carry it. It also makes cloud-api.near.ai the only host the module reaches. The chain is read through the worker's
own RPC, which is no request of the module's.

**A model that does not make it.** Three ways an attempt ends without a plan, each named apart:

| What happened | What the race job is told | What the mask pays |
| --- | --- | --- |
| The model spent all 24 000 tokens before it answered (`finish_reason: length`, no content) | `the model spent all 24000 tokens before it answered` | the tokens: they were spent |
| The model was still thinking after 165 s | `the model did not answer in 165 seconds`, with the seconds it really had; the run ends in order, under OutLayer's limit | nothing: no count comes back for an answer that never came, and the arena covers it |
| The answer holds no `set_owner` or `sweep` call | `the answer holds no plan the mask plays` | the tokens |

An OutLayer run cannot last five minutes, as a call of the arena's own masks can: an answer that takes longer than 165
seconds does not fit one run, and that attempt goes by. The mask plays its next attempt.

**What the owner pays.** Only the tokens the model used, at NEAR AI Cloud's price for the mask's model
(`packages/mind/src/models.ts`), counted in steps of 2048 rounded down, turned into NEAR at the price 1Click shows when
the keeper settles, and never more than the race held (`race_limit`, 0.05 NEAR unless the person chose otherwise).
OutLayer's own charge for the run is the arena's. In dollars, and in NEAR at $3.70 (1Click, 8.11.2026):

| Model | One attempt as it goes on the live safe | One race of 5 such attempts | The dearest race there can be |
| --- | --- | --- | --- |
| GLM 5.3 Flash | $0.004 to $0.007 | $0.022 to $0.037: 0.006 to 0.010 NEAR | $0.068: 0.018 NEAR |
| DeepSeek V4.1 Flash | $0.012 to $0.020 | $0.061 to $0.098: 0.017 to 0.027 NEAR | $0.174: 0.047 NEAR |
| Qwen 3.8 27B | $0.009 to $0.017 | $0.045 to $0.086: 0.012 to 0.023 NEAR | $0.166: 0.045 NEAR |

"As it goes" is 16 thousand tokens of prompt, none cached, and 8 to 14 thousand of answer, as the mask is charged for
them: in whole steps of 2048, rounded down. "The dearest" is the ceiling the code
holds (`raceCeilingUsd` in `packages/race/src/brain.ts`, pinned by its test): 5 attempts, each with 20 000 tokens of
prompt, none cached, and all 24 000 tokens of answer. A race ends at the first break, so most cost less. The 0.05 NEAR
a race holds covers the dearest race for as long as a NEAR is worth $3.48 or more; under that the mask still pays the
0.05 at most and the arena pays the difference. With the allowance of 3 000 tokens the dearest race, counted the same
way, was $0.016, $0.048 and $0.024 for the three models, and no answer on the live safe ever fit it. The five attempts
are counted for one run of the race job.

```bash
cargo test
cargo build --release --target wasm32-wasip2
```

Publish: CI attaches `maskwars-brain.wasm`, named on maskwars.xyz by its sha256. Then, on the owner's OutLayer account:
the project `brain`, its version, `outlayer secrets set --generate PROTECTED_BRAIN_SEED:hex32 --project <owner>/brain
--access whitelist:<owner>` (mainnet: `whitelist:maskwars.near`, the keeper; as the judges do, so nobody else's run gets
the mind's seed or spends the owner's NEAR AI key), one run with `{"action":"key"}`, and the key goes to the factory (`scripts/testnet/forge-deploy.ps1 -StrategyKey` or
`forge-change.ps1 -StrategyKey`). For the mind at play the project also needs the secret `NEAR_AI_API_KEY`, added with
`outlayer secrets update '{"NEAR_AI_API_KEY":"…"}' --project <owner>/brain`: `update` merges and keeps every
`PROTECTED_*` secret, while `set` would write the row anew, give the mind a new key and leave every sealed strategy
unopenable. The race needs a payment key for HTTPS calls, made on the keeper's account `tinygif8324.testnet`
(`outlayer keys create`), since the module answers only that account; it goes into the secret `OUTLAYER_PAYMENT_KEY`
of the `live-race` environment. A new module version keeps the project's secrets, so the mind's key stays the same:
after adding one, run `{"action":"key"}` on it before it becomes the active version and compare the key with the one
the factory publishes (`config()`, `strategy_key`). That run also shows OutLayer did not refuse the module's manifest.
That OutLayer gives the request its 165 seconds shows only in a `plan` run where the model thinks for more than 30: a
run cut short says `the model did not answer in 30 seconds` (the manifest's time was not applied) or
`… in 5x seconds` (the run got 60 seconds, not the 180 the call asked for).
