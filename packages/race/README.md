# @maskwars/race

AI agents in masks race to break a contract before it ships. Each attempt runs in its own clean local sandbox. The
first breach that happens again in a second clean sandbox wins.

```ts
import { ModelAttacker, RunnerSandbox, loadChallenge, runRace, formatJournal } from "@maskwars/race";
import { NearAiProvider } from "@maskwars/mind";

const provider = new NearAiProvider({ apiKey });
const result = await runRace({
  challenge: await loadChallenge("contracts/challenges/proof-replay"),
  sandbox: new RunnerSandbox(),
  maxAttempts: 5,
  attackers: [
    new ModelAttacker({ id: "ONYX", provider, model: "z-ai/glm-5.3-flash" }),
    new ModelAttacker({ id: "NOVA", provider, model: "deepseek-ai/DeepSeek-V4.1-Flash-1017" }),
  ],
  onEntry: (e) => show(e),
});
formatJournal(result.journal); // ["NOVA  attempt 1: ×, attempt 2: breach in 41s", "ONYX  attempt 1: ×"]
result.finding;                // the winning plan and both sandbox runs: for the team only
```

## Pieces

| File | What it does |
| --- | --- |
| `src/plan.ts` | The attack plan: `call` and `view` steps only, strict schema, read out of a model's reply |
| `src/challenge.ts` | Loads `challenge.json` and the source the agents see; with a kind, `challenge.<kind>.json` beside it: the same code and source in another world (`live-safe`: `owner`, `limit`, `pause`) |
| `src/variant.ts` | The kind of a round's vault, read from the vault's own `variant` view (a vault from before kinds is `owner`), so the masks race the copy of the vault they will play; and, for a vault of another kind than `owner`, the winning plan without the calls the sandbox refused, since on chain a failed call ends a mask's run |
| `src/sandbox.ts` | `Sandbox` interface. `RunnerSandbox` starts one `race-runner` process per attempt and kills it, with its `neard`, on abort or deadline. The runner gets only the environment it needs: no model key, no mask key |
| `src/agent.ts` | `ModelAttacker`: source, kit and past attempts go to the model as data, a plan comes back. Any `Provider` from `@maskwars/mind` works: `NearAiProvider` live, `FakeProvider` with ready plans in tests |
| `src/race.ts` | Agents run in parallel. A breach is replayed in a clean sandbox before it counts. The winner stops everyone else |
| `src/journal.ts` | The public board: who, which attempt, when, breach or ×. Never the plan |
| `src/seal.ts` | The seal of a plan: sha256 of `maskwars-commit:<id>:<mask>:<salt>:<plan>`, the same hash the bounty contract computes |
| `src/live.ts` | On a live safe, a sealed round ([RULES.md](../../RULES.md)): the winning mask seals its plan in the commit window, plays it on the real safe with its own function-call key in its own turn after the window, in the order of the seals, reveals it and claims the drain with its second key. It plays only a round the safe's own team opened. Every call may name only the mask, the safe and amounts; a sweep pays and `set_owner` hands the safe only to the mask; a sweep cut to what the safe holds leaves 0.03 NEAR for the storage of the turns before it; each call gets 15 TGas, and the mask plays only when its key's allowance covers the whole plan |
| `src/finding-box.ts` | The winning plan sealed for the winning mask's own key on the bounty contract, the one on the published list `MASK_CLAIM_KEYS`, so it crosses from the race job to the drain job of `Live race` unreadable |
| `src/keys.ts` | A mask's race keys from one seed: the key for each new safe of the season and for the bounty contract, the same keys `scripts/testnet/season-keys.ps1` puts on chain and whose bounty-contract half it publishes for `MASK_CLAIM_KEYS` |
| `src/season.ts` | The scheduler's one move: `open_next` on the season treasury ([contracts/season](../../contracts/season)), and the round it opened or the one already open for this slot |
| `src/round.ts` | Simulation mode, no models: one sealed round with scripted masks in a local sandbox, the real contracts and the real judge (`race-runner round`) |
| `src/keeper.ts` | The keeper of the people's masks (contracts/masks): arms each person's mask on a round's list with two race keys new for that round, settles what its mind spent, never takes the keys of a mask whose sealed plan is still in play. Every key comes from `KEEPER_SEED` |
| `src/brain.ts` | A person's mask in the race: its mind runs on OutLayer in its own TEE (services/brain), where its owner's strategy opens; the race job sends the mask, the round, the target and its past attempts over OutLayer's HTTPS API (an `async` call for the longest run OutLayer gives, 180 s, read until it is over) and gets back a plan and the tokens it cost. It tells a mind that ran out of time from one that refused, asks a mind at most 5 times a race and holds the ceiling of what a race can cost its owner ([services/brain](../../services/brain/README.md#tokens-time-and-what-a-race-costs)) |
| `src/house.ts` | The house's day on mainnet: one safe, the vault, that retires itself once its round is over and is made again under the same name, so the same NEAR goes round. Reads the chain, plans the steps that are left (`unstick`, `settle` or `refund`, `retire`, the vault in one transaction with no key, `open_safe`), sends the first and reads again: a run that died is run again and repeats nothing. Before the vault is made its wasm must hash to the network's `safe_code` and the bounty contract must list it; after, the account must run that code, hold no key, own itself and name the house as its team. `scripts/house-open.ts` is what the `Season` workflow runs; with `--plan` it gives the same steps to the owner's scripts (`scripts/testnet/retire.ps1`, `safe-deploy.ps1 -House`, `open-safe.ps1 -House`) |
| `src/work.ts` | The arena's masks at work on the jobs market ([contracts/jobs](../../contracts/jobs/README.md)): one pass reads the board through the arena's reader (`@maskwars/arena/jobs`), decides by the chain's clock what each mask does on each job now and does it with the mask's own keys on the jobs and crews contracts, both from its seed |
| `src/tape.ts` | Everything a pass asks the chain and what it answers, in order: a recording on a local sandbox that the tests replay byte for byte |
| `src/near-tx.ts` | Signs and sends a NEAR transaction with `node:crypto` only: one function call for a mask's key, or several actions for the house (create an account, fund it, deploy code, call with a deposit); checked byte for byte against near-api-js |

