# The tee_tests judge

A client hires masks for work a test can prove: a function that passes a private benchmark, a patch that passes the
client's own tests. The client keeps its test set secret; the masks keep their work secret. Both open only inside this
module's TEE on OutLayer, and the jobs contract ([`contracts/jobs`](../../contracts/jobs)) pays the work that passes
the most cases.

## The main rule

Whoever did the work honestly gets paid, and nobody gets the work for free. So:

- **The work is private.** Every revealed step is a box sealed for this judge's key; the client, the other masks and
  the chain see ciphertext before the verdict and after it. The client gets the winner's work alone, and only once
  the job is paid: the judge opens the winner's boxes in its TEE and seals them again for the client's key
  (`"deliver":true`). Work that did not win the judge never seals for anyone.
- **Before any mask starts**, the judge checks the client's material (`check`): the test set is the one the job
  published, it is what the job's `bar` says (`win_at`, number of cases, fuel a case), and the client's own solution,
  sealed for this judge's key and carried in the bar, passes at least `win_at` of its cases. A set nobody can pass
  never opens to masks; anything wrong sends the client everything back before anyone works. A set that passes is
  **kept in the project's private storage** under the job it was checked for (`tests/<contract>/<job>/<sha256>`): the
  contract names the client's secrets row for the check only, and every later run of that job, and no other job's,
  reads the judge's own copy. Nothing the client changes after the check reaches a verdict.
- **Fake only for objective reasons.** A box that does not open for its mask, a striker's box that holds no module, a
  module that does not load (not Wasm, imports anything, does not export `memory`, `alloc(i32) -> i32` and
  `run(i32, i32) -> i64`): fake, and its mask loses its bond to the company, never to the winner. A work that loads
  and passes no case of the private set is **never** fake: its mask could not see the set. So a client's puppet that
  knows the set and wins collects nobody's bond.
- **Counted only for passing something.** A work that passes at least one case is a real attempt and counts, with its
  crew's scout and verifier steps; one that passes none counts for nothing. The verdict's `counted` is how the judge
  tells the jobs contract a seat gave the job something: a seat with no counted step pays half its bond to the
  company, so a module that loads and passes nothing holds no slot for free.
- **The judge serves one jobs contract and its own key.** The contract's account is written into the wasm (`job.rs`,
  `served`): `jobs.tinygif8324.testnet` on testnet, and on mainnet none until the owner registers `maskwars.near`, a
  name anybody could take while it is free. A run asked by any other account answers nothing, so a contract of someone
  else's gets no oracle on a private set. A job pinned to another key gets no check, verdict or delivery.
- **No verdict at all** (the chain unreachable, the kept set lost): nobody is named, and at `judge_until` the contract
  gives the client its reward back. The client saw none of the work.

## A run

The jobs contract asks `{"job","contract","kind":"tee_tests","appeal","prior","check","deliver"}`. The judge:

1. answers only the jobs contract written into it (`jobs.tinygif8324.testnet` on testnet; on mainnet none until the
   owner registers `maskwars.near`), only when that contract called OutLayer (`NEAR_PREDECESSOR_ID` = `contract`), and
   only a job that pinned this project and this judge's own key;
2. reads the job, its entrants and its steps at one final block through two RPC sources of two operators, the OutLayer
   worker's (FastNEAR) and dRPC, which must give the same answer ([`src/job.rs`](src/job.rs));
3. for a check, takes the test set from the client's own secrets row the job named, checks its sha256 against the
   job's `rubric` and its shape against the job's `bar` ([`src/suite.rs`](src/suite.rs)), runs it on the client's own
   solution, keeps it and answers; for a verdict, takes the set it kept;
4. takes each striker's latest revealed step and opens it: the work module rides in the box, so the whole work is on
   chain and nothing a mask names elsewhere is fetched ([`src/sealed.rs`](src/sealed.rs));
5. runs every case on every work in a WebAssembly interpreter with fuel, a fresh instance per case
   ([`src/run.rs`](src/run.rs)), keeps the winner's boxes for the client (`won/…`) and answers.

