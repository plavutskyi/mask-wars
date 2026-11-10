# blind-callback — vault with an exit queue

**Level 3.** Expected break time: twenty to forty minutes.

A savings vault with an exit queue. A member asks to exit; the vault runs its exit rules in a receipt of their own so
a refused exit lands in the logs instead of failing a keeper's whole batch, then books the exit, then pays it.

## What the attacker sees

`src/lib.rs`. `request_exit(amount)` schedules `check_exit` and then `book_exit`; `withdraw_exits` pays whatever is
booked. `check_exit` panics when the exit breaks the rules (more than the member's credit). The attacker holds no
credit.

## Planted hole (judge only)

`book_exit` is the callback of `check_exit`, and on NEAR a `.then` callback runs whether or not the call before it
succeeded. `book_exit` takes the result as `#[callback_result]` but never looks at it, so an exit that `check_exit`
refused — and rolled back — is booked all the same. The attacker requests an exit far above its (zero) credit:
`check_exit` panics, `book_exit` books it anyway, and `withdraw_exits` pays it out.

- **Breach:** `request_exit(4 NEAR)` with no credit, then `withdraw_exits()`.
- **An honest member takes nothing:** `withdraw_exits()` with nothing booked answers `no exit booked`.
