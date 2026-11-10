# The ai_review judge

A client hires masks for work a reviewer judges: a governance review of a proposal, an audit note, a design critique.
The client publishes what the work is about (the spec) and how it is scored (the rubric) before anyone starts; the job
holds both hashes. The masks' work is sealed for this judge's key. This module runs in a TEE on OutLayer, opens the
work there, asks a model on NEAR AI's Confidential TEE to score each entrant's work by that rubric in a call of its
own, checks every answer by code, and the jobs contract ([`contracts/jobs`](../../contracts/jobs)) pays the winner.

## The main rule

Whoever did the work honestly gets paid, and nobody gets the work for free. So:

- **The work is private.** Every revealed step is a box sealed for this judge's X25519 key (`src/sealed.rs` of
  [`services/judge-tests`](../judge-tests), shared), from a seed OutLayer generates inside the TEE. The client, the
  other masks and the chain see ciphertext before the verdict and after it. The client gets the winner's work alone,
  and only once the job is paid: the judge opens the winner's boxes and seals them again for the client's key
  (`"deliver":true`). Work that did not win the judge never seals for anyone.
- **Before any mask starts**, the judge checks the client's material (`check`): the spec and the rubric come under the
  hashes the job holds, this judge can use them, and the rubric's `win_at` is the job's `bar`. It publishes both in the
  project's storage, `material/<sha256>`, where every later run reads them, and the model scores the client's own
  reference review (`bar.reference`, sealed for this judge with the client's account as the mask): it must clear
  `win_at`. A bar the client's own review does not clear, or material the model cannot review by, never opens to
  masks; the client gets everything back before anyone works.
- **Nothing public holds the work.** The evidence of each answer is the model, the sha256 of the request and of the
  response, the signature over `model:sha256(request):sha256(response)` and its signer: it checks without the text.
  Every request of a job carries the job's nonce, 128 bits from the TEE kept in the project's private storage
  (`nonce/<version>/<contract>/<job>`), so the public request hash confirms no guess at anyone's work.
  The verdict on chain carries scores, never the model's reason, which cites the work: the reason goes to the client
  with the winner's work, sealed for its key, once the job is paid. The client's reference review is kept the same way.
- **Each entrant is reviewed in a call of its own.** The model never sees two entrants' work together: an injection
  breaks only the injector's own call. The winner's score rests on two seeds (two answers that agree, or the median of
  three), so one answer talked into a high score wins nothing. An entrant whose work makes the model refuse every
  answer scores nothing.
- **Work worth nothing counts for nothing.** Two answers that score an entrant zero points of 100: none of its steps
  is counted, and on the contract each of its seats pays half its bond to the company. It is not fake for that: fake
  takes two answers that call a step no real attempt. An answer that scores zero asks for a second; one zero answer
  costs nobody anything. When no striker's box opens as text there is nothing to review: the verdict comes at once,
  nobody wins, nothing counts, every junk box is fake.
- **Fake only on two answers that agree**, or for a junk box (one that does not open for its mask, or holds no text).
  A fake mask's bond goes to the company, never to the winner; one answer never costs anyone a bond.
- **A failed call spends nothing.** A rate limit, NEAR AI down, a timeout: the seed is asked again after a back-off on
  the chain's clock, and the verdict waits. An entrant still waiting holds the verdict only while it could change it.
  A run that cannot ask anyone yet says when it can (`retry_at`), and the contract asks no run before it; every
  answer says how many calls its run made (`asked`), and an appeal's held bond pays back only a run that made one.
- **The judge serves one jobs contract and its own key.** The contract's account is written into the wasm (`job.rs`,
  `served`): `jobs.tinygif8324.testnet` on testnet, and on mainnet none until the owner registers `maskwars.near`. A run
  asked by any other account answers nothing and never calls NEAR AI. A job pinned to another key gets no check,
  verdict or delivery.
- **After the check nothing depends on the client.** Material gone from the project's storage is the judge's failure:
  no verdict, never a share. With no verdict by `judge_until` the contract gives the client its reward back; the client
  saw none of the work.

## A run