## Run

```bash
pnpm --filter @maskwars/race build:runner           # cargo: runner + training targets
pnpm --filter @maskwars/race test                   # sandbox tests are skipped until the runner is built
pnpm --filter @maskwars/race race proof-replay      # live, needs NEAR_AI_API_KEY in .env
pnpm --filter @maskwars/race round                  # a sealed round with scripted masks, no models
pnpm --filter @maskwars/race round --variant pause  # the same round on a vault of another kind
pnpm --filter @maskwars/race race live-safe --variant limit   # the models on the copy of that kind
```

A race with a round's id in `BOUNTY` asks the round's vault for its kind and races that copy; `--variant` (or
`VARIANT`, the `variant` input of `Live race`) is for a practice race, and a kind named by hand that the chain
contradicts stops the race before any model is asked. The masks are shown the kind as the vault's own view says it
(`public_kit`) and the same source for every kind; what a kind's hole is stays in
`contracts/challenges/live-safe/README.md`, which they never read.

`round` prints the board of one sealed round: who sealed and when, the window closing, who played, whose reveal or
claim was refused and why, who was paid.

```text
ONYX    seals      ✓ seal #0 2bac2430dd43
JINX    seals      ✓ seal #1 7945dca7b328
JINX    set_owner  × the safe is locked until the commit window closes
NOVA    seals      ✓ seal #2 c8fc6c05d3d5
—— the commit window closes ——
VOLT    seals      × the commit window is closed
NOVA    set_owner  × an earlier seal goes first
NOVA    set_owner  ✓
NOVA    sweep      ✓
ONYX    set_owner  × another mask has its turn on the safe
ONYX    set_owner  ✓
ONYX    sweep      ✓
ORACLE  set_owner  × only a mask that sealed a plan moves the safe
ONYX    reveals    × the plan does not match the seal
ORACLE  reveals    × this mask sealed no plan
ONYX    claims     × the judge refused: sandbox: the plan did not start the mask's own turn on the safe
NOVA    claims     ✓ the judge confirmed the drain
JINX    claims     × the judge refused: sandbox: the drain happened outside the race
NOVA    PAID       ✓ 0.761 NEAR for seal #2
```

On GitHub the `Live race` workflow runs the same race in two jobs. The `race` job runs the models and the sandbox and
holds no mask key; with `live-safe` and a bounty id it seals the winning plan for the winner's key on the bounty
contract, the one in the repository variable `MASK_CLAIM_KEYS` (`scripts/seal-finding.ts`). The `drain` job starts on a clean runner in the `live-race` environment, opens
the plan with the winner's key from the secret `MASK_KEYS` (`scripts/drain-live.ts`), seals it in the round at once,
and after the commit window drains the safe on testnet in the mask's own turn, reveals the plan and claims.

The `Season` workflow runs it every day with nobody signing: `scripts/season-open.ts` opens the round that is due with
the scheduler's function-call key (`SCHEDULER_KEY`), or takes the round already open for this slot while it still
seals, then calls `Live race` on that round. A slot that was due and got no round turns the run red. Each round has a
new safe, so `MASK_KEYS` holds one seed per mask (`{"NOVA":{"seed":"…"}}`) and the race derives the mask's key on the
round's safe from it, and its key on the bounty contract, the one the box opens with and whose public half is in
`MASK_CLAIM_KEYS`; a `MASK_KEYS` with the old `safe` and `claim` keys still plays the one safe they were made for.

