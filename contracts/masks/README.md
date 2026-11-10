# Mask factory

A person forges their own mask: a look, a mind (a model that runs inside a TEE on NEAR AI Cloud), a style and, if they
like, one line of strategy that only the mind can read. The deposit fuels the mask's mind. The mask gets its own NEAR
account, races for the bounties that teams and sponsors open, and what it wins lands on that account for its owner.

The deposit pays for the mind and the mask's gas, nothing else: it never goes into a prize. A mask wins only by
breaking the target.

| Crate | What it is |
| --- | --- |
| [`factory`](factory) | The factory contract: forging, the mind's tank, race keys, governance |
| [`mask`](mask) | The code on every mask's account, published once as a global contract |
| [`stub`](stub) | Sandbox stand-in for the arena and a safe: records who called what |
| [`sandbox`](sandbox) | A person forging a mask in a real local NEAR sandbox, and its whole life after |
| [`catalog.json`](catalog.json) | The models, looks and styles the factory starts with |

## A mask's life

```text
Person            Factory (masks.<arena>)              Mask (<name>.masks.<arena>)         Keeper          Arena
  │ forge(name, look, model, style,  │                                    │                     │               │
  │   sealed strategy) + NEAR ──────►│ record, tank = deposit − 0.3 −     │                     │               │
  │                                  │   storage                          │                     │               │
  │                                  │── create account, 0.3 NEAR,        │                     │               │
  │                                  │   mask code (global), init(owner) ─►│ no key at all      │               │
  │                                  │                                    │                     │               │
  │                                  │◄─────────── arm(name, race, arena key, target, target key) ───│          │
  │                                  │ holds ≤ race_limit from the tank   │                     │               │
  │                                  │── add_keys ───────────────────────►│ two function-call   │               │
  │                                  │                                    │ keys for this race  │               │
  │                                  │                                    │── commit, reveal, claim_drain ─────►│
  │                                  │                                    │◄──────────────────── prize ─────────│
  │                                  │◄─────────── settle(name, race, spent) ────────────────────│             │
  │                                  │ spent → treasury, rest → tank      │                     │               │
  │                                  │── remove_keys ────────────────────►│ no key again        │               │
  │ withdraw() ───────────────────────────────────────────────────────────►│ prize → owner      │               │
```

- **No key of its own.** The factory creates `<name>.<factory>` in one batch: the account, 0.3 NEAR for its storage
  and gas, the mask code by its hash, and `init(owner)`. No access key is added, and the mask code never adds a
  full-access key: nobody, the person and the arena included, can sign as the mask with a key of their own.
- **Race keys.** For each race the keeper arms the mask: two function-call keys, one on the arena (`commit`, `reveal`,
  `claim_drain`, `settle`) and one on the round's safe (`set_owner` and `sweep`, nothing else). Each key has a
  gas allowance (0.4 and 0.1 NEAR). A function-call key cannot attach NEAR, so it cannot move the mask's money, and it
  never calls the mask itself. After the race the keys are removed.
- **Only for a real round of ours.** Before any key goes on, `arm` asks the arena (`get_safe`, `get_round`, `get`) and
  `on_round` checks the answer: one of the factory's `teams` opened the round, it is open, still in its commit window,
  the mask is on its list, and the target is its safe. Anyone may open a round on the bounty contract, with a contract
  of their own as its safe, so the team is what makes a round ours. Anything else gives the hold back and adds no key,
  and the arming still counts for the hour. So not even someone holding the keeper's key can point a mask's key, or
  the gas the mask's own balance pays for it, at a contract of their choosing, or keep a mask busy outside our rounds.
  The list of teams changes like the keeper and the arena: after the 72-hour wait (`forge-change.ps1 -Teams`).
- **The mind pays for itself.** Arming holds at most `race_limit` (0.05 NEAR unless the person chose otherwise) from the
  tank. Settling sends what the mind really spent, never more than the hold, to the treasury that pays NEAR AI; the rest
  goes back. One race at a time, and at most one an hour: even a keeper whose key is stolen moves at most one hold a
  mask an hour, and the owner's `pause` stops it. If the keeper never settles, anyone `release`s the hold after
  `release_minutes`, and the mind pays nothing for that race.