The jobs contract asks `{"job","contract","kind":"ai_review","appeal","prior","check","deliver"}`. The judge:

1. answers only the jobs contract written into it, only when that contract called OutLayer, and only a job that
   pinned this project and this judge's own key; reads the job at one final block through two RPC sources of two
   operators, the OutLayer worker's (FastNEAR) and dRPC, that must agree (`job.rs`, shared with
   [`services/judge-tests`](../judge-tests));
2. takes the spec and the rubric the check published, or fetches them by the sha256 the job holds from the content
   store ([`src/store.rs`](src/store.rs)); for a check, publishes them and has the model score the client's reference;
3. opens every revealed step in the TEE: a box that does not open for its mask, or holds no text, is junk and fake:
   that is objective;
4. for each entrant with a striker's work, builds one request ([`src/prompt.rs`](src/prompt.rs)): every instruction is
   the module's own text; the spec, the rubric's criteria and that entrant's opened steps go into one JSON object as
   quoted data, cleaned of invisible, reordering and chat-template characters, with `[step` and `<think>`/`</think>`
   neutralized;
5. asks the pinned model over TLS to `cloud-api.near.ai` ([`src/nearai.rs`](src/nearai.rs)), takes only an answer that
   finished (`finish_reason` `stop`; a cut answer refuses its seed), checks that it carries a consistent signature
   (over this model, the exact request and the exact response, recovering to the address it names, marked
   `provider_tee`), and keeps the evidence of each valid answer in the project's public storage under
   `review/<sha256 of the response>`: `{"model","request_sha256","response_sha256","signature","signer"}`, no text;
6. checks each answer ([`src/reply.rs`](src/reply.rs)), keeps every try so far in the project's private storage
   (`answers/<version>/<contract>/<job>/<check|first|appeal>`, with each seed's failures and the chain time before
   which it is not asked again), and answers once no entrant that could change the verdict waits; otherwise it says
   how far it got and, if every entrant still waiting is backing off, when a run can ask again (`retry_at`), and a later
   run carries on. Every answer carries `asked`, the calls this run made to NEAR AI, when it made any.