| Situation | Answer |
| --- | --- |
| Check: the set is the published one and the bar's, and the client's solution passes `win_at` | `{"checked":true,"win_at","cases","fuel","reference":{"passed","of"}}`, the set kept: the work window starts |
| Check: the set is missing, not the client's, changed, not the bar's or not runnable here; the client's solution is not sealed for this judge, job and client, or passes fewer than `win_at` | `{"checked":false,"why"}`: everything back to the client |
| Verdict | The work that passes the most cases wins if it passes at least `win_at`; on a tie, the earlier seal, which wins the reward and no bond. A work that passes at least one case is a real attempt: its step counts, with its crew's scout and verifier steps |
| A box for another mask or job, a striker's box that holds no module, a module that does not load | Fake: not counted, its mask loses its bond to the company. Nothing in one mask's box can fail the judge's run |
| A module that loads and passes no case | Neither counted nor fake: its fuel is its own tank's, and on the contract its seat pays half its bond to the company, as a seat with no counted step does |
| Appeal | The works that could win, best first, run the set twice more, backwards and in an order shuffled by the job; the first whose three runs agree case by case may win, at most three are rechecked. The answer is final |
| Delivery, once the job is paid | The winner's boxes, kept at the verdict, opened and sealed again for the client's key: `{"delivered":"delivery/<contract>/<job>","sha256"}`, the box in the project's public storage. Before the job is paid: no answer |
| The chain unreachable, the sources disagree, the kept set gone | No verdict (`success: false`): the contract waits for a judge again |

Same inputs, same verdict: the interpreter (wasmi 2, `deterministic` profile) canonicalises NaNs, a work imports
nothing, fuel stops it, and a case burns the same fuel whichever case ran first, because translating a function is not
charged to the case that first calls it.

## Formats

**Verdict** (stdout; the contract reads `job`, `winner`, `counted` and `fake`, at most 4096 bytes):

```json
{"success":true,"error":null,"output":{"job":"bench-0001","winner":0,"counted":[0,1,2],"fake":[3],
 "judge":"tee_tests","rule":"tests","works":[{"step":0,"entrant":1,"passed":8,"of":12},{"step":2,"entrant":0,"passed":12,"of":12},
 {"step":3,"entrant":2,"passed":0,"of":12,"invalid":"the box holds no work module"}]}}
```

`rule` is `tests` or `tests, three runs` (appeal). A work entry may add `"runs":3`, `"unstable":true` or
`"invalid":"<why it did not run>"`.

**Delivery** (stdout, once the job is paid): `{"success":true,"error":null,"output":{"job","delivered":
"delivery/<contract>/<job>","sha256":"<hex>"}}`. The box under that key is `mwd1.` and base64url of `eph_pub (32) ‖
nonce (12) ‖ AES-256-GCM`, keyed by HKDF-SHA256 over X25519 with the client's key (`client_key`), info
`maskwars:delivery:v1`, associated data `maskwars:delivery:v1:<contract>:<job>:<client>`. Inside:
`{"job","contract","entrant","work":[{"seq","mask","role","module":"<base64url>"} or {…,"text"}]}`.

**Check** (stdout): `{"success":true,"error":null,"output":{"job","judge":"tee_tests","checked":true,"win_at":10,
"cases":12,"fuel":20000,"reference":{"passed":12,"of":12}}}`, or `"checked":false` with `why`.

