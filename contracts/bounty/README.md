# Bounty contract

A team locks NEAR for a race. When a mask breaks the target, the contract asks the judge on OutLayer and pays the
winning mask itself. If nobody breaks the target before the deadline, the team takes its NEAR back.

## Nobody holds the keys

The contract lives on its own account (`bounty.tinygif8324.testnet` on testnet), created, funded, deployed and
initialised in one transaction that adds no key. Nobody, the owner included, can deploy code to it or move its NEAR
by hand. Its rules change only through the contract itself, in the open:

| Change | Who proposes | Waits before anyone can apply it |
| --- | --- | --- |
| New code (`upgrade`, with `migrate` in the same batch) | the admin | 108 hours (the longest race, its claim grace and a day to refund) while any bounty is live; 1 hour with none. No bounty opens meanwhile |
| A new admin | the admin | same as code |
| The judge for new bounties | the admin | 1 hour |
| A new safe code for sealed rounds | the admin | 1 hour |
| Taking a safe code off the list | the admin | none: it only stops new rounds |

`propose(change)` puts one change in `pending()`, `cancel()` withdraws it, `apply()` (or `upgrade()` with the wasm
itself as the input) applies it once the wait is over. A change nobody applied within 24 hours of being ready lapses,
so nothing proposed long ago lands on a bounty opened later. `governance()` shows the admin, the pending change, the
judge for new bounties, the safe codes and how many bounties are live. The whole path (keyless deployment, proposal,
wait, `upgrade`, `migrate`) runs in a real local node in `contracts/challenges/runner/tests/upgrade.rs`.

**Every bounty keeps the judge it opened with, and the team names it.** `open` and `open_safe` take `judge_version`,
the judge wasm (its SHA-256, the key OutLayer gives that version) the team agrees to: if it is not the contract's
judge at that moment, nothing opens. The bounty keeps it in its terms, `get_terms(id)`. A later judge applies to new
bounties only.

## Live safe on chain: a sealed round

The break is a transaction anyone can open in an explorer: a mask drains a real safe on testnet with its own key. On a
public chain every move shows, so the plan is sealed first. The full rules and the sequence of one round are in
[RULES.md](../../RULES.md).

1. The team puts a safe on chain whose code the contract knows (`safe_codes`), e.g.
   [`live-safe`](../challenges/live-safe), a training target with a planted hole that only the round's masks can
   reach. The safe owns itself, names this contract as the one that may lock it to a round (`arbiter`), counts every
   move and logs it as an event.
2. `open_safe(id, safe, masks, min_loot, hours, commit_minutes, reveal_minutes, safe_code, judge_version)` locks the
   bounty. `masks` are the accounts that may win, 1 to 16, and the team is not one of them (by account: a team can
   always list another account of its own). `min_loot` is at least 0.1 NEAR. `hours`
   is at most 24: the judge reads the safe at the opening block, and a regular RPC keeps blocks for a few days only.
   The deposit pays the storage the bounty takes now, sets aside the most every mask may take later (seals, reveals,
   claims), and the rest, at least 0.1 NEAR, is the prize. What is left of the reserve goes back to the team at the end.

   In the same call the contract locks the safe to the round: `arm(id, commit_until, masks, team)` on the safe, where
   `team` is whoever called `open_safe`, then `on_armed`. The safe takes it only from the contract and for the team
   named at its deployment, once, while it is its own owner and nobody has moved it, and only for exactly its masks: a
   round anyone else opens on a fresh safe does not take it. From then on it refuses every move until the commit
   window closes; after that only the masks that sealed move it, in the order of the seals, and each one's first move
   gives it the safe for a 3-minute turn, back as the round left it, while nobody else moves it. A safe that does not
   lock takes no round: `on_armed` marks the bounty `refunded` and sends the team the prize and the whole reserve at
   once. `reveal_minutes` must give every mask its slot: 3 minutes per mask and 3 more. Give `open_safe` 100 TGas.
3. For the first `commit_minutes` a mask seals its plan: `commit(id, hash)`, where `hash` is sha256 of
   `maskwars-commit:<id>:<mask>:<salt>:<plan>` and `plan` is the JSON array of the calls it will send the safe. One
   seal per mask, numbered as they arrive. `get_round(id)` shows every seal; a plan only once it is revealed. The
   contract tells the safe each seal and its number (`queue`), so the safe knows who may play and in which order.
4. For `reveal_minutes` after the window (60 by default) the mask sends the safe exactly the sealed calls in its own
   turn, then reveals them: `reveal(id, plan, salt, txs)` with one transaction per call. Seal #0 plays first; a later
   seal starts once every earlier one has had its turn, or 3 minutes after the window for each earlier seal, and
   only within its own slot of 3 minutes, so late earlier seals never push it past the reveal window. The
   contract checks the plan against the seal. A seal not revealed in time drops out.
5. The mask itself calls `claim_drain(id, tx_hash)` for the plan's sweep, with 180 TGas, until 12 hours after the
   deadline. Claims of different masks go to the judge side by side; each mask has one at a time.

   A mask's first claim in a race may attach nothing: the judge's 0.01 NEAR then comes out of the bounty. This is for a
   mask that holds only function-call keys, which NEAR never lets attach NEAR. Every later claim of that mask attaches
   the fee itself.
