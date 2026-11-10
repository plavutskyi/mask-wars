# Season treasury

The show runs every day at the same time, and nobody signs for it. Sponsors put NEAR into the treasury; at each slot
of the schedule the treasury makes a fresh safe on chain and opens a sealed round on it on the
[bounty contract](../bounty), with the bounty paid from the treasury. The masks race, the winner drains the safe with
its own key, the judge confirms, the bounty contract pays. A round nobody won comes back to the treasury whole: its
bounty, and the NEAR in its safe.

Before the treasury, every race took the owner five to nine signatures: a new safe, its keys, the bounty, the round.
Now one call opens it, and the key that makes that call can do nothing else.

## A round, step by step

```text
Scheduler (function-call key)   Season treasury                  Safe s<nnnn>.<season>       Bounty contract
  │ open_next() ────────────────►│ due? within limits? funded?   │                          │
  │                              │── governance() ──────────────────────────────────────────►│
  │                              │◄─ judge, safe codes, pending ─────────────────────────────│
  │                              │ the season's judge? its code    │                          │
  │                              │ known there? no code pending?   │                          │
  │                              │── create, fund, global code ──►│ new(owner = itself,      │
  │                              │   by hash, new(...)             │   masks = the season's,  │
  │                              │                                 │   arbiter = the bounty   │
  │                              │                                 │   contract, team = the   │
  │                              │                                 │   treasury); no key      │
  │                              │── open_safe(id, safe, masks, … ) + the bounty ───────────►│ sealed round
  │                              │                                 │◄── arm(id, …, team) ─────│
  │                              │◄──────────────────────────────────────────────────────────│
  │                              │── get_round() ─────────────────►│ armed for id by the      │
  │                              │◄── the round it is armed for ───│ bounty contract          │
  │◄── the round: id, safe, target, times                          │                          │
```

All of it happens in the one transaction the scheduler signs. Then `Live race` runs on the round (the `Season`
workflow does both, every day at 18:00 UTC): the masks race the target in the sandbox, the winner seals its plan,
plays it on the safe after the commit window, reveals it and claims. The rest is the bounty contract's
([RULES.md](../../RULES.md)).

- The round's id is `<name>-<nnnn>-<6 hex>`, e.g. `s1-0007-3fa9c2`. The hex is new for every attempt, so nobody can take
  the id on the bounty contract first and block the round.
- Before it makes the safe, the treasury reads the bounty contract's state: if the round could not open there (another
  judge than the season agreed to, a safe code it does not know, new code or a new admin pending), nothing is made and
  the slot stays open for a later try.
- A safe that was made for a round that then did not open stays as it is, untouched, and the next try opens the round
  on it (`spare`), if it still fits the program.
- If the safe could not be made, the batch fails whole and its NEAR stays in the treasury. The safe's number is taken
  before the batch goes out, so no later attempt ever names the same account, and a spare safe is never replaced: a
  second one is logged as left behind (`orphan`).
- **The round counts only once the safe is armed for it.** `open_safe` asks the safe to arm in the same block, and the
  treasury then asks the safe which round it is armed for. NEAR does not promise that the safe hears `arm` first, so
  a safe armed for nothing yet sends the treasury to the bounty contract: a round still open there is recorded (if the
  safe refuses after all, `collect` sees it refunded); a round it already refunded is not. A safe the bounty contract
  did not arm takes no round, the slot stays free, and the safe stays the spare. One that cannot even answer (a safe
  of the library without the lock, such as `pause-bypass`) has its code taken off the list, so no more safes are
  made from it.
- The spare remembers the bounty contract it names as its arbiter: after a change of bounty contract it is not reused,
  and a round is checked and recorded on the contract it opened on, even if the season's changed meanwhile.

## The scheduler's key

The scheduler is one account (`scheduler.tinygif8324.testnet`), with one function-call key: receiver the treasury,
methods `open_next` and `collect`. Its secret half is the secret `SCHEDULER_KEY` of the GitHub environment `season`,
which only `main` deploys to: a workflow run from any other branch never sees it.