**Bar** (the job's terms, set by the client at `open`): `{"win_at":10,"cases":12,"fuel":"20000","reference":"mw1.…"}`.
`reference` is the client's own solution, sealed like a mask's work but with the client's account as the mask.

**Test set**: the secret `MASKWARS_TESTS` in the client's row, exactly the bytes whose sha256 is `rubric`:

```json
{"format":"maskwars-tests/v1","fuel":20000,"win_at":10,
 "cases":[{"input":"nova.testnet","expect":"yes"},{"input_b64":"AAH/","expect_b64":"/wEA"}]}
```

At most 64 KiB, 1 to 32 cases, input and expected output 4096 bytes each, `fuel` 1 000 to 500 000 a case and
`fuel × cases` at most 500 000. A case passes when the output is byte for byte `expect`. An unknown field refuses the
set.

**Work module**: a WebAssembly core module of at most 638 bytes (what one box carries) that imports nothing and exports `memory`,
`alloc(len: i32) -> i32` (where the judge writes the input) and `run(ptr: i32, len: i32) -> i64` (the output,
`ptr << 32 | len`). Memory grows to 4 MiB, the call stack to 512 frames. The sandbox's work is Rust (`no_std`) in 453
bytes: [`sandbox/work`](sandbox/work).

**Sealed work**: the step's content, `mw1.` and base64url of `eph_pub (32) ‖ nonce (12) ‖ AES-256-GCM(key, nonce,
padded, aad)`, with `key = HKDF-SHA256(X25519(eph, judge), salt = eph_pub ‖ judge_pub, "maskwars:work:v1")` and
`aad = "maskwars:work:v1:<contract>:<job>:<mask>"`. `padded` is 640 bytes: the kind (`1` a module, `2` UTF-8 text) `‖
work ‖ 0x80` and zeros. Every box is 938 characters and fits a step; the jobs contract takes no other content on a
`tee_tests` job. [`vector.json`](vector.json) is a box computed with Python's `cryptography`; the
Rust tests produce the same bytes.

## Budget

The jobs contract runs a judge with 1e9 instructions. An interpreter inside a metered module is expensive, and a work
built to exhaust the judge would leave the job without a verdict, so the limits are set for the worst job, not the
usual one: 16 strikers, each with a module as big as a box holds that reaches all its code, declares 4 MiB of memory and burns
every unit of fuel on every case; the test set at its limits; three appeal rechecks; the biggest views read from two
sources. [`sandbox/tests/budget.rs`](sandbox/tests/budget.rs) runs the judge's own code, built for a bare Wasm host
with the release profile, inside a fuelled interpreter that counts every instruction, and fails if that worst run
passes 85% of the limit. Measured:

| Part of the worst run | Instructions |
| --- | --- |
| one 567-byte work burning all 500 000 fuel over 32 cases (load, translation, 32 instances) | 36.2 M |
| 16 such works, first verdict (boxes opened, modules loaded, every case run) | 491.7 M |
| one appeal recheck: two more runs of a work passing every case on its last units of fuel | 25.2 M |
| reading the job: the biggest `get` (its bar carries the client's sealed solution), `entrants` and `steps` answers, counted twice for two sources | 106.2 M |
| **worst run: 16 works + 3 rechecks + reading** | **673.5 M of 1 000 M (67%)** |

Two choices make that possible. A view's answer is a JSON array of tens of thousands of numbers: the judge finds and
reads it in one pass instead of a JSON parser (215 M for the biggest `steps` answer alone before, 53 M for all three
views now), compares the second source's bytes with the first's and parses the job once. The interpreter validates a
module when it loads and translates each function the first time a case calls it, which bounds translation by the
module's size.

A check costs far less than a verdict: it reads a job with no steps and runs the set once, on the client's own
solution, at most what one work costs (36.2 M).

The release profile is `opt-level = 3`: at `"z"` an instance of the same work costs about 50 times more instructions.
Bigger benchmarks need a bigger instruction limit for `tee_tests` runs in the jobs contract (OutLayer allows up to
5e11) and a judge version with limits measured for it.

## Keys and secrets

| Secret | Row | Who reads it |
| --- | --- | --- |
| `PROTECTED_TESTS_SEED` (hex32, generated inside the TEE) | the project author's, profile `judge`, named by the module's own manifest | every run; nobody else, the arena included |
| `MASKWARS_TESTS` | the client's own, under this project, the profile the job names (`secrets`) | only this judge's check: the jobs contract names the row for the check alone, and the judge keeps its own copy in the project's private storage |

The manifest is a custom section of the wasm, covered by its sha256 ([`manifest.json`](manifest.json)): the author's
secrets row, and the only hosts the module may reach, dRPC's mainnet and testnet RPCs. The judge checks that
`MASKWARS_TESTS` came from a row owned by the job's client with the job's profile. A client cannot plant a
`PROTECTED_TESTS_SEED` of its own: OutLayer refuses to start a run in which the author's secrets and the caller's both
define a name (app.outlayer.ai/docs/secrets), and the client's row is named for the check alone, before any mask
starts.

## Build and publish

```bash
services/judge-tests/build.sh
```

prints the sha256 of `target/wasm32-wasip2/release/maskwars-judge-tests.wasm`; a build in another folder or on another
machine gives the same bytes. Then, on the owner's OutLayer account:

1. publish the wasm as project `<owner>/tests`, version = its sha256;
2. `outlayer secrets set --generate PROTECTED_TESTS_SEED:hex32 --project <owner>/tests --profile judge --access
   whitelist:<owner> --direct --via <jobs contract>`: the owner's own runs and runs through the jobs contract, nothing
   else (a copycat contract's runs are refused before the module starts, and the module itself answers no contract but
   the one written into it). The jobs contract must be deployed at that account; changing it is a new judge version.
   **Mainnet:** this wasm serves no mainnet contract. Only after the owner registers `maskwars.near` is
   `jobs.maskwars.near`, that same name, written into `SERVED_MAINNET` (`job.rs`) and the judge built again for mainnet;
3. one run with `{"action":"key"}`: the answer, signed with the enclave's attestation, is the key masks seal for
   (`x25519:<hex>`); publish it next to the version;
4. on the jobs contract, the admin proposes `Change::Judge` for `tee_tests` with the project and the sha256; anyone
   applies it after an hour.

A client stores its test set with
`outlayer secrets set '{"MASKWARS_TESTS":"…"}' --project <owner>/tests --profile <job profile> --access
whitelist:<client> --direct --via <jobs contract>`, seals its own solution for the judge's key with its own account as
the mask, and opens the job with `secrets: {profile, account_id}`, `rubric` = sha256 of exactly those bytes and
`bar: {win_at, cases, fuel, reference}`. Then anyone calls `check`. Without `--via` limited to the jobs contract, another contract could run the judge on
its own works against the set and learn from the scores.

## Tests

```bash
cargo test
cargo test -p job-judges-sandbox --test budget
LD_PRELOAD=/tmp/nofile.so cargo test -p job-judges-sandbox --test tests_job
```

- Unit tests (37): reading a job at one block and a paid job for a delivery, a view's byte array wherever the RPC puts
  it, sources that disagree, a judge asked by another contract or for another project's job, the contracts written
  into the judge, a job pinned to another key, boxes for another mask, job or judge, boxes crafted to break the
  padding, text boxes, the delivery (only the client's key opens it, a different work never shares a key), the test
  set's limits, fuel, memory and stack limits, modules that import, export no memory, `alloc` or `run`, or break the
  convention, ties, `win_at`, fake work, a work that loads and fails the private set never fake, the check (the
  client's own solution, the bar, a solution sealed under another name, the set kept for its job alone), the verdict on
  the kept set whatever the client's row says, appeal runs, the winner's work for the client alone and only once paid,
  the vector, a mainnet run that serves no account the owner does not hold.
- Sandbox, against the real jobs contract (`contracts/jobs`): a private benchmark on NEAR account ids from `open` (and its
  check, which runs the client's own solution and keeps the set) to `settle` and the delivery with the judge's own
  verdict (a crew's Rust work, 453 bytes, passes 12 of 12 and splits the reward 30/70; a sloppy one passes 8; FARM's
  text box is fake and its bond goes to the company; the client opens NOVA's module with its own key after the job is
  paid); a test set nobody can pass refused at the check, everything back; the client hiding or swapping its test set
  after the check and appealing (the judge reads its own copy, NOVA wins, the puppet loses its bond to the company, the
  appeal's bond goes to the company); an appeal that runs the set three times and upholds a stable verdict; a client's
  puppet that knows the hidden set and wins, while two honest works load and pass nothing: not fake, not counted, each
  of their seats pays half its bond to the company, and the puppet gets the reward and no bond; a jobs contract of someone else's that copies a job and asks the judge for a check and a
  verdict: refused both times, nothing read or kept.

The sandbox's neard asks for 65 535 open files; the shim is in [public/JUDGE-PATH.md](../../public/JUDGE-PATH.md).

## Not covered here

- **The kept set lost.** If the project's storage loses the set the check kept, no verdict comes and at `judge_until`
  the client gets its reward back, having seen none of the work. That is the judge's failure, not the client's: the
  module never answers `shared` after the check.
- **A wrong but loadable module.** A work that loads is never fake, however bad: one that passes at least one case is
  a real attempt and counts; one that passes none is neither counted nor fake, and its seat pays half its bond, as an
  honest mask's that misread the private set does too. That is the price of a seat that gave the job nothing.
- **The key's provenance.** That `{"action":"key"}` ran this wasm is in OutLayer's attestation of that run; checking it
  is a step for whoever publishes the key, which the jobs contract pins with the judge's version.
