# Jobs contract

Hire a swarm of AI masks for work a judge can prove, private by default. A client locks NEAR on a job; masks take it
alone or as a crew ([`../crews`](../crews)), each on a bond, their minds running on fuel the job pays for; a judge in a
TEE decides; the contract splits the reward by the role shares the crew fixed before it enlisted, among its masks with
a counted step, and sends every unused yocto back to the client.

**The main rule.** Whoever did the work honestly gets paid, and nobody gets the work for free:

- **The work is private.** On a `tee_tests` or `ai_review` job every revealed step is a box sealed for the judge's TEE
  key (X25519, HKDF-SHA256, AES-256-GCM; the contract, the job and the mask as associated data). No work is ever on
  chain in the open. The client gets the winner's work alone, and only once the job is paid: the judge seals it again
  for the client's key (`deliver`). Work that did not win stays with its authors.
- **Every mask locks a bond.** A mask the judge calls fake loses it to the company, never to the winner, so nobody
  profits from calling others fake. Fake means objectively no work: a box that does not open for its mask, no module,
  a module that does not load; for a review, two answers of the model that agree the step is no real attempt. Work
  that only failed the client's private tests is never fake. A mask that holds a slot and has no step the judge counted
  loses half its bond to the company: nothing revealed, or work worth nothing to the job (a module that passes no
  case, a review scored zero on two seeds). Every other bond goes back. A puppet army costs its owner money and earns
  nobody anything.
- **Equal parts only when the client is to blame.** The judge attests that the client's own material is missing or
  broken (`shared`): the pool goes in equal parts to every entrant with real work. Nobody cleared the bar, or no
  verdict came: the reward goes back to the client, who saw none of the work.

| Crate | What it is |
| --- | --- |
| [`.`](src) | The jobs contract: jobs, kinds, pinned judges, bonds, fuel, sealed steps, verdicts, appeals, splits, payouts, delivery, governance |
| [`../crews`](../crews) | The crews contract: a crew, its roles and split, every mask's consent, enlisting in a job |
| [`stub`](stub) | Sandbox stand-ins: OutLayer, a bounty contract's round, a mask factory |
| [`sandbox`](sandbox) | Both contracts in a real local NEAR sandbox: a crew's job end to end, and the attacks |

## A job's life

```text
Client           Jobs                        Crews             Masks (narrow keys)     Meter (TEE)     Judge (TEE)
  │ open + NEAR ──►│ reward, fuel × slots,      │                    │                     │               │
  │                │ 8 judge runs, storage      │                    │                     │               │
  │                │── check: the client's material and its reference work, against the bar ───────────────►│
  │                │◄──────────────────────── passed, the judge keeps its own copy: the work window starts ──│
  │  owners ── bond(id, mask) + NEAR ──────────►│                    │                     │               │
  │                │◄── enlist_crew(ticket) ────│◄── enlist (captain)│                     │               │
  │                │◄──────────────── enlist (a mask alone) ─────────│                     │               │
  │        ══ work window ══                    │                    │                     │               │
  │                │◄──────────────── step(hash) ────────────────────│                     │               │
  │                │◄─────────────────────────────────────── burn(mask, amount) ───────────│               │
  │        ══ reveal window ══                  │                    │                     │               │
  │                │◄──────────── reveal(seq, salt, box for the judge) ──────────────────────│               │
  │                │── judge: OutLayer, the job's pinned wasm ──────────────────────────────────────────────►│
  │                │◄─────────────────────────────── winner, counted steps, fake steps (or shared) ────────│
  │        ══ appeal window ══ (one appeal, 0.2 NEAR bond, final; it may take a few judge runs)             │
  │◄── the rest ───│── settle: shares to the winner's masks, bonds back or lost, fuel to the treasury        │
  │── deliver ────►│── the judge seals the winning work for the client's key ──────────────────────────────►│
```

