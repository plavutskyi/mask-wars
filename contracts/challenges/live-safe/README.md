# Live safe

The one target that also lives on chain: the house's vault of the daily round (`vault.house.maskwars.near`) and the
safes of the season. What every kind shares, the round's lock, the seals, the turns, `reclaim` and `retire`, is in
[the challenges README](../README.md#the-live-round-interface) and in the head of [`src/lib.rs`](src/lib.rs).

**The masks never read this file.** They get `src/lib.rs`, their own account and the public `kit` of the challenge
(`{"variant": "<kind>"}` for a kind other than the default: the same word the vault's own `variant` view answers on
chain). This file holds what the judge of the code needs and a mask has to find by itself.

## Kinds

A vault is of one kind for good, named at `new` (`variant`; `owner` when left out) and shown by the `variant` view.
Each kind opens one desk, the only calls that move the vault's NEAR, and refuses the calls of the other two
(`this safe is of another kind: it has no such desk`). Every desk sits behind the same door: only a mask of the round
that sealed a plan, after the commit window, in its own turn. Every call of a desk is one numbered move, and a turn
starts with the desk as the round left it.

| Kind | Since | What it is | The desk | The plain way out, which pays nothing | Planted hole | The plan |
| --- | --- | --- | --- | --- | --- | --- |
| `owner` | 1.0.0 | A vault with an owner who may hand it on and sweep it | `set_owner`, `sweep` | `sweep`: owner only | `set_owner` never checks that the caller is the owner | `set_owner(mask)`, `sweep(mask, amount)`: 2 calls |
| `limit` | 1.7.0 | A vault with an exit desk: an exit within `WITHDRAW_LIMIT` (0.005 NEAR) is cleared at once, a bigger one waits for the owner's word | `request_exit`, `check_exit`, `withdraw` | `request_exit` above the limit, then `withdraw`: waits for the owner; `check_exit`: owner only | `request_exit` sets the cleared mark for a small exit and never takes it off when a bigger exit replaces the one on file | `request_exit(≤ 0.005 NEAR)`, `request_exit(amount)`, `withdraw()`: 3 calls |
| `pause` | 1.7.0 | A paused vault: while it is paused no NEAR leaves it, and only its owner lifts the pause | `claim`, `book`, `cash_out`, `pause`, `unpause` | `claim`: the vault is paused; `unpause`: owner only | `claim` checks the pause, `cash_out` does not: a payout booked while the vault is paused is paid while it is paused | `book(amount)`, `cash_out()`: 2 calls |

The ideas are the library's: `limit` is the wrong-figure check of [`over-withdraw`](../over-withdraw) turned into a
mark that outlives what it was set for, `pause` is [`pause-bypass`](../pause-bypass) with the exit queue of
[`blind-callback`](../blind-callback) in place of `claim_for`. Both are rebuilt so that a mask's function-call key
plays them: no call attaches NEAR, every argument is an amount, and every call's name is one the masks' keys on a
vault already reach (`safe_methods` of `scripts/*/season-args.json`, the list `season-keys.ps1` gives a key).

What holds for every kind, and why:

- **Only the masks the vault lets in.** Every call of every desk starts with the round's door (`turn_for_caller`), before
  the desk is even looked at. `src/tests/variants.rs` sends every call of every desk as a stranger, the team, the bounty
  contract, the vault itself, a mask before the window and a mask that sealed nothing: all refused with the door's own
  words.
- **The loot goes to the caller.** `sweep` takes a `to`; the new desks pay nobody but the account that calls
  (`pay`), in the receipt of the call itself: a transfer from the vault to the mask, which is what the judge adds up.
- **One move a call.** A desk's call counts one move and logs one `move` event, and a turn's first call the `turn`
  event before it: the judge reads a plan as the mask's own turn, whole, from them.
- **The amounts of a sandbox plan play on chain as they are.** The sandbox copy holds 5 NEAR, the vault on chain a
  fraction of it. `withdraw` and `cash_out` pay as much of the amount on file as the vault can pay out
  (`available`), so a plan found against the copy drains the real vault without being rewritten. A payout is never a
  turn's first move (a turn starts with nothing on file), so it adds nothing to what the vault stores and may pay to
  the last yoctoNEAR.
- **An honest caller stays below any round's `min_loot`.** At the `limit` desk twelve calls, all a plan has room for,
  take 0.03 NEAR; a round asks for 0.1 NEAR at least. At the `pause` desk the plain way out takes nothing.
- **The vault still retires.** The kind and the desk are 35 bytes written in full by `new`, after everything the round
  reads; no call of a desk grows them. `retire`, `on_retire`, `reclaim` and `on_bounty` do not look at the kind.
- **The `owner` kind is the vault as it was.** `runner/tests/same_safe.rs` plays the same script on the code the vault
  runs on mainnet and on this build with no kind named: the same answers, panics, events and transfers.

## The challenge files

| File | The world the sandbox builds |
| --- | --- |
| `challenge.json` | the `owner` kind, with no `variant` in `new`: what the daily round races |
| `challenge.limit.json` | the same accounts and NEAR, `"variant": "limit"` |
| `challenge.pause.json` | the same accounts and NEAR, `"variant": "pause"` |

```bash
cd contracts/challenges
./target/release/race-runner run live-safe --variant pause < runner/tests/plans/live-safe.pause.breach.json
./target/release/race-runner round --variant limit      # a sealed round with scripted masks on a vault of that kind
pnpm --filter @maskwars/race race live-safe --variant limit   # the arena's models on the copy, needs NEAR_AI_API_KEY
```

A race with a round's id (`BOUNTY`) reads the kind from the round's vault on chain, so the masks race the copy of the
vault they will play (`packages/race/src/variant.ts`).

## Tests

- `src/lib.rs`, `src/tests/after_round.rs`: the round's lock, the seals, the turns, `reclaim`, `retire` (owner kind).
- `src/tests/variants.rs`: the kinds. Each hole pays the mask in its own turn, the plain way out does not, another
  kind's calls are refused, nobody but a sealed mask reaches a desk, a turn starts with the desk as the round left it,
  the state's size never changes, a drained vault retires.
- `../runner/tests/challenges.rs`: each kind in a real sandbox, the right plan and the wrong one, a plan for one kind
  against a vault of another, a stranger.
- `../runner/tests/round.rs`: the sealed round with scripted masks on each kind, the real bounty contract and judge.
- `../runner/tests/variants.rs`: a round by hand on each new kind with the sums of mainnet and function-call keys
  only, from the first seal to `retire`.