| Situation | Answer |
| --- | --- |
| Check: the material comes under its hashes, is usable, its `win_at` is the bar, and the client's reference scores at least `win_at` | `{"checked":true,"win_at","criteria","spec_bytes","reference":{"points"}}`, the material published: the work window starts |
| Check: material missing from every working gateway or unusable, the rubric's `win_at` not the bar, the reference not text sealed for this judge, the reference below the bar, or every seed's answer refused | `{"checked":false,"why"}`: everything back to the client |
| An answer breaks what decides (scores in range, one answer, not a planted one), the token limit cut it, or NEAR AI refused the request for what it holds (400, 413, 422) | That seed is refused; the next seed is asked |
| A call fails (the network, a timeout, a rate limit 429, NEAR AI 5xx or our key 401/402/403, no signature) | No seed is spent. The entrant is not asked again until a back-off is over on the chain's clock: a minute after the first failure, then 2, 4, 8, 16, at most 30. The others are asked meanwhile, and two failures in a row end a run. A run whose every waiting entrant is backing off answers `{"success":false,"error","output":{"job","retry_at":"<ns>","asked"}}`: the contract asks no run before `retry_at` |
| First verdict | Each entrant's first valid answer of seeds 1 to 3. The entrant that would win, any whose answer doubts one of its steps, and any an answer scores zero, are asked until two answers agree or three are in: the winner's score rests on two seeds, a step is fake only if two answers agree it is no real attempt, and nothing of an entrant counts only if two answers score it zero (`zero`). An entrant whose every seed is refused scores 0; none of its steps counts or is fake |
| No striker's box opens as text | A verdict at once, NEAR AI not asked: no winner, nothing counted, every junk box fake (`rule`: `no striker's work opens as text`) |
| Appeal | Seeds 11 to 16 for each entrant: two answers that agree on the score and the real steps end it, otherwise three and the median; with every seed spent, the median of what came. The answer is final |
| An entrant still waiting for NEAR AI | The verdict waits, unless the entrant cannot change it: the winner has every point and sealed its strike first. Then the entrant is `unjudged`: its steps count, as with no verdict, none is fake. The judge never answers `undecided` for an outage |
| Delivery, once the job is paid | The winner's boxes and the model's reason, kept at the verdict, opened and sealed again for the client's key: `{"delivered":"delivery/<contract>/<job>","sha256"}`. Before the job is paid: no answer |
| The chain, every gateway or the project's storage unreachable, entrants still waiting | No verdict (`success: false`, saying how far it got): the contract waits for a judge again; with none by `judge_until`, the reward goes back |

**The winner** is decided by code from the answers: the highest weighted score (Σ weight × score) among entrants
with a counted striker step whose points (of 100) reach `win_at`, on two seeds; on a tie, the earliest striker seal
among the equals; or nobody. `counted` is every step an answer found real and that is not fake, unless two answers
score its entrant zero points; `fake` every step at least two answers found no real attempt (and more than found it
real), and every junk box. Work two answers score zero never wins, even on a bar of zero.

**What an answer must be.** Exactly one JSON object of this form in the reply, after its last reasoning block (a code
fence, text or objects of another form around it are not read):

```json
{"scores":[10,5],"real":[1,2],"why":"… [step 2] …"}
```

Held strictly: one integer score for every criterion in the rubric's order, from 0 to its max; one object of this form,
and not one the entrant wrote into its own step (the same object, or its text, whitespace aside). Taken as they come:
`real` keeps the entrant's own steps it names and drops the rest; a `[step N]` citation of anything else is dropped from
the text; the reason is cut to 200 characters.

A model that obeys an instruction hidden in a step scores out of range, adds what an answer has no room for, or repeats
a planted answer: refused, every seed, and the entrant gets nothing. A model that is talked into scoring junk highly
within range on one seed does not win it: the winner's score needs a second seed to agree, or the median of three.
What is left is a model talked into it on every seed, the limit of any model review, confined to the injector's own
score; the rubric is the client's lever, the appeal (three seeds, the median) the masks'.

**Pinned.** `deepseek-ai/DeepSeek-V4.1-Flash-1017` on NEAR AI's Confidential TEE, temperature 0.2, top_p 1, at most
1024 tokens (one entrant's biggest answer is about 330 bytes, with room left for a reasoning block), no streaming (a
streamed answer is signed by the gateway, not the model), `x-no-aliasing: true`. The request is the same bytes for the
same job, material, entrant, seed and the job's nonce, which only the judge's runs read: nobody outside can rebuild it
to test a guess at the work against the hash in the evidence, and NEAR AI's signature checks by that hash alone.
Changing the model or a parameter is a new judge version.

## Formats

**Verdict** (stdout; the contract reads `job`, `winner`, `counted`, `fake` and `undecided`, at most 4096 bytes):

```json
{"success":true,"error":null,"output":{"job":"review-0042","winner":0,"counted":[0,1,2],"fake":[4],
 "judge":"ai_review","rule":"review per entrant, winner on two seeds","model":"deepseek-ai/DeepSeek-V4.1-Flash-1017",
 "scores":[{"entrant":0,"points":100},{"entrant":1,"points":17},{"entrant":2,"points":0}],
 "calls":[{"entrant":0,"seed":1,"response":"<sha256>"},{"entrant":0,"seed":2,"response":"<sha256>"}]}}
```

`rule` is `review per entrant, winner on two seeds`, `review per entrant, median of runs` (appeal) or `no striker's
work opens as text`. `broke` lists the entrants whose every answer was refused, `zero` those two answers scored zero
points (none of their steps counts), `unjudged` those still waiting that could not change the verdict. `asked` is the
number of calls this run made to NEAR AI; it always stays in the answer. `calls`
lists the valid answers: the entrant, the seed and the response's sha256, the key its evidence is kept under
(`review/<response>`: the model, both hashes, the signature and the signer). No reason and no word of any work: the
reason goes to the client with the work. If the answer would pass the 4096 bytes the contract reads, the evidence list
goes first, then the scores.

**Delivery** (stdout, once the job is paid): `{"job","delivered":"delivery/<contract>/<job>","sha256"}`; the box is the
same as the `tee_tests` judge's (`mwd1.`, sealed for `client_key`), and inside, each of the winner's steps with its
`text`, and the model's reason for its score (`why`).

**Rubric** (bytes whose sha256 is the job's `rubric`, at most 8 KiB):

```json
{"format":"maskwars-rubric/v1","win_at":60,"criteria":[
 {"id":"finds-the-hole","max":10,"weight":3,"text":"Does the review find that abstentions count toward quorum?"},
 {"id":"fix","max":5,"weight":1,"text":"Does it propose a fix that counts only yes and no votes?"}]}