| It can | It cannot |
| --- | --- |
| Say "now": open the round that is due | Pick the target, the masks, the bounty, the safe's NEAR, the windows or the judge: the program decides |
| Open a round late, if the cron ran late: the latest slot that has no round yet | Open a second round for the same slot, a round before its slot, or more than `max_per_day` in any 24 hours |
| Bring finished rounds home (`collect`): the bounty contract pays a confirmed winner nobody paid yet and sends an unwon bounty back to the treasury, and the safe of a round nobody won sends its NEAR back too | Send any NEAR anywhere else: `collect` only asks the bounty contract to `settle` and `refund`, which pay the winner or the treasury, and the safe to `reclaim`, which pays the treasury |
| Burn the scheduler account's own NEAR on gas | Attach NEAR, call any other method, or reach any other contract: NEAR refuses it for a function-call key |
| | Move the treasury, change the program, the limits or the scheduler |

**If the key is stolen**, the thief cannot take a yoctoNEAR, but it can spoil a day of the show: it can open the round
that is due at a moment when no race runs. The `Season` workflow races a round it finds open for its slot while the
commit window lasts, so a thief who opens the round just before the cron loses nothing for anyone. But a round opened
when no run follows (after the run of the day went red, or for a slot the cron missed) gets no race: nobody breaks its
safe, and the round's bounty and the NEAR of its safe come back to the treasury through `collect`, once its claims
are over. The thief takes nothing and keeps nothing out for good; it costs a day of the show, at most `max_per_day`
rounds, and the scheduler account's own NEAR on gas. On a leak: `scheduler.ps1 -KeyOnly` for a new key, delete the old
one, and replace `SCHEDULER_KEY` in the environment `season`.

## The program, the schedule and the limits

