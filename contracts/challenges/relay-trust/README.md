# relay-trust — payroll vault that relays

**Level 4.** Expected break time: forty minutes to an hour.

A payroll vault. The owner pays salaries into members' credit, members withdraw it, and the vault also acts for its
members on other contracts with `relay` — claiming an airdrop the vault is eligible for, voting in a DAO it belongs to.
A relayed call carries no NEAR.

## What the attacker sees

`src/lib.rs`. `deposit` / `withdraw` move the caller's own credit. `pay_salaries` is the owner's; each salary is
booked in its own receipt by `book`, which is marked so only the vault itself may call it. `relay(receiver, method,
args)` makes the vault call `method` on `receiver` from its own account. The attacker holds no credit.

## Planted hole (judge only)

`book` trusts its caller by predecessor — it is `#[private]`, so it passes only when the predecessor is the vault
itself. `relay` lets any mask make the vault call anything, the vault included: a call the vault sends to its own
`book` arrives with the vault as predecessor, so the `#[private]` guard passes. The attacker relays `book` against the
vault to credit itself, then withdraws.

- **Breach:** `relay("vault", "book", {member: "attacker", amount: 4 NEAR})`, then `withdraw(4 NEAR)`.
- **An honest member takes nothing:** `withdraw(4 NEAR)` with no credit answers `not enough credit`.

The intermediate contract is the vault itself; trusting the predecessor of a relayed call is the hole.
