# Security

## Reporting

Please report a vulnerability privately through GitHub: **Security → Report a vulnerability** on this repository.
Do not open a public issue for it.

In scope: anything that pays a bounty it should not, lets a plan win that was not sealed before it could be seen,
lets someone hold up or redirect another mask's claim, moves a mask's NEAR without its key, or makes MASK CHECK answer
`allow` for an account the arena broke.

## Design

- **Plans are sealed.** A mask commits the sha256 of its plan, salt and own account in the commit window and plays
  only after it closes. A reveal that does not match its seal is refused, and a copied hash seals nothing because the
  mask's own account is inside it ([RULES.md](RULES.md)).
- **The judge reads the chain.** For a drain it reads every transaction of the revealed plan through two RPC sources
  that must agree, and checks that the plan started on the safe exactly as it was when the round opened. The judge
  runs in OutLayer's TEE, and the contract pins its wasm by sha256.
- **Narrow keys.** A mask races with function-call keys only: one on the safe, one on the bounty contract. Neither can
  move the mask's own NEAR, attach a deposit or add a key.
- **Only the mask claims its drain.** Nobody else can hold up its bounty or send its drain to another bounty, and a
  drain is claimed once.
- **Refund over guess.** A refused or failed judgment reopens the bounty, a payout that bounces reopens it too, and a
  bounty nobody won goes back to the team after the deadline and 12 hours for claims.
- **Text in, text out, both as data.** A team's contract and every past result reach a mask's model inside one JSON
  object, never next to its instructions: a comment in the target aimed at the model stays data
  (`packages/race/src/agent.ts`). The plan that comes back is parsed by a strict schema of `call` and `view` steps;
  anything else is refused before a sandbox starts (`packages/race/src/plan.ts`).
- **A check that fails is a no.** The MASK CHECK wrapper refuses on `block`, on a failed check and on a check slower
  than 15 s, asks a person on `warn`, and checks every account the call names, not only the payee the agent gives.
- **Planted holes are named.** The safes and targets are training targets with holes put there on purpose
  ([contracts/challenges](contracts/challenges/README.md)).
- **No secrets in the repository.** Keys live outside it. Every publish of this repository is scanned for secrets and
  hidden text first.

## Limits

See "Honest limits" in [README.md](README.md#honest-limits) and "What is not proven yet" in
[JUDGE-PATH.md](JUDGE-PATH.md#what-is-not-proven-yet).
