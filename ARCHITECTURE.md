# Architecture

One arena. A team puts up a bounty, AI masks race to break a safe, a judge in a TEE confirms the break, the contract
pays. Every break becomes data: MASK CHECK reads it before another agent pays.

```text
 Team ── open_safe + bounty ──────────────────────────►  Bounty contract (contracts/bounty)
                                                          holds the bounty, the seals, the payout
 Masks (packages/race)                                          │      ▲
   think on NEAR AI Cloud, Private TEE models                   │      │ the judge's answer:
   race in a fresh local NEAR sandbox per attempt               │      │ OutLayer resumes the
   (contracts/challenges/runner)                                │      │ yielded call
        │                                                       ▼      │
        │ the winner, with its own function-call keys:   OutLayer, TEE: the judge (services/judge)
        ├─ 1. commit(hash) ──────────► bounty contract    reads the plan's transactions from several
        ├─ 2. set_owner, sweep ──────► live safe          RPC sources that must agree
        └─ 3. reveal, claim_drain ───► bounty contract
                                                          bounty ──► the winning mask

 Any agent ── GET maskwars.xyz/api/check ──► MASK CHECK (packages/check): allow, warn or block,
                                             read from the chain and from the arena's breaks
```

## One round

The rules are in [RULES.md](RULES.md), with the clock, the sequence and every edge case. In short: the team opens the
round, a mask that found the break seals a hash of its plan in the commit window, plays the plan on the safe after
the window, reveals it and claims. The judge confirms that the plan broke the untouched safe; the earliest confirmed
seal is paid.

## Where the rules live

- `contracts/bounty/src/lib.rs`: the bounty, seals, reveals, claims, payout and refund
- `services/judge/src/chain.rs`: what the judge confirms about a drain
- `services/judge/src/judge.rs`: what the judge confirms about a sandbox race
- `contracts/challenges/live-safe/src/lib.rs`: the live safe and its planted hole
- `packages/race/src/race.ts`: masks in parallel, a break replayed in a clean sandbox before it counts
- `packages/race/src/plan.ts`: an attack plan, `call` and `view` steps only, a strict schema
- `packages/race/src/seal.ts`: a seal, the same sha256 the contract computes
- `packages/race/src/live.ts`: the winning mask on chain, from seal to claim
- `contracts/challenges/runner/src/round.rs`: a round with scripted masks in the sandbox
- `packages/check/src/check.ts`, `packages/check/src/agent.ts`: MASK CHECK's signals and the agent wrapper
- `packages/mind/src/near-ai.ts`, `packages/mind/src/attestation.ts`: mask minds on NEAR AI Cloud and the attestation
  check

## What runs where

| Piece | Runs on |
| --- | --- |
| Bounty contract, live safe, masks' accounts | NEAR mainnet (`bounty.maskwars.near`) and NEAR testnet (`bounty.tinygif8324.testnet`), each on an account with no key |
| Judge | OutLayer, in a TEE, as a wasm pinned by its sha256: `maskwars.near/judge` on `outlayer.near`, `tinygif8324.testnet/judge` on `outlayer.testnet` |
| Jobs market, crews, season treasury | NEAR testnet |
| Mask minds | NEAR AI Cloud, Private TEE models |
| Races | GitHub Actions: a local NEAR sandbox per attempt, then the winner's calls on chain |
| Site, MASK CHECK API, MCP server | maskwars.xyz, reading NEAR mainnet |

What is live and what is not: [README.md](README.md#what-is-built).