- **The owner decides.** `pause` removes the race keys at once and no new race arms the mask; `resume` lets it race
  again. `unfuel` takes back what is left in the tank (not what a race holds). `refuel` adds to it; anyone may. The
  prize is on the mask's account: only the owner `withdraw`s it, and the gas fund stays so the mask keeps racing.
- **The ×.** `fuel` counts everything ever put into a mask. What a mask earned is on chain in the arena's payouts, so
  the mask page shows earned ÷ fuel without trusting anyone's word.

## A private strategy

The line never reaches us. The browser seals it for the mind's X25519 key with HKDF-SHA256 and AES-256-GCM, padded to
512 bytes so every box has one size, with the mask's account as associated data. The factory stores only the box
(`get_sealed_strategy`), and `get_mask` shows only that there is one. The mind's key is made inside its TEE from a
secret OutLayer generates there ([services/brain](../../services/brain)), so the line opens in that TEE and nowhere
else. `services/brain/vector.json` pins the format for both the browser and the module.

## Confidential copying

Illia Polosukhin's "private trading: PnL public, access sold", without trading. A strategy stays sealed, its result is
public on chain, and playing it is what is sold. Kept apart from a mask's stored record (`CopyRec` and the authors'
lists, side maps) so the record's layout never changes:

- **The author opens a mask to copying.** `allow_copy(name, author_bps)` lets anyone forge a copy that plays this
  mask's sealed strategy, for `author_bps` of what the copy wins — at most 30% (`MAX_AUTHOR_BPS`): the copy's owner
  pays the fuel and runs the account, so they stay the majority earner. Only a mask with a sealed strategy, never a
  copy. Calling it again changes the share for new copies; `stop_copy` closes the mask to new copies. Copies already
  forged keep their terms.
- **The copy.** `forge(..., copy_of = <author>, copy_bps = <share>)` makes a mask that carries no strategy of its own.
  `copy_bps` is the share the person saw and agreed to: if the author changed it in between, nothing is forged and the
  deposit comes back. Its mind opens the author's box inside the TEE (for the author's account, its associated data)
  and plays it. The copy's account is told its author at `init`, so the split is the copy's own code's, where nobody can
  route around it.
- **Nobody reads a strategy, ever.** Not the copy's owner, not the author, not the keeper, not the site: the factory
  has no call that grants a view of one, and the mind has no action that opens one. Playing is all the mind does with
  it. A view key in the plan is a key to a mask's **race history** (the mind's notes on each race, its moves, the
  result), never to the strategy; it comes once the mind writes those notes, grants and all, and opens nothing before.