| What | Who sets it | Waits before it applies |
| --- | --- | --- |
| **Program**, what decides where the NEAR goes: the masks, the targets (their code, `init`, the safe's NEAR, the least drain), the bounty, the judge | the admin | 72 hours |
| **Program**, only when rounds run: the schedule, the round's hours, the commit and reveal windows | the admin | 1 hour |
| **A safe code** rounds may be made from (`allow_safe`): the code decides who can take a safe's NEAR | the admin | 72 hours |
| **Scheduler**: the one account that may call `open_next` | the admin | 1 hour |
| Taking a safe code off the list (`drop_safe_code`) | the admin, or the treasury itself for a code whose safe takes no round | none: it only stops new safes from it |
| **Limits**: the most one round's bounty may lock (`max_prize`), the most one safe may hold (`max_safe_fund`), rounds in any 24 hours (`max_per_day`) | the admin | 72 hours to raise any of them, 1 hour to lower |
| **Bounty contract** the rounds open on, **admin**, **code** (`upgrade` with `migrate` in the same batch) | the admin | 72 hours |

`propose(change)` puts one change in `pending()` (with `long: true` when it waits 72 hours), `cancel()` withdraws it,
`apply()` (or `upgrade()` with the wasm itself as the input) applies it once the wait is over; anyone may apply. A
change nobody applied within 24 hours of being ready lapses. A program must fit the limits and the allowed safe codes
when it is proposed and again when it applies.

**A sponsor who does not want a change leaves before it applies.** While a change that waits 72 hours is pending and
not yet ready, `exit()` pays each sponsor its share of what the treasury can spend at that moment, and takes exactly
the shares that pay for it.

- A share is a part of everything the treasury has: what it can spend, what rounds not brought home yet still hold
  (`outstanding`: each one's bounty and its safe's NEAR) and the spare safe's NEAR. `fund()` mints shares at that
  price, so a sponsor who comes just before a round comes home buys what it brings at its price and takes nobody's
  part. A bounty or a safe a mask won does not come back, so whoever funds while rounds are out pays for them as if
  they would: the earlier sponsors never lose by a newcomer. The bounty stops counting as out once the bounty contract
  says how the round ended; the safe's NEAR once a mask won it, or once the safe has sent it home.
- An exit takes the sponsor's share of what is here, once: all its shares go, and its part of the bounties still out
  stays with the sponsors who remain. So an exit never pays out anything that is not in the treasury, whatever those
  rounds bring back, and calling it again takes nothing. NEAR in a safe is gone with its round.
- `fund` and `exit` wait while a round is on its way or a safe code is being published: mid-way, the treasury's
  balance is not what it has. A treasury that rounds emptied, with nothing out, starts its shares afresh. When the shares would grow past 2^120, every share is halved as often as needed, which keeps every part.
- NEAR that belongs to no sponsor (what the treasury was deployed with, or what came back after everyone left) stays
  the treasury's own: it holds shares nobody holds, and a newcomer buys in beside it at its price. A deposit that
  would buy no share at all is refused.

- **The schedule** is `first_minute` and `every_minutes`: a round is due at every `every_minutes` from `first_minute`
  minutes after midnight UTC. `1080` and `1440` is every day at 18:00 UTC.
- **A target** is a locked safe ([contracts/challenges/live-safe](../challenges/live-safe)), named by its code hash:
  `challenge` (its library id, which the race runs in the sandbox), `code_hash`, `safe_fund` (the NEAR the safe gets),
  `min_loot` (what a drain must take) and `init`, the rest of its `new` arguments as a JSON object of numbers, flags
  and amounts. Every account in `new` comes from the treasury itself: the safe as its own `owner`, the season's
  `masks`, the bounty contract as the `arbiter` that arms it and the treasury as its `team`, so the safe takes only
  the season's own round. A program whose `init` names any account is refused: every key is a plain name
  (`^[a-z_][a-z0-9_]{0,31}$`, so neither a named account nor an implicit one), every value a number, a flag or an
  amount. Targets take turns; one whose code is no
  longer allowed is skipped. The other safes of the library have no lock (`arm`, `queue`) yet and take no live round:
  the testnet program runs `live-safe` only.
- **The judge** the season agrees to is part of the program: the bounty contract must judge with exactly that one.
- **The windows**: the commit window is 30 minutes at least, time for the masks to race the target in the sandbox
  and seal; the commit and reveal windows fit in the round's hours, and the reveal window gives every mask its slot on
  the safe and one more, 3 minutes each, as the bounty contract asks. A program that does not is refused.
- **The prize** must cover what the bounty contract keeps of it and still leave the winner 0.1 NEAR: the round's own
  storage (at most 1500 bytes and 100 a mask) and its reserve of 240 bytes and 4000 a mask. `min_prize(masks)` shows
  it: 0.2404 NEAR for three masks. The sandbox test checks it against what the bounty contract really keeps.

## Safes from global code

A safe's code goes on NEAR once, as a global contract by its hash, and every safe made from it only points at it: a
new safe costs its account and the NEAR it holds, not another copy of its code. A global contract by hash never
changes. `publish_code()` publishes a code the season allows; the input is the wasm itself, the caller attaches NEAR's
price (0.0001 NEAR a byte; CI prints it for every safe) and gets back what is left. The treasury pays nothing for it,
and the deposit is never the treasury's: until the change has gone back it does not count in what the treasury can
spend, and nobody funds or exits.

NEAR shows such an account's own code hash as `1111…` (no code of its own) and the global one in
`global_contract_hash`. The judge reads both: a safe from global code by hash counts as that code; one from a global
contract named by an account (which that account can redeploy) never counts.

## Where the money goes

- **`fund()`**: anyone adds NEAR and gets shares of the treasury for it. It leaves as a round, into a safe or a
  bounty, or with `exit()` while a long change is pending.
- **Into the safe**: the target's `safe_fund`. The winner drains it. A safe nobody broke has no key and owns itself,
  so no one takes its NEAR out by hand; it sends it back to its team, the treasury, with `reclaim`, and only once the
  bounty contract that armed it has refunded the round, after the deadline and the claim grace. The safe asks the
  bounty contract itself. Before that, after a mask won, or for anyone but its team, it sends nothing.
- **Into the bounty**: the program's `prize`. The bounty contract keeps the round's storage out of it and pays the rest
  to the winner; what the storage did not use, and a whole bounty nobody won, come back to the treasury.
- **`collect()`** brings finished rounds home: an hour after a round's claims are over (13 hours after its deadline) it
  asks the bounty contract the round opened on (kept in the round, whatever the season's bounty contract is by then)
  to `settle` the round, which pays a confirmed winner nobody paid yet, then to `refund` it, which sends an unwon bounty
  back here, and then reads the round there. Whichever of the two does not apply fails on its own. Only a round that
  ended (`paid`, `drained` or `refunded`) is done and gets its `outcome`; the cursor moves past it, and any other is
  asked again next time, and a round comes off what is out once, however many collects come back. A round nobody won
  (`refunded`) then asks its safe to `reclaim`: the safe's NEAR comes home, and the round's `reclaimed` says whether
  it did. Up to two rounds a call, oldest first, and only as many as the gas carries home whole (300 TGas carry two),
  looking at up to 16 rounds from the cursor, so a round with a later deadline holds up none behind it;
  `collect(from_index)` starts further on, past a round that never ends. Anyone may call it, and the scheduler does
  before it opens the next round.
- The treasury keeps 0.1 NEAR beyond its own storage, and opens a round only when it holds enough for all of it.

## Views

| Method | Gives |
| --- | --- |
| `next()` | the next round: when (`at_ns`, due now if in the past), its number, target, code hash, the safe's NEAR, the bounty, the minimum drain, masks, hours, windows, whether the treasury can pay for it now |
| `latest(limit)` | the latest rounds, newest first: id, safe, target, code, amounts, masks, slot, opening, commit window, deadline, how each ended (`outcome`) and whether its safe's NEAR came home (`reclaimed`) |
| `rounds(from_index, limit)` | every round in order, a page at a time |
| `season()` | name, admin, scheduler, bounty contract, limits, safe codes, program, pending change, rounds and safes so far, what sponsors put in, what rounds took, what the treasury can spend now, the spare safe, the round on its way |
| `sponsor(account_id)` | what one sponsor put in |
| `share_of(account_id)` | what `exit` would pay one sponsor now: its part of what the treasury can spend |
| `min_prize(masks)` | the least a round's bounty may lock for that many masks |
| `collectable(from_index)` | finished rounds `collect` would ask about now, from the cursor or further on |
| `pending()` | the change waiting to apply |

Events: `EVENT_JSON:{"standard":"maskwars_season","version":"1.0.0","event":…}` for `fund`, `exit`, `safe`, `open`,
`skip` (with the reason), `orphan` (a safe left behind), `collect`, `collected` (with the outcome), `reclaimed`
(whether the safe's NEAR came home), `publish`, `drop_safe_code`, and every governance step.

## Tests

```bash
cargo test                                                  # the treasury's own rules, 56 unit tests
cd ../challenges && cargo test -p race-runner --test season # three rounds on a real local node
```

The sandbox test runs everything on chain as it is: the treasury and the bounty contract are born without keys, a
sponsor funds the treasury and publishes the code of `live-safe`, and then nobody holds a full key that matters. The
scheduler has only its key for `open_next` and `collect`; each mask has only function-call keys, one on the bounty
contract and one on each safe. Round 1 opens on `s0001`: the safe names the bounty contract as its arbiter and the
treasury as its team, and is armed for the round before the treasury records it; what the bounty contract keeps of the
prize is within `min_prize`. NOVA seals, plays `set_owner` and `sweep` after the commit window, reveals and claims;
the real judge confirms from the chain and the bounty contract pays. Round 2 waits for the next slot and opens on a
fresh `s0002`; ONYX drains it the same way and is paid. Round 3 opens on `s0003` and nobody plays it. Beside the
season a crew opens a round of its own on its own safe: while it is open the crew's `reclaim` takes nothing, nor does
anyone else's, and after NOVA wins it the crew takes nothing back either. Past round 3's deadline and the claim grace,
`collect` brings all three home: the two won rounds leave their safes as the winners left them, and round 3's bounty
and the NEAR of `s0003` come back to the treasury, with nothing left counted as out. The test also checks that a
second `open_next` in the same slot is refused, that the scheduler's key reaches nothing else, and that the treasury,
the bounty contract and every safe hold no key at the end.

Build: `RUSTFLAGS='--cfg near -C link-arg=-s' cargo build --release --target wasm32-unknown-unknown`. CI shrinks it with
`wasm-opt` and uploads it with `live-safe` as `maskwars-season-wasm`, with the safe's code hash and the price of
publishing it.

## On testnet

The owner's scripts are in [scripts/testnet](../../scripts/testnet): `season-deploy.ps1`, `season-publish.ps1`,
`season-fund.ps1`, `scheduler.ps1`, `season-keys.ps1`, `season-change.ps1`; the program and limits in
`season-args.json`. The testnet program runs `live-safe` only. A safe of the library joins once it has the same lock
(`arm`, `queue`, the slots of the seals) and its live round has been played; until then the treasury drops a code
whose safe cannot say which round it is armed for after its first try.