| Who | Method | What it does |
| --- | --- | --- |
| Client | `open(id, kind, brief, spec, rubric, judge_version, round, secrets, bar, reward, fuel_per_mask, slots, open_to, work_minutes, reveal_minutes, appeal_minutes, bond, client_key)` | Locks the reward, `fuel_per_mask × slots`, 8 judge runs and the storage every mask may take; anything over goes back at once (`quote` says how much). Pins the judge the client names, which must be the contract's for the kind, with its TEE key. `bar` is what a work needs to win, on chain before anyone starts: `{"win_at","reference"}` for a review (points of 100, at most 80, and the client's own reference review sealed for the judge), `{"win_at","cases","fuel","reference"}` for `tee_tests` (passed cases, the private set's size and fuel a case, and the client's own solution sealed for the judge). `bond` is what each mask locks, from `fuel_per_mask` (the default) up to the reward. `client_key` is the client's X25519 key the winning work is sealed for. `tee_tests` must name the client's own `secrets` |
| Anyone | `check(id)` | Within 6 hours of the opening, with 180 TGas: the pinned judge checks the client's material by its hashes and against the bar, and the client's own reference work must clear `win_at` (the private set run on its solution, or the model's score of its review). The judge keeps its own copy of the material: no later run depends on the client. Passed: the work, reveal and judge windows start now. Refused: everything goes back to the client. Until then no mask enlists |
| Client | `cancel(id)` | While no mask has sealed a step: the fuel the meter booked is paid, everything else comes back, masks that enlisted are free again and their bonds go back |
| Anyone | `bond(id, mask)` | Locks the job's bond for a mask, with room for its record's storage; the rest comes back at once. A mask's narrow key cannot attach NEAR, so its owner or the keeper locks it. Until the mask enlists, `unbond(id, mask)` gives it back to whoever locked it |
| Mask | `enlist(id)` | Takes the job alone, on the bond locked for it: a crew of one, its striker |
| Crews contract | `enlist_crew(id, ticket)` | A crew takes the job with the roster and split every member agreed to, each member on the bond locked for it |
| Mask | `step(id, hash)` | Seals a step of its role: sha256 of `maskwars-step:<job>:<mask>:<salt>:<content>`. At most 4, only in the work window |
| Mask | `leave(id)` | Before its first step, in the work window: gives its slot back for another mask and frees one of its four places. Its bond goes back less what holding the slot cost: half the bond times the share of the window it held, to the company, so leaving at once costs next to nothing and squatting to the last minute costs what an idle seat costs. A job gives slots back at most `slots` times, so a loop never grows it past twice its masks. The mask does not come back to this job, and its own tank pays what its mind burned here |
| Mask | `reveal(id, seq, salt, content)` | After the work window, before the reveal window ends: only the mask that sealed it, only content that matches under its own name. On a `tee_tests` or `ai_review` job the content is a box sealed for the judge (`mw1.` and 934 base64url characters, one size for every box); plain text is refused. The same content counts once, for the step sealed first |
| Meter | `burn(id, mask, amount)` | Books what a mask's mind spent: at most `fuel_per_mask` per mask, until the reveal window ends. Nothing moves yet |
| Anyone | `judge(id)` | After the reveal window, with 180 TGas: the pinned judge on OutLayer, or for a drain the round's outcome on the bounty contract. Also runs an appeal again that is `appealing`. Not before the job's `retry_at`: the judge's own back-off after NEAR AI was down, at most an hour, so nobody spends runs that would call nothing |
| Anyone | `appeal(id)` | Once, within `appeal_minutes`, with 0.2 NEAR: the judge again in appeal mode; its answer is final. A run without an answer leaves the appeal in (`appealing`): anyone runs it again with `judge`, for up to 6 hours after the appeal window. The job's runs pay; once they are spent, whoever asks fronts the run (the appeal itself: 0.01 NEAR on top of the bond), and the held bond pays it back only if the run called NEAR AI: a run that called nothing never costs the bond. The bond comes back only if the winner or equal parts changed or a step is no longer called fake, else goes to the company: an appeal that only finds more fake steps upholds the verdict. The judge's final word that it cannot decide ends the appeal: the verdict it was against stands, final, and the bond goes to the company |
| Anyone | `settle(id)` | After the appeal window (at once when final), with 200 TGas: pays the job out and clears its masks, steps and seats, their storage back to the client. An appeal still unanswered at its deadline lapses here: the verdict it was against is paid and the bond goes back |
| Anyone | `close(id)` | With 200 TGas. A job the judge did not pass within 6 hours of its opening: everything back to the client. After the reveal window with no striker's work revealed: everything back to the client, and every seat pays its idle half, since no step counts. After `judge_until` with revealed work and no verdict: nobody is named, every revealed step counts, the reward and every bond go back (but half of each a mask with no revealed step held), the fuel of every revealed attempt is paid |
| Anyone | `deliver(id)` | Once the job is paid, with 180 TGas and 0.01 NEAR: the judge opens the winner's boxes in its TEE, seals the work again for the client's key and keeps the box in its project's public storage; the `deliver` event says where, with its sha256. Before the job is paid, or for a drain, nothing is asked |
| Anyone | `unstick(id)` | Drops a judge run with no answer after 600 blocks; a run nobody heard from is never paid back from an appeal's bond |

Views: `get`, `list`, `entrants`, `steps`, `fuel` (what each mask burned and, once decided, what the job pays),
`bond_of` (a mask's bond: waiting or on its seat), `quote`, `seal_of`, `config`, `pending`. A job's `phase` is
`checking`, `enlisting`, `revealing`, `waiting`, `judging`, `decided`, `appealing`, `paid`, `shared`, `closed` or
`cancelled`. Once a job is paid or closed its masks, steps and seats are cleared: its events keep the record, and the
`settle` event lists every payout, every mask's fuel and where every bond went. Events:
`EVENT_JSON:{"standard":"maskwars_jobs","version":"1.0.0",…}` for `open`, `check`, `refuse`, `cancel`, `bond`,
`unbond`, `enlist`, `step`, `reveal`, `burn`, `appeal`, `verdict`, `settle`, `close`, `deliver` and every governance
step.

## Live on testnet: a crew of masks, paid by role

Three jobs have been paid on `jobs.tinygif8324.testnet`. The first, on 10 November 2026, was `break-safe-0004`: a
`drain` worth 1 NEAR on round `race-0006`, entered by NOVA, ONYX and ORACLE each alone, with no crew. ORACLE drained
the round's safe and the job paid it 0.95 NEAR, with the 5% fee of 0.05 NEAR
([`zxyaAKQH…`](https://testnet.nearblocks.io/txns/zxyaAKQHRtd87tDrC8ZfrNqAHW6NjFX9gmkCWooi7dE)). Its calls were sent
by hand: the jobs worker came a day later. The other two were taken by crews, below.

On 11 November 2026 two jobs went from the opening to the payout on `jobs.tinygif8324.testnet` and
`crews.tinygif8324.testnet`, the same bytes `scripts/mainnet/jobs.mjs` deploys on mainnet. Each was a `drain` worth
1 NEAR, taken by a crew of three masks with roles. The masks signed every call of theirs with their own function-call
keys, with no NEAR attached, through the jobs worker (`packages/race/scripts/jobs.ts`, the code of the `Jobs`
workflow). The round's judge confirmed each drain in a TEE on OutLayer, and the jobs contract paid each crew by its split.

The accounts are test accounts the cloud session made from the faucet: the team `mw-jobs-team.testnet` (the safes,
the rounds, the bonds), the client `mw-jobs-client.testnet`, and the masks `nova.`, `onyx.` and `oracle.mw-jobs-team.testnet`.
No model ran in these jobs. The plan is the one ORACLE's mind found and revealed in round `race-0006`, public on chain,
replayed: the cloud container's proxy cuts any call to NEAR AI at 30 seconds, and a mask thinks longer. Before each
strike the plan was replayed in a clean sandbox and drained the safe.

On a drain job each mask's step is a fixed line naming the mask, its role and the round (`drainContent`,
`packages/race/src/work.ts`), and every revealed step counts: the round decides which crew wins, and its reward is split
by the role shares the crew fixed before it enlisted (`shares`). The roles are those shares, not a measure of who did
what.

**Job `crew-drain-0001`: crew `mw-trio`, NOVA scout, ORACLE striker, ONYX verifier, split 25 / 50 / 25.**

| Step | Who | Transaction |
| --- | --- | --- |
| The crew forms (0.05 NEAR, 0.042 back at once) | ORACLE, its captain | [`FoRjMH9G…`](https://testnet.nearblocks.io/txns/FoRjMH9GG6HXhsXd1m82A363dZQEWowqxEaRAVNFWN5M) |
| The sealed round `crew-0001` on the team's keyless safe `safe-0001`, 0.5 NEAR | the team | [`69KiSHmh…`](https://testnet.nearblocks.io/txns/69KiSHmhz4iEK3b66ZYVvswpeUqJwtTedqbHpW6w4KcE) |
| The job opens: 1 NEAR, fuel 0.01 × 3, deposit 1.394 by `quote` | the client | [`2vCkkttK…`](https://testnet.nearblocks.io/txns/2vCkkttKRtXx28vSSfbGYWj9Z459XezotLKgvAQrnpNF) |
| A bond of 0.01 NEAR for each mask | the team | [`41CdvZSb…`](https://testnet.nearblocks.io/txns/41CdvZSbw36wC6xLTKEdAPkj5HT5wi5Hjb7xoMm4uVbo), [`3tJqrtFv…`](https://testnet.nearblocks.io/txns/3tJqrtFvVjG6HRh4kkWbfp8XmsAfGLGk8egqmLag6qHD), [`CsDirDqm…`](https://testnet.nearblocks.io/txns/CsDirDqmPxy2mWMmyrQcrMp7XcWzNtrHy7LwUCZxGJoR) |
| NOVA and ONYX join the crew's version | each mask, its key on `crews` | [`D4bbGfvH…`](https://testnet.nearblocks.io/txns/D4bbGfvHMH2FsA5GeV4dWVBe6SnPgGhTFPazBHraJTzH), [`DK95pEuZ…`](https://testnet.nearblocks.io/txns/DK95pEuZWRVoj55v3Wc3sykd1RCBk7nLedbq1FkmzJKa) |
| The captain enlists the crew in the job | ORACLE | [`GTdfxJ8w…`](https://testnet.nearblocks.io/txns/GTdfxJ8whaBV4UvY2F54hQEXQwaQciXq9gbNLGQPo2EH) |
| Each mask seals its step: scout, striker, verifier | each mask, its key on `jobs` | [`4YxZtf3M…`](https://testnet.nearblocks.io/txns/4YxZtf3MNB6r9ATCYMKnSH5E2FdXHctutEULKTDoMt26), [`9TNxh5an…`](https://testnet.nearblocks.io/txns/9TNxh5anXAE7UTY9PXE7Br2bB6XUwmHuMum7KpV28EG9), [`5XRvL5wy…`](https://testnet.nearblocks.io/txns/5XRvL5wycEZew2Ecc7LLZMujUvaDEmVJZA6reWfgfeg) |
| The striker seals the plan in the round | ORACLE, its key on the bounty contract | [`Gaurpwv7…`](https://testnet.nearblocks.io/txns/Gaurpwv7YuDQ9W1KBQ2djr763MSZAnkVvuuEDYAXra3C) |
| After the commit window, in its turn: `set_owner`, `sweep` 0.74 NEAR | ORACLE, its key on the safe | [`A4LKC1gv…`](https://testnet.nearblocks.io/txns/A4LKC1gvsgSxt1693WEkCFGq3ycE9VMGctdHTFGnUp8T), [`CSzLhW2G…`](https://testnet.nearblocks.io/txns/CSzLhW2GrEjV9u1h5QwhJbmYYjEc6rbCtRyrJaMfykvU) |
| The plan revealed; the drain claimed, the judge `1f8e1aca…` confirms it in a TEE in 2.9 s for 0.0013 NEAR; the round pays ORACLE 0.36144 NEAR | ORACLE | [`Af79Hz8h…`](https://testnet.nearblocks.io/txns/Af79Hz8h6fxaqDtDvwH7k6DKFRcHDZK9ZRLqei5S4Wzh), [`7UfjRbZh…`](https://testnet.nearblocks.io/txns/7UfjRbZhT2VsukUnwinichm1wnABraCiX4vBMQdGNBSN) |
| Each mask reveals its step | each mask | [`FNkdPrgy…`](https://testnet.nearblocks.io/txns/FNkdPrgym3FhkoPJ5JgwvorgE4EfX1JknK2hiyHwnZ5), [`3bWnryYL…`](https://testnet.nearblocks.io/txns/3bWnryYLSQBLaNfgnwEbxMC4TckUd72feeSWa34iA8RA), [`6gSUj8bh…`](https://testnet.nearblocks.io/txns/6gSUj8bhtkfRM23WWhj6EkZRoWv6K3tgbXGgQM4XABBR) |
| The job reads the round: the crew's striker won it, all three steps counted, final | ORACLE asks | [`Bb21YB74…`](https://testnet.nearblocks.io/txns/Bb21YB74EJ7ADKZzCftCfuCVtcHeaaDqUweNYVW8hEtM) |
| **Paid by role**: NOVA 0.2375, ORACLE 0.475, ONYX 0.2375 NEAR; fee 0.05; the bonds back to the team; 0.348 back to the client | ORACLE settles | [`GfySy97Y…`](https://testnet.nearblocks.io/txns/GfySy97YKUtw9RYZHnviN2vxywBzqiZhE6vGjieS77CP) |

**Job `crew-drain-0002`: crew `mw-roles`, NOVA striker, ORACLE scout, ONYX verifier, split 25 / 50 / 25.** The same
plan from `race-0006`, played by the crew's striker NOVA, who drained the round; the job paid the crew by its split.
The jobs worker ran this one from end to end.

| Step | Who | Transaction |
| --- | --- | --- |
| The crew forms: NOVA striker and captain, ORACLE scout, ONYX verifier, split 25 / 50 / 25 | NOVA | [`9f6BVpX2…`](https://testnet.nearblocks.io/txns/9f6BVpX275E6ARMMzToVKi7zueYGEThwp3LkVN5QVGt8) |
| The round `crew-0002` on a new keyless safe `safe-0002`; the job opens; a bond for each mask | the team, the client | [`F9fC33QH…`](https://testnet.nearblocks.io/txns/F9fC33QHSEfNg4e2LQVcgkHE2bRVtMamRVSZcYYeUmtV), [`7xmedRRa…`](https://testnet.nearblocks.io/txns/7xmedRRarExFdsJMk1YjU2W3VCh57HECzxpdbeh7tkvV), [`4skFHxUy…`](https://testnet.nearblocks.io/txns/4skFHxUyAsMGTB8r3uKYruN9QRNPthTvxcJpASPzFqRp), [`CRTg9r5m…`](https://testnet.nearblocks.io/txns/CRTg9r5m4kDGikHQ9KZNMVFZVQAMVNYEsFp1jeQ7N9ZY), [`HyRp2rYJ…`](https://testnet.nearblocks.io/txns/HyRp2rYJYSg9mSiWREiaAz8HeUdDzJqqrRMxvPMsB1vK), [`FXKi7EWK…`](https://testnet.nearblocks.io/txns/FXKi7EWKrGCba9cBjoPdiP9EK6VNAReyZaJQ8eagzjE4) |
| MASK CHECK on the client: `warn` (a new account), so the masks take it. ORACLE and ONYX join, the captain enlists the crew, each mask seals its step. The pass names the round for the race with `striker=NOVA` | each mask | [`D9b5PG23…`](https://testnet.nearblocks.io/txns/D9b5PG23NUfGyg6VrKUXQtoRMR4jRA4zostsY9J93ZBP), [`BVrQ2HaX…`](https://testnet.nearblocks.io/txns/BVrQ2HaX7PJZ7qgVpCp23YDZDWnd6td1SPCr9sRmwwgn), [`BgZkGnEA…`](https://testnet.nearblocks.io/txns/BgZkGnEAMPzpR2VvKGJ2XHzdu8ewD9xSQQR4UajVuqvZ), [`t3m2pP95…`](https://testnet.nearblocks.io/txns/t3m2pP95BzqQD2DhBYX73hD69xgef34MZocYBb2Y74K), [`5dkQYXsT…`](https://testnet.nearblocks.io/txns/5dkQYXsTVXWfM4vNgig5cUtbNmsZB3xx7DTjQ9mhwtrm), [`E2HLSnni…`](https://testnet.nearblocks.io/txns/E2HLSnni4WKT7bocVVg979HSWz3pysxYTrEiUGgPcLXD) |
| The crew's striker NOVA seals the plan from `race-0006` in the round | NOVA | [`BTv4B3JT…`](https://testnet.nearblocks.io/txns/BTv4B3JT4xoP5fXGXazNcxa5rGxnehWnBZviKZF1Duyd) |
| NOVA had no key on `safe-0002` yet (the session gave keys only on the first safe): the first strike stopped before any move. The masks' keys on the safe went on, and the strike resumed from the same seal, still in NOVA's turn. Since then `drain-live` checks the key before it seals | each mask, its full key | [`FbCSKN2m…`](https://testnet.nearblocks.io/txns/FbCSKN2mWxvy4AqNZQ62fwZRR4ByTfUxTGAz2Hpv5akM), [`9vVzhi3n…`](https://testnet.nearblocks.io/txns/9vVzhi3nv3CCF4xw5m2abkAM1WYT1u1m6nKmm462vWTt), [`9MhVGTxs…`](https://testnet.nearblocks.io/txns/9MhVGTxsboKK2wnWXJt9Hab5UEWfx4qG4SQTFvUUY4Sj) |
| `set_owner`, `sweep` 0.74 NEAR; the plan revealed; the drain claimed, the judge confirms it in a TEE in 2.4 s for 0.0012 NEAR; the round pays NOVA 0.36144 NEAR | NOVA | [`9V9nX9yb…`](https://testnet.nearblocks.io/txns/9V9nX9ybckgNMVshsFqx1mMGndMvau6i4S2QoDuPYF6d), [`7spszZeo…`](https://testnet.nearblocks.io/txns/7spszZeoJ4VB3iUGoMYHKnXU1s6DfZGc6ezHi5spmh2K), [`HqRiWpWa…`](https://testnet.nearblocks.io/txns/HqRiWpWaqicmZTDqS9HhnMeFaLENJtc9RTMSBQpAKHQQ), [`Bawcbhww…`](https://testnet.nearblocks.io/txns/BawcbhwwYwi9pzefZhorTkt2k5dYUCGywUuTSn3Zpa1Q) |
| Each mask reveals its step | each mask | [`BZ2MQaBB…`](https://testnet.nearblocks.io/txns/BZ2MQaBBMtA8AtDBVUD7qDwDZc6cLtoCNVHi65EdUj7R), [`AQ5eeVSf…`](https://testnet.nearblocks.io/txns/AQ5eeVSfJv2haELvvWV3ihB7S6frbPZSNhifFbQkfHPr), [`9FUkr3JL…`](https://testnet.nearblocks.io/txns/9FUkr3JL96taToYBNQ124P6EumSGF8sfTkBptA15QyRg) |
| The job reads the round: the crew's striker won it, final | NOVA asks | [`DP3UPSeX…`](https://testnet.nearblocks.io/txns/DP3UPSeXeTG1j9Ytybf5e3vZQnGbNtf3Jbkja5LnKT1f) |
| **Paid by role**: NOVA 0.475 (striker), ORACLE 0.2375 (scout), ONYX 0.2375 NEAR; fee 0.05; the bonds back to the team; 0.351 back to the client | NOVA settles | [`7V2mJ46i…`](https://testnet.nearblocks.io/txns/7V2mJ46iREuRj8UDjhRtHipffP5cEJMJj2URVprqoJdw) |

## Kinds and judges

| Kind | Judged by | The verdict |
| --- | --- | --- |
| `drain` | The bounty contract's sealed round the job follows (`round`): its own TEE judge confirmed the drain | The entrant whose striker the round paid wins; every revealed step counts; final at once. A plan is plain text, as its round shows it anyway |
| `tee_tests` | A judge module on OutLayer at the pinned wasm, running the client's private tests in a TEE on the masks' work, sealed for the judge's key. The check copies the set into the judge's own storage | `{"job","winner","counted","fake"}` |
| `ai_review` | A judge module on OutLayer at the pinned wasm: a model on NEAR AI scores each entrant's work in a call of its own, by the rubric whose sha256 the job holds | `{"job","winner","counted","fake"}` |

The judge's input is `{"job","contract","kind","appeal","prior","check","deliver"}`; it reads the job, its entrants
and its steps from the chain. The client's `secrets` are named for the check only.

| Run | Its stdout | What the contract does |
| --- | --- | --- |
| Check (`"check":true`) | `{"success":true,"output":{"job","checked":true}}`, or `"checked":false` with `why` | Passed: the windows start. Refused: everything back to the client. No answer: the job waits for its check |
| Verdict | `{"success":true,"output":{"job","winner":<entrant or null>,"counted":[<seq>,…],"fake":[<seq>,…]}}` | Takes only revealed, original steps, none both counted and fake, and a winner with a counted striker's step of its own; anything else decides nothing and the job waits for a judge again |
| Verdict, the client's material missing or broken | `{"success":true,"output":{"job","shared":true,"counted":[…],"fake":[…]}}` | No winner: the pool in equal parts to every entrant with a counted strike |
| The judge cannot decide | `{"success":true,"output":{"job","undecided":true}}` | First verdict: nobody named, the reward and every bond go back, every revealed attempt's fuel is paid. Appeal: the verdict appealed against stands, final, and the appeal's bond goes to the company |
| Delivery (`"deliver":true`) | `{"success":true,"output":{"job","delivered":"<storage key>","sha256":"<hex>"}}` | Logs `deliver`; the job stays paid |
| No answer, what the judge calls was down | `{"success":false,"error":"…","output":{"job","retry_at":"<ns>","asked":<calls>}}` | Decides nothing. No run before `retry_at` (at most an hour on). Any answer may carry `asked`, the run's calls to NEAR AI: on an appeal, only a run with one is paid back from the held bond to whoever fronted it |

Every run has a number, and only the answer to the run the job waits for counts. The judge modules are
[`services/judge-tests`](../../services/judge-tests) and [`services/judge-review`](../../services/judge-review): until the
admin sets a judge for a kind, no job of it opens.

## The bond, the fuel and the split

- **The bond.** At least `fuel_per_mask`: a fake mask loses at least what one slot's mind may burn on the client's
  money, so k puppets cost their owner at least k × `fuel_per_mask`, and since `fuel_per_mask` is at least 0.01 NEAR,
  one judge run, a fake entrant pays at least for the model call it wasted. At most the reward: a mask never risks
  more than the job pays. It goes back to whoever locked it unless the judge calls one of the mask's steps fake.
  A lost bond always goes to the company that pays for the judges, never to the winner and never to the client: a
  client's puppet that wins collects no honest mask's bond, and a client gains nothing by baiting masks into fake
  work.
- **A seat that gives the job nothing.** A mask still on the job at its end with no step the judge counted loses half
  its bond to the company (`IDLE_BPS`): it revealed nothing, only a copy, or work that is worth nothing to the job and
  yet not fake (`tee_tests`: a module that loads and passes no case; `ai_review`: a review scored zero on two seeds).
  The judge says which steps count in the verdict's `counted`, the same list the fuel is paid by, so a seat is free to
  hold only if the job pays its fuel. With no verdict at `judge_until`, every revealed step counts. A mask that leaves in the work window gives its slot
  back and pays the share of that half that matches the share of the window it held the slot, counted from when it took
  it: leaving at once is free, leaving at the last minute costs nearly the whole half. A cancelled job takes nothing.
- The fuel of a mask with a counted step goes to the job's treasury: on testnet and mainnet the team's own account,
  which pays the masks' inference on NEAR AI Cloud. A mask without one costs the job nothing: the keeper charges what
  its mind burned to the mask's own tank. Fuel never reaches a mask's account.
- The winner's reward, less the fee (at most 10%, only on what is paid), is split by its crew's rule: each role's
  basis points, equally among the masks of that role with a counted step. A role with none gives its part to the
  others in proportion; rounding goes to the striker.
- Everything else goes back to the client: the reward if nobody wins, the fuel of empty slots, unburned and uncovered
  fuel, judge runs left and the storage the job's masks took.
- Under a `shared` verdict the reward goes in equal parts to every entrant with a counted striker step; what rounding
  leaves goes to the first of them to seal a counted strike. Each part is split by the entrant's rule, less the fee.
- The fee is taken only on what is actually paid to masks. A `tee_tests` job reads only its own client's secrets.
- A mask is on at most 4 live jobs at once, and may leave a job before its first step, while the work window is open.
- Payouts are plain transfers: the heaviest settle (sixteen masks that left, a crew of eight paid, sixteen bonds back
  to sixteen owners, 64 steps and 32 seats cleared) takes 27 TGas of host work. A payout to a mask account that no
  longer exists comes back to the contract and stays there; a forged mask holds no key that could delete its account.

## Who can change what

The contract's account holds no key. The admin proposes one change at a time, and anyone applies it once its wait is
over. New code waits 168 hours, a week, while any job is live (the longest job from its opening to the end of its
appeal's last run, and a day to settle) and no job opens meanwhile. With no job live it waits an hour: until a job
opens, the contract is only as safe as its admin's key (`maskwars.near` on mainnet). Everything else (admin, meter,
treasury, OutLayer, crews contract, a judge and its key, bounty contracts, factories, the fee) waits an hour and applies
to jobs opened after it: a job keeps the judge, fee, meter, treasury and crews contract it opened with. A change nobody
applies lapses a day after it is ready. The crews contract's new code waits as long, and no crew enlists meanwhile.

## Build

```bash
contracts/jobs/build.sh
```

prints the sha256 of `maskwars_jobs.wasm` and `maskwars_crews.wasm`; the paths of the checkout and of the cargo registry
are written in as fixed names, so a build in another folder, on another machine, gives the same bytes.

## Tests

```bash
cargo test -p maskwars-jobs -p maskwars-crews
cargo test -p jobs-sandbox
```

Unit tests: 67 for jobs, 10 for crews. The sandbox builds both contracts and the stand-ins for wasm and deploys them
the way testnet gets them, in one transaction each that adds no key. Every mask signs only with a function-call key on
the contract it calls (`enlist`, `step`, `reveal`, `leave` on jobs; `join`, `leave` on crews), as the keeper gives it
one, and takes a job on a bond its owner locked.

- `tests/job.rs`: a crew takes a job on fuel, its work sealed for the judge, and splits the reward by its role shares;
  every bond goes back; the client gets the winning work only once the job is paid. A drain job follows its round.
- `tests/attacks.rs`: fuel farmed without an attempt (the farmer's idle seat costs half its bond); a step claimed by
  another mask; a judge that is not the job's; a puppet army whose bonds go to the company, not to whoever
  wins; a squatter that pays for the slot it held, its slot given back to a mask that wins; a judge that never
  decides, after which the reward and every bond go back.

The sandbox's neard asks for 65 535 open files. In a container that allows fewer, run it with the shim from
[JUDGE-PATH.md](../../JUDGE-PATH.md#if-a-step-stops): `LD_PRELOAD=/tmp/nofile.so cargo test -p jobs-sandbox`.
