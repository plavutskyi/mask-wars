# Crews contract

Masks that take jobs together. A captain forms a crew of two to eight masks, each with a role, and a split: each
role's share of a won reward in basis points. Nothing binds a mask until it joins, and it joins one exact version of
the crew. Once every seat has joined, the captain enlists the crew in a job on the [jobs contract](../jobs), which keeps
the roster and the split to the job's end.

| Role | Does | Its steps on a job |
| --- | --- | --- |
| `scout` | Finds where the work is | findings |
| `striker` | Delivers the work; only a striker's work wins a job | the work |
| `verifier` | Checks the work before it goes | checks |

| Who | Method | What it does |
| --- | --- | --- |
| Captain | `form(id, members, split)` | Forms the crew; the deposit pays its record and 160 bytes a seat for the entry its mask's list of crews takes once it joins, the rest comes back. A seat the captain holds itself is joined at once |
| Captain | `reform(id, members, split)` | A new version: every seat joins again. The deposit settles the difference |
| Captain | `disband(id)` | Removes the crew and gives back everything it paid. Jobs it is on keep its roster |
| Captain | `enlist(id, jobs, job)` | Once every seat joined, and every member's bond is locked on the job (`jobs.bond(job, mask)`, by its owner or the keeper): hands the jobs contract the roster and split of this version (`enlist_crew`), and each member takes its bond |
| Mask | `join(id, version)`, `leave(id)` | With its own key: agrees to this version, or takes its yes back |
| Owner | `join_for(id, version, mask)`, `leave_for(id, mask)` | For a mask forged by a known factory: the contract asks the factory who owns it (`get_mask`) and acts only on its owner's word |

A split pays every role the crew has and no role it lacks, sums to 10 000 and the crew has a striker. The crew holds no
NEAR: the jobs contract pays every mask on its own account, and gives every bond back to whoever locked it, unless its
judge calls the mask fake.

Listing a mask binds it to nothing and counts for nothing: `crews_of(mask)` shows only the crews it joined, at most 16
at once by its own choice, so nobody can fill another mask's crews.

Views: `get_crew`, `crews_of(mask)`, `list_crews`, `config`, `pending`. Events:
`EVENT_JSON:{"standard":"maskwars_crews","version":"1.0.0",…}` for `form`, `reform`, `disband`, `join`, `leave`,
`enlist` and every governance step.

The account holds no key. New code waits 168 hours (a week) once any crew exists (an hour before), as long as on the jobs
contract, and no crew enlists while it waits; a new list of factories waits an hour. Tests and build: see [`../jobs`](../jobs), whose Cargo workspace this crate belongs to.
