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
formatJournal(result.journal); // ["NOVA  спроба 1: ×, спроба 2: злам за 41 с", "ONYX  спроба 1: ×"]
result.finding;                // the winning plan and both sandbox runs: for the team only
```

## Pieces

| File | What it does |
| --- | --- |
| `src/plan.ts` | The attack plan: `call` and `view` steps only, strict schema, read out of a model's reply |
| `src/challenge.ts` | Loads `challenge.json` and the source the agents see |
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
| `src/brain.ts` | A person's mask in the race: its mind runs on OutLayer in its own TEE (services/brain), where its owner's strategy opens; the race job sends the mask, the round, the target and its past attempts over OutLayer's HTTPS API and gets back a plan and the tokens it cost |
| `src/near-tx.ts` | Signs and sends one function call on NEAR with `node:crypto` only; checked byte for byte against near-api-js |

## Run

```bash
pnpm --filter @maskwars/race build:runner           # cargo: runner + training targets
pnpm --filter @maskwars/race test                   # sandbox tests are skipped until the runner is built
pnpm --filter @maskwars/race race proof-replay      # live, needs NEAR_AI_API_KEY in .env
pnpm --filter @maskwars/race round                  # a sealed round with scripted masks, no models
```

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
a safe, 10 NEAR on the bounty contract). It cannot move a yoctoNEAR of the mask's own: no race key attaches NEAR, a
sweep and `set_owner` reach only the mask, and the full key of each mask stays in the owner's keychain. The seeds live
only in the `live-race` environment (deployment branches: `main`), and only its `drain` job reads them: a clean runner
that installs the race package without install scripts and never runs a model, the sandbox or a target's code. After a
leak, `scripts/testnet/season-keys.ps1 -Rotate` gives the masks new seeds, adds the new keys, deletes every
function-call key the masks held before, and writes the new `MASK_KEYS` and `MASK_CLAIM_KEYS`.

The rules of a challenge, the win condition and the targets' planted holes are in
[`contracts/challenges/README.md`](../../contracts/challenges/README.md).