6. The judge ([services/judge](../../services/judge), `src/chain.rs`) reads the chain through two RPC sources that must
   agree, and confirms only when:
   - every transaction of the plan is signed by the mask, went to the safe and is exactly the call the plan names,
     succeeded, in order, between the end of the commit window and the deadline;
   - the safe was locked to this round by this contract (`get_round` on the safe: this contract, this bounty, the end
     of this commit window), so nobody moved it while plans were being sealed. The contract tells the judge who it is
     (`contract` in the question);
   - the plan is the mask's own turn, whole: its first call started the mask's one turn (the safe's `turn` event), and
     each call moved the safe once in that turn, the move numbers following one another. A move of another mask in its
     own turn spoils no plan; a mask that moved the safe outside its plan has used its turn;
   - the safe runs the code the round named at the opening and at the drain, and nobody holds a key to it; when the
     round opened it was its own owner and let in exactly the round's masks;
   - the plan moved at least `min_loot` from the safe to the mask, net of everything the mask put in, and no more than
     the safe actually lost. Anyone's plain transfer into the safe during the plan makes the loss look smaller, so
     `min_loot` should sit well below what the safe holds.

   What the lock does not cover: the earliest seal plays first, so it takes the loot in its turn whatever it sealed. If
   it sealed junk, the bounty goes to the next confirmed seal or back to the team, so a team that lists another
   account of its own and seals with it first can take the loot ahead of honest masks. The team chooses the masks:
   check who they are (RULES.md). A mask without a seal never moves the safe.
7. `on_judged` marks the seal `confirmed`. The earliest confirmed seal wins: it is paid at once (`drained`) when no
   earlier seal can still win, otherwise `settle(id)` pays it. An earlier seal holds it back only until the reveal
   window ends, or while that seal's first claim is with the judge. A refused claim marks the seal `refused`, frees the
   transaction and gives way to later seals.
8. The team gets the bounty back after the 12 hours for claims, if no seal was confirmed and no claim is with the judge.

## Sandbox race

A team's private code never leaves the sandbox, so its race is judged from GitHub.

1. `open(id, target, hours, judge_version, masks)` locks the bounty for 1-72 hours. `masks` are the accounts that may
   win it, 1 to 16, the team not among them: whatever a run reports, the contract pays only one of them
   (`get_sandbox`).
2. `Live race` runs with the `bounty` input set. Its last step uploads the `maskwars-result~…` artifact.
3. Anyone calls `claim(id, run_id)` with 180 TGas and at least 0.01 NEAR plus the claim's own storage attached (0.02
   NEAR is plenty), until 12 hours after the deadline. Claims do not wait for each other: junk claims cannot hold up
   the real one. The judge reads the run from GitHub inside a TEE and answers which mask won. It trusts only a
   successful manual run of `.github/workflows/live-race.yml` on `main` of this repository, made after the bounty
   opened (the contract sends the opening time), on a commit in `main`'s history (`compare`), and that run's one result
   artifact for this bounty and target, naming one of the bounty's masks. The GitHub token (read access to Actions
   and to the code) is the judge project owner's OutLayer secret, and OutLayer hands it only to a claim signed by an
   account on that secret's list: today a sandbox race is paid only when we sign the claim. Who wins, when and on what
   code no longer depends on us; whether the claim is sent at all still does.
4. The first confirmed claim pays the winner the judge names (`paid`); later answers change nothing.

## Both

- Each claim has its own record (`get_claim`). The judge's answer releases it, whatever the answer is: `on_judged`
  never fails, reads at most 4 KB of answer, and pays the storage it adds out of the bounty's reserve.
- Only the judge's own `no` refuses a seal. A run that failed or an answer that cannot be read refuses nothing and
  gives a mask its free claim back.
- A drain counts as claimed only once the judge confirms it: a rival naming another mask's sweep in its own plan holds
  nothing up.
- A claim the judge never answers is dropped by anyone with `unstick(id, claim)` 600 blocks after it was made
  (OutLayer itself gives up after 200), and a free claim comes back. An answer that still turns up later is ignored.
- A payout to an account that does not exist bounces and reopens the bounty (`on_paid`). A payout that went through
  sends what is left of the storage reserve back to the team.
- After the deadline and the claim grace anyone may call `refund(id)`; the NEAR goes only to the owner.
- The judge's answer gets 40 TGas of its own, so a payout never runs out of gas half-way.

## Upgrade

`upgrade()` deploys the proposed wasm and calls `migrate` in the same batch. `migrate` reads whatever state it finds
and keeps all of it: the current one unchanged, or an older contract's (before sealed rounds, or before per-claim
records), whose bounties keep that contract's judge. New `Status` and `SealState` variants only go last, because what
is already on chain is stored in Borsh.

Tests: `cargo test`. Build: `RUSTFLAGS='--cfg near -C link-arg=-s' cargo build --release --target wasm32-unknown-unknown`.
