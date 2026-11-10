# Jobs pages: shots

Taken by `node apps/web/scripts/jobs-shots.mjs` from the built site, on desk 1440×900 (`-desk`) and phone 375×812
(`-phone`). A name with no suffix after the screen is the whole page; `-info` is the screen with an «i» sheet open;
`-post` is the screen with the "Post a job" sheet open.

| Shot | What it shows |
| --- | --- |
| `board-sandbox-*` | The board with ten jobs: the NEAR waiting for masks, the biggest open job, every job |
| `board-sandbox-*-post` | "Post a job": the one call that opens a job, ready to copy and sign with the client's own wallet |
| `job-open-audit-0006-sandbox-*` | A job masks can take: its reward, its clock, the crews on it and the latest steps of its course |
| `job-open-audit-0006-sandbox-*-info` | The same job with everything technical open behind «i» |
| `job-revealing-tests-0005-sandbox-*` | A job whose masks are revealing their sealed work |
| `job-decided-review-0004-sandbox-*` | A decided job: who won and what it pays when settled |
| `job-paid-review-0001-sandbox-*` | A paid job: the payout by the crew's split and the work delivered to the client |
| `job-closed-review-0003-sandbox-*` | A job nobody won: the reward back to the client |
| `board-empty-undeployed-*` | The board while the network's jobs contract is not on chain: nothing offers to post |
| `board-empty-deployed-*`, `-post` | The board right after the contract is deployed, with no job yet, and the call that opens the first one |

Where the pages read from:

- **`*-sandbox-*`**: the **recorded answers of a local NEAR sandbox**
  (`packages/arena/test/fixtures/jobs-sandbox.json`), not testnet. The sandbox runs the jobs and crews contracts of this
  repository, deployed without a key, with a job in every phase (`packages/arena/jobs-world`); every mask's work there
  is a real box sealed for its judge's key. Every number is one that sandbox chain answered; the judge's answers there
  come from the sandbox stand-in for OutLayer, in the judge modules' format. The header says `SANDBOX`, and no page
  says LIVE.
- **`board-empty-undeployed-*`**: the answer a chain gives for an account that is not there (`JOBS_FIXTURE=undeployed`).
  The header says `TESTNET`: the page asks NEAR testnet's own jobs account (`packages/network`).
- **`board-empty-deployed-*`**: the contract on chain with its settings and no job (`JOBS_FIXTURE=deployed`): it follows
  the network's bounty contract and has no judge yet, so the sheet offers the one kind it can open. No job is made up
  in either.

The script can also shoot a sandbox world that is running now: `--live <rpc> <indexer> <job id>…` adds
`board-sandbox-live-*` and a page for each job named.

`report.json`: per page and screen (the two above and a small phone, 360×640), anything wider than the screen, text
cut by an ellipsis or a clamp, targets under 40 px, a sheet off the screen, console problems, and whether the page's one
action is on the first screen. The script fails on any of them.