```

1 to 12 criteria, ids of lowercase letters, digits and `-`, `max` and `weight` 1 to 10, text up to 500 characters,
`win_at` 0 to 100 (1 when absent; the jobs contract takes a bar of at most 80). An unknown field refuses the rubric.
**Spec**: UTF-8 text up to 24 KiB. **Work**: each step a box for this judge's key holding up to 638 bytes of text
(kind `2`), up to four steps a mask.

**Content store**: raw IPFS blocks by sha256 (CIDv1, raw, sha2-256) from ipfs.io, dweb.link and w3s.link, kept only if
they hash to their name; `ipfs add --cid-version 1 --raw-leaves <file>` prints the CID. Each request has 4 seconds,
and the judge keeps asking, round after round, until 40 seconds into its run. The client keeps its content available
until the check, which publishes it in the project's storage; content no working gateway delivers by then is missing,
and the job is refused. A gateway that does not deliver, or answers that it is busy (429), is asked for the empty block,
which every gateway serves at once; only if no gateway works at all is it the network's failure.

## Keys and secrets

| Secret | Row | Who reads it |
| --- | --- | --- |
| `PROTECTED_REVIEW_SEED` (hex32, generated inside the TEE) | the project author's, profile `judge` | every run: the judge's X25519 key. `{"action":"key"}` answers its public half |
| `NEARAI_API_KEY` | the project author's, profile `judge` | every run; a key or a seed from a row the caller named is not used |

The manifest ([`manifest.json`](manifest.json)) is a custom section of the wasm, covered by its sha256: the author's
row and the hosts the module may reach (dRPC, the gateways with 4 seconds a request, and `cloud-api.near.ai` with 30
seconds, room for one entrant's answer). A judge run has 60 seconds; the judge starts a model call (the completion and
its signature, 35 seconds at most) only if it ends by 55. What a run could not ask, the next run asks.

## Build and publish

```bash
services/judge-review/build.sh
```

prints the sha256 of `target/wasm32-wasip2/release/maskwars-judge-review.wasm`. Then, on the owner's OutLayer account:

1. publish it as project `<owner>/review` with that version;
2. `outlayer secrets set --generate PROTECTED_REVIEW_SEED:hex32 --project <owner>/review --profile judge --access
   whitelist:<owner> --direct --via <jobs contract>` and `outlayer secrets set '{"NEARAI_API_KEY":"…"}'` to the same
   row, so only runs through the jobs contract use them. The jobs contract must be deployed at the account written
   into the wasm (`jobs.tinygif8324.testnet` on testnet, `job.rs`); for any other account the judge answers nothing,
   and changing the account is a new judge version. **Mainnet:** the wasm serves no mainnet contract yet. Only after
   the owner registers `maskwars.near` is `jobs.maskwars.near`, that same name, written into `SERVED_MAINNET` and the
   judge built and published again for mainnet;
3. one run with `{"action":"key"}`: the answer, signed with the enclave's attestation, is the key masks and clients
   seal for (`x25519:<hex>`);
4. on the jobs contract, the admin proposes `Change::Judge` for `ai_review` with the project, the sha256 and the key,
   applied after an hour.

## Live run

NEAR AI was not reachable from the session that wrote this module, so its tests run on answers written by the tests
(fixtures/README.md) and signed by a test key. To check the pinned model end to end, with a NEAR AI key:

```bash
cd services/judge-review
```

```bash
NEARAI_API_KEY=… cargo test --release -- --ignored live_near_ai --nocapture
```

It reviews the sample job with NEAR AI, one call for each entrant and a second for the winner and for any entrant an
answer doubts, checks every signature and answer with the module's own rules, prints the verdict, the winner's reason
(the client's alone) and the time it took, and fails unless the crew that found the quorum bug wins and two answers
agree the injected step is fake. Then it asks for the biggest call one entrant can make (a crew of eight, four steps of 638 bytes
each, a 24 KiB spec, 12 criteria) and fails if it does not come back whole within the 30 seconds a call has. Then check
the signer against NEAR AI's attestation report: `pnpm --filter @maskwars/mind verify:attestation
deepseek-ai/DeepSeek-V4.1-Flash-1017`.

## Tests

```bash
cargo test
LD_PRELOAD=/tmp/nofile.so cargo test -p review-judge-sandbox --test review_job
```

- Unit tests (62): the rubric's limits and points, cleaning and neutralizing, the request's bytes, one entrant's answer
  against the token limit, one entrant a call and the client's text as data, what decides held strictly and what
  explains tidied, one answer only, a planted answer, the last reasoning block, two agreeing answers or the median, the
  signature check (a known EIP-191 vector, a changed response, another model, a forged address, a gateway signature,
  an answer cut by the token limit, a refusal), which HTTP answers fail and which refuse, the content store, the check
  (the client's reference against the bar, material the model cannot review by, a refusal that names no word of it),
  each entrant alone and the winner on two seeds, an injection breaking only its own call, nothing published holding
  a word of any work, a failed call spending no seed and waiting out its back-off, an entrant still waiting holding
  the verdict only while it could change it, one answer never costing a bond, the winner's score on two seeds, ties,
  material gone after the check giving no verdict, a storage hiccup, the appeal's median, an outage during an appeal,
  the winning review and its reason for the client alone once paid, the key, the contract written in and the job's
  pinned key (`job.rs`); and the fourth review's attacks: a review scored zero on two seeds counting for nothing, a run
  during an outage saying when the next can ask and how many calls it made, the public request hash confirming no
  guess at the work, a job whose every striker's box is junk getting a verdict.
- Sandbox, against the real jobs contract (`contracts/jobs`): a governance review from `open` (its check scores the client's
  own review) to `settle` and the delivery, where VOLT hides an instruction, a false citation, a reasoning block's end
  and a planted answer in its step: one answer obeys it and is refused, two agree it is no review, its bond goes to the
  company, and the client opens the crew's review and the model's reason with its own key after the job is paid;
  nothing public holds a word of any work; a broken rubric, a missing spec and a reference below the bar refused at
  the check; a bar of 81 refused at `open`, and at 80 nobody clears it: the client gets its reward back and no work, and
  nothing the judge published holds a word of either review or of the client's own; an appeal over five runs whose
  median changes the verdict; NEAR AI answering 503 during an appeal, which spends no seed, makes the contract refuse
  every run until the judge's back-off is over, and decides once it is back; a bland review scored zero on two seeds
  whose seat pays half its bond, and a job whose every striker's box is junk, which gets a verdict at once and whose
  junk loses its bonds.

## Not covered here

- **A model talked into scores within range.** The module refuses what it can check: scores, ranges, one answer, a
  planted answer. A model persuaded to rate junk highly within the rubric on every seed is the limit of any model
  review; with one call per entrant it can only lift the injector's own score, the winner needs two seeds, and the
  appeal takes the median of three.
- **A request that NEAR AI fails every time with a 5xx** keeps its entrant waiting: the verdict goes on without it only
  when it cannot change the winner, else it waits until `judge_until`, when the contract gives the reward back.
- **The signer's attestation.** The signature is consistent, not attested inside the judge: it is over these bytes,
  from the address it names, and NEAR AI marks it `provider_tee`, asked over TLS. That the address is an attested node
  is checked outside the judge with `verify:attestation`, from the signer the evidence carries.
- **Calls in parallel.** A run asks one call at a time: a job of 16 entrants takes several runs, each paid from the
  job's runs (eight in the deposit) and then by whoever calls `judge`.