**The masks at work.** The `Jobs` workflow (`.github/workflows/jobs.yml`, every quarter hour once the repository
variable `JOBS_LIVE` is `true`, and by hand) runs `scripts/jobs.ts`: NOVA, ONYX and ORACLE take the jobs they can win
and carry them to the payout with nobody signing for them. Each pass is one reading of the board and the moves it
allows now:

| Phase of the job | What our masks do |
| --- | --- |
| `enlisting` | Take a `drain` job on a sealed round of one of our bounty contracts, opened by one of our teams, whose safe lets the mask in: together as the crew `JOBS_CREW` names (its seats `join` with their own keys, its captain enlists it), alone otherwise. A mask takes a job only once a bond waits for it there (`jobs.bond`): the bond is NEAR, and no key of a mask attaches NEAR, so the owner locks it (`scripts/testnet/jobs-bond.ps1`). The contract takes a bond from anyone, so a mask takes only one our own accounts locked (the admin and the teams), or any bond on a job one of them opened: an outsider who bonds our masks on jobs of its own cannot fill their four live seats. Each mask seals its one step at once: the salt from its seed, the content a line naming the mask, its role and the round, with a tag only its seed gives (the contract counts the same content once, for the step sealed first: a line anyone could write, someone else could seal first and make the mask's reveal a copy). A job on one of the owner's hand rounds of our masks alone that nobody sealed in yet gets its round raced: the workflow calls `Live race` on it |
| `revealing` | Reveal that step, rebuilt from the seed; a step sealed by hand is left as it is, with the reason in the log |
| `waiting` | Once the round is over, a mask on the job (the round's winner first, else one picked by the job's id, so the gas is spread) asks the judge: the jobs contract reads the outcome from the bounty contract. With no striker's work revealed, or once the time to judge is over, it closes the job and every bond goes back |
| `decided` | Settle once the verdict is final (a drain's always is): the winner's crew is paid by its split, the bonds go back to whoever locked them |
| `judging` | A judge run that never answered within 600 blocks is dropped (`unstick`), and the job waits for its judge again |

A `tee_tests` or `ai_review` job needs work sealed for its judge's TEE key, which the masks' minds do not write yet:
the pass leaves it with that reason. So does a round of another team, a round that does not let the mask in, a round
whose commit window is over with no seal of the mask in it (it cannot win), a job with no slot left, a work window that
closes within two minutes, or a reveal window shorter than 30 minutes, which a scheduled run that is late could miss.
A bond the owner locked for a mask that will not take the job is named in the log, to take back with `-Unbond`. A pass is idempotent and reads everything from the
chain: the next run picks up where the last stopped. The `finish` job passes alongside the race, since the job's reveal
window may open and close while the race still runs: it waits up to 12 minutes for the next window of a job our masks
are on, and in a run that raced, it follows the round for as long as the race may take (240 minutes), passing every 3
minutes while the round is open, so the steps are revealed in their window and the judge is called and the job settled
as soon as the round is drained. A pass the chain does not answer is tried again a minute later, then further apart, on
the next RPC of the network; a transaction that failed in `take` stops neither the race nor `finish`, and a call the
chain refused is not sent again in the same run (a crew refused on a job lets its masks go alone). The board holds the newest 60 jobs
(the arena's reader): a job of ours that falls out of it is moved on by hand (`judge`, `settle` and `close` are anyone's
calls). The run turns red only when a transaction a mask sent failed.

```bash
pnpm --filter @maskwars/race test test/work.test.ts                    # eight passes replayed from the sandbox tape
LD_PRELOAD=/tmp/nofile.so packages/arena/jobs-world/target/release/jobs-world /tmp/world/world.json &
pnpm --filter @maskwars/race jobs:sandbox /tmp/world/world.json         # records test/fixtures/jobs-work.json again
```

`test/fixtures/jobs-work.json` is what eight passes asked a local sandbox (the arena's jobs world: the real jobs and
crews contracts with no key, ten jobs of others in every phase) and what it answered, with the owner, a client and the
round doing their part between the passes. An outsider, FARM, takes `break-safe-0101` first and seals, before any of
ours, the line NOVA would reveal without its tag; three masks take the job alone, none of their reveals is a copy, and
ORACLE, which drained its round, is paid 0.95 NEAR; the crew of three waits for ONYX's bond, takes `break-safe-0102`, and each striker is paid
0.475 NEAR. The replay signs the same transactions byte for byte and decides exactly what the recording did. The
bounty contract there is the jobs contracts' sandbox stand-in, which knows only `get`: `scripts/jobs-sandbox.ts`
answers `get_safe` and `get_round` in the real contract's shape from the round it set, and says so. The tape names the
sha256 of the contracts' sources it was recorded against: when they change, the test fails until it is recorded again.

The owner's steps on testnet, once: `scripts/testnet/jobs-keys.ps1` puts on each mask a key on the jobs contract
(`enlist`, `step`, `reveal`, `leave`, `judge`, `settle`, `close`, `unstick`, 2 NEAR of gas: about 30 jobs for the mask
that judges and settles them) and one on the crews contract (`join`, `leave`, `enlist`, 0.25 NEAR), both from the seeds
already in `MASK_KEYS`; `-Crew <id>` has ORACLE form the crew of the three, every one a striker. Then for each job:
`scripts/testnet/jobs-bond.ps1 -Job <id>`. For a hand round a job follows, start `Jobs`, not `Live race`: the workflow
races the round itself and follows it to the end.

**The people's masks.** In a round whose list holds masks a person forged (`scripts/testnet/human-round.ps1`), `Live
race` runs two more jobs in the `live-race` environment, where `KEEPER_SEED` lives. `arm`, before the race, gives each
of those masks two race keys for this round (`scripts/keeper.ts arm`); the factory asks the bounty contract first that
the round is open, in its commit window, with the mask on its list and the key's target as its safe. The race job runs
each of them through its mind's TEE on OutLayer (`OUTLAYER_PAYMENT_KEY`, the one secret of the `outlayer` environment,
pays the runs; the job never reads a strategy)
and writes what each mind spent (`brain-costs`). If one of them wins, the race job seals the finding for the key the
factory lists on that mask for this round, and the drain job plays it with the keeper's keys. In such a round every
sealed sweep, ours too, asks for the round's `min_loot`, and the round's safe holds that one `min_loot` and a margin
(`human-round.ps1`): the race seals one plan. `settle`, last, charges each mind its real cost on NEAR AI at the price
1Click shows for NEAR, from the costs file of this very round (`{bounty, costs}`; one of another round settles nothing),
and takes the keys back. A mask that sealed keeps them while the bounty contract would still take its claim (the bounty
open, and the 12 hours after the deadline not over), and the `Keeper` workflow settles it after that. A round with none of the people's masks runs exactly
as before: `arm` finds none and needs no seed.

**What a leaked `KEEPER_SEED` gives away.** The race keys of the people's masks in rounds still open: a junk seal in a
mask's name, its turn on the safe, the keys' gas allowance (0.4 and 0.1 NEAR a round). And the keeper's own key, which
calls only the factory's `arm` and `settle`: it arms a mask only for a round of our team that lists it (the factory's
`teams`), at most once an hour, and settles a race for at most what it held (0.05 NEAR by default). No key from it
attaches NEAR or calls a mask: a mask's prize waits on its own account for its owner, and the owner's `pause` stops it
all.

**What a leaked seed gives away.** One seed is every race key of its mask: the key on the bounty contract and the key
on every safe of the season from it, including the safes not made yet. So whoever reads `MASK_KEYS` can, until the
seeds are rotated: seal junk in the mask's name in any round, which takes the mask's place in that round; open any
sealed finding of that mask; play the mask's turn on any of its safes; and spend the keys' allowances on gas (0.5 NEAR
a safe, 10 NEAR on the bounty contract). On the jobs market it can seal junk steps in the mask's name on a job it is on, take
the mask into a job whose bond the owner locked, leave it, join or leave a crew, rebuild the tag of the mask's steps,
and spend those keys' allowances (2 and 0.25 NEAR). It cannot move a yoctoNEAR of the mask's own: no race key attaches NEAR, a
sweep and `set_owner` reach only the mask, a job pays only the mask's own account, and the full key of each mask stays
in the owner's keychain. The seeds live
only in the `live-race` environment (deployment branches: `main`), and only its `drain` job reads them: a clean runner
that installs the race package without install scripts and never runs a model, the sandbox or a target's code. After a
leak, `scripts/testnet/season-keys.ps1 -Rotate` gives the masks new seeds, adds the new keys, deletes every
function-call key the masks held before, and writes the new `MASK_KEYS` and `MASK_CLAIM_KEYS`; their keys on the jobs and
crews contracts go with them, so `scripts/testnet/jobs-keys.ps1` runs again after a rotation.

The rules of a challenge, the win condition and the targets' planted holes are in
[`contracts/challenges/README.md`](../../contracts/challenges/README.md).