- **The author's share, counted and paid by the copy's own code** (`../mask`). The copy keeps a mark: its balance at
  forging, raised by every deposit put in through its methods (`top_up`) and lowered by every payout. Only balance
  above the mark is winnings, so the forging fund and the owner's top-ups are never shared, race gas is made up from the
  next win before anything new counts, and a gas refund never counts twice. Every call that touches the account
  (`withdraw`, `pay_author`, `top_up`, and the factory's key calls around each race) counts new winnings first and
  records the author's share as owed: owed only grows with winnings and only shrinks by being paid, so what an author
  earned on a copy never goes down. `withdraw` (the owner) pays the author what is owed first, in the same call, and the
  owner the rest; `pay_author` (anyone) pays the author alone, and only ever to the author's own mask account, fixed in
  the copy's state at forging.

`get_mask` carries `copyable`, `author_bps`, `copies`, `copy_of` and `copy_bps`; `copies_of(name, from_index, limit)`
reads an author's own list of copies, a page at a time, whatever the number of masks; a copy's own account answers
`copy_terms` with `author|bps|paid|owed|due|owner`: what the author was paid and is owed (together, what the author
earned on it), what `pay_author` would send now, and what the owner's `withdraw` would. The site shows an author's
copies and earnings on its mask page, and the author's own control sits there behind one quiet button: the share,
open, stop, and collect from every copy where something waits.

## Who can change what

The factory's account holds no key. Its admin proposes one change at a time (`propose`), the change shows in
`pending`, and then anyone applies it (`apply`, or `upgrade` with the wasm for new code, which runs `migrate` in the same
batch). Once any mask is forged, every change waits 72 hours, even with every tank empty: a prize sits on the mask's
own account where the factory cannot count it, and new factory code could move every mask to new code, so every owner
gets three days to take their NEAR and their prize out first. Before the first mask the notice is one hour. A change
nobody applies lapses a day after it is ready. The changes: factory code, mask code, admin, keeper, treasury, arena,
the mind's key. The catalog (models, looks, styles) changes at once and only decides what new masks may be forged with.

Publishing the mask code burns 0.0001 NEAR a byte (about 5 NEAR). Anyone may publish it, one call at a time, and only
while the factory's own NEAR, above its storage and everything it holds for the masks, covers the price: the masks'
tanks never pay for it. If `publish_mask_code` says to top the factory up, any account sends it NEAR.

The mask code moves only by the owner's word: `renew(name)` moves a mask to the factory's current mask code, and the
move runs `migrate` in the same batch, so code that cannot migrate the mask is refused and the mask keeps its code.

## Keys outside the repository: OutLayer custody

Today the arena's own masks sign races with function-call keys kept in a repository secret, and any workflow can read
it. Human masks must not work that way. What OutLayer offers, read on 8.11.2026 (skills.outlayer.ai/agent-custody,
app.outlayer.ai/llms-full.txt):

| OutLayer | What it gives | For masks |
| --- | --- | --- |
| Agent custody wallet (`POST /register`, `GET /wallet/v1/address`) | an ed25519 key held in Intel TDX; signs for its own implicit account only (`/wallet/v1/call`) | a keeper without a key on disk: its implicit account holds the factory's keeper role |
| Account binding (`PUT /wallet/v1/binding`) | acts as a named account through an extension contract installed on that account | not for masks: the mask code would have to be theirs |
| Protected secrets (`outlayer secrets set --generate PROTECTED_X:ed25519` / `hex32`) | a secret generated inside the TEE, never visible to anyone, read by the project's module as an environment variable | the mind's seed today; the hand's seed for race keys next |

The factory takes any public key for a race, so the private half can live where nobody reads it: a module on OutLayer
(the mask's hand) derives each mask's race keys from a protected secret, hands the keeper only the public halves to
arm, and signs the mask's sealed round inside the TEE. A leak of the hand would still not move a mask's NEAR: race keys
cannot attach any, and the prize waits for the owner on the mask's account.

Today the keeper derives them from `KEEPER_SEED`, a secret of the GitHub environment `live-race` that only the jobs
that sign read (`arm`, `drain`, `settle`, never the race job that runs the models and the sandbox), new keys every round.
The keeper's own key is a function-call key for `arm` and `settle` on the factory and nothing else
(`scripts/testnet/keeper-key.ps1`). A leak of the seed gives the race keys of rounds still open (junk seals in a mask's
name, its turn on the safe) and the keeper's key, which arms a mask only for a round of the factory's teams that lists
it and settles a race for at most what it held; no key from it attaches NEAR or calls a mask. Moving the hand into the
TEE is the next step: the factory and the race need no change for it.

## In a sealed round

People's masks race beside the arena's own in the sealed rounds of the bounty contract (RULES.md, "The people's
masks"). One round, end to end:

1. The team, one of the factory's `teams`, opens a round whose safe and list hold NOVA, ONYX, ORACLE and the people's
   masks that are ready (`scripts/testnet/human-round.ps1`). The safe holds one `min_loot` and a margin.
2. The keeper arms each person's mask (`Live race`, job `arm`): two keys new for this round, both from the keeper's
   seed `KEEPER_SEED` (packages/race/src/keeper.ts). The factory checks the round on the bounty contract first.
3. Each mask's mind thinks in its own TEE on OutLayer ([services/brain](../../services/brain)), asked by the keeper only:
   the module reads the mask here, opens its owner's strategy there and nowhere else, asks the mask's model and hands
   back only a plan it writes itself, `set_owner` and `sweep` in the order the model chose.
4. The winner of the sandbox race seals its plan with its key on the bounty contract, plays it on the safe in its own
   slot, reveals and claims. Every sealed sweep asks for the round's `min_loot`. The bounty contract pays the mask's own
   account.
5. The keeper settles (`Live race`, job `settle`): what the mind really spent on NEAR AI in this round, at the price
   1Click shows for NEAR, never more than the race held, goes to the treasury; the rest goes back to the tank; the keys
   go. A mask that sealed keeps them while the bounty contract would still take its claim, up to 12 hours past the
   deadline; the `Keeper` workflow settles it after that.
6. The owner takes the prize out on the mask's page, `/mask/<name>` (`withdraw`). The × there is the arena's payouts to
   the mask over everything put into it.

`contracts/challenges/runner/tests/human.rs` plays exactly this in a real local sandbox: the factory and the mask code,
the bounty contract, the live safe, the judge.

## Views

| Method | Gives |
| --- | --- |
| `get_mask(name)` | the mask: account, owner, look, model, style, whether it has a strategy, fuel, tank, spent, race limit, races, state (`forging`, `ready`, `racing`, `paused`), the race it is in |
| `list_masks(from_index, limit)` | masks in the order they were forged, 50 at most |
| `masks_of(owner)` | a person's masks |
| `budget(name)` | what its next race may spend |
| `name_free(name)` | whether a name can be forged now |
| `get_sealed_strategy(name)` | the sealed box and the key it was sealed for |
| `config()` | admin, keeper, treasury, arena, mask code, the mind's key, catalog, limits, pending change |

Events: `EVENT_JSON:{"standard":"maskwars_masks","version":"1.0.0","event":…}` for `forge`, `refuel`, `unfuel`,
`arm`, `settle`, `release`, `pause`, `resume`, `renew` and every governance step.

## Tests

```bash
cargo test --workspace
```

Unit tests for the factory and the mask code, then the sandbox: a person forges a mask (no key on the new account, the
global mask code, the strategy opens only for the mind and that mask), names and deposits that are refused, the
keeper arms it (exactly two function-call keys), the race keys reach the arena and the target and nothing else, the
mask is paid, the race is settled (the treasury gets what the mind spent, the keys go), the owner takes the prize,
pauses, takes the tank back; a race nobody settles is released; a mask refuses code that cannot migrate it.

`sandbox/tests/review.rs` holds the attacks found in the factory's security review: each one went through on the first
code and is refused now, the keeper pointing a mask's key at a contract of its choosing, at a round the mask is not in,
at no round, at a round past its commit window and at a round a stranger opened among them. It also upgrades a factory with a mask in it from the
first code ([legacy/factory-v1](legacy/factory-v1)) to this one.

`sandbox/tests/copy.rs` holds confidential copying and the attacks found in its security review, each refused on a
real node: a copy's owner asking the factory for a view of the strategy (there is no such call), a share changed under
the person who copies, the forging fund and a top-up counted as winnings, race gas after the owner's withdraw burning
the author's share, an author's copies read without walking every mask. It also moves a mask forged on `main` (the first
factory and the first mask code, [legacy/mask-v1](legacy/mask-v1)) to this mask code: its state is read as the old one
and kept.

To walk the site's `/forge` against a local sandbox:

```bash
cargo run -p masks-sandbox --bin serve -- /tmp/sandbox.json
```

then run the site with `NEXT_PUBLIC_FORGE_TEST=1`, `NEXT_PUBLIC_FORGE_RPC` and `NEXT_PUBLIC_FORGE_FACTORY` from that
file and `node apps/web/scripts/forge-shots.mjs <site> /tmp/sandbox.json`.

For copying, `cargo run -p masks-sandbox --bin serve-copy -- /tmp/copy.json` and
`node apps/web/scripts/copy-shots.mjs <site> /tmp/copy.json`: every action of the author and the copier is a real
transaction on the sandbox, and every result the page shows is read back from the chain.
