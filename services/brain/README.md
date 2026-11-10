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
   go the tokens the model used, in steps of 256 rounded down, for the keeper to charge the mask.

The words the mind is told, [`mind.json`](mind.json), are the arena's own masks' rules and the forge's styles; tests on
both sides keep them the same.

**A copy plays its author's strategy.** When the mask is a copy (`copy_of` on the factory), the module opens the
author's box, not one of the copy's own, for the author's account — inside the TEE, so neither the copy nor its owner
ever sees the line. Everything else holds: only the keeper asks, the mask must be armed for this round, and what leaves
is the module's own plan.

**Nobody reads a strategy, ever.** Playing is the only thing the mind does with a line: no action opens one, re-seals
it for another key or hands it to anyone, the author, a copy's owner and the keeper included. An input asking for
anything else (`view`, `reveal`, `open`) is not one the module reads, and OutLayer gets only `bad input` back.
A view key in the plan is a key to a mask's **race history** (the mind's notes on each race, its moves and the result),
never to the strategy; it comes once the mind writes those notes.

**What can leave, counted.** Whatever the model writes, one attempt's answer is one of 30 plans or one error, and a
count of answer tokens in one of 12 steps: at most log2(31) + log2(12), under 9 bits, and no character of the line. The
prompt's count, in the same steps, tells at most whether the line's length crosses a step. Nobody can tell the model to
spend those bits on the line: what the caller sends is verdicts and method names, not text. What the module does not
hide: the plan is the strategy's effect, and the mask plays it on chain for all to see; and the run's duration follows
the answer's length.

```bash
cargo test
cargo build --release --target wasm32-wasip2
```

Publish: CI attaches `maskwars-brain.wasm`, named on maskwars.xyz by its sha256. Then, on the owner's OutLayer account:
the project `brain`, its version, `outlayer secrets set --generate PROTECTED_BRAIN_SEED:hex32 --project <owner>/brain`,
one run with `{"action":"key"}`, and the key goes to the factory (`scripts/testnet/forge-deploy.ps1 -StrategyKey` or
`forge-change.ps1 -StrategyKey`). For the mind at play the project also needs the secret `NEAR_AI_API_KEY`, added with
`outlayer secrets update '{"NEAR_AI_API_KEY":"…"}' --project <owner>/brain`: `update` merges and keeps every
`PROTECTED_*` secret, while `set` would write the row anew, give the mind a new key and leave every sealed strategy
unopenable. The race needs a payment key for HTTPS calls, made on the keeper's account `tinygif8324.testnet`
(`outlayer keys create`), since the module answers only that account; it goes into the secret `OUTLAYER_PAYMENT_KEY`
of the `live-race` environment. A new module version keeps the project's secrets, so the mind's key stays the same.
