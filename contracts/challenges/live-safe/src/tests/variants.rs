//! The safe's kinds (`variant` at `new`): `owner` as every safe was before, `limit` and `pause`. Kept beside lib.rs, not
//! in it: lib.rs is the source the masks read before a race, and these tests spell out what a mask has to find.
//!
//! For each new kind: the planted hole pays the mask in its own turn, the plain way out does not, the calls of the
//! other kinds are refused, nobody but a sealed mask of the round gets to the desk, every turn starts with the desk as
//! the round left it, and the desk never grows what the safe stores nor stands in the way of `retire`.

use super::*;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
/// The round's deadline: an hour after the commit window.
const DEADLINE: u64 = OPENS + 3600 * S;

fn kind(name: &str) -> Variant {
    serde_json::from_value(serde_json::json!(name)).unwrap()
}

/// A test makes several safes one after another under the same name, as the house does on chain: what the one before
/// stored (who has had a turn) goes with it.
fn gone() {
    near_sdk::mock::with_mocked_blockchain(|chain| drop(chain.take_storage()));
}

/// A practice safe of `variant`: no round, open at once to NOVA and ONYX.
fn practice_of(variant: Variant) -> Safe {
    gone();
    as_(SAFE);
    Safe::new(acc(SAFE), vec![acc(NOVA), acc(ONYX)], None, None, Some(variant))
}

/// A safe of `variant` armed for TEAM's round; NOVA sealed first, ONYX second.
fn armed_of(variant: Variant) -> Safe {
    gone();
    as_(SAFE);
    let masks = vec![acc(NOVA), acc(ONYX)];
    let mut s = Safe::new(acc(SAFE), masks.clone(), Some(acc(BOUNTY)), Some(acc(TEAM)), Some(variant));
    as_at(BOUNTY, 10 * S);
    s.arm("race-0004".into(), U64(OPENS), masks, acc(TEAM));
    sealed(&mut s, NOVA, 0);
    sealed(&mut s, ONYX, 1);
    s
}

/// What the call sent out of the safe: `(receiver, yoctoNEAR)` of every transfer.
fn transfers() -> Vec<(String, u128)> {
    near_sdk::test_utils::get_created_receipts()
        .into_iter()
        .flat_map(|r| {
            let to = r.receiver_id.to_string();
            r.actions.into_iter().filter_map(move |a| match a {
                near_sdk::mock::MockAction::Transfer { deposit, .. } => Some((to.clone(), deposit.as_yoctonear())),
                _ => None,
            })
        })
        .collect()
}

fn moves() -> Vec<Value> {
    events().into_iter().filter(|e| e["event"] == "move").collect()
}

/// Every call of every desk, as `who` would send it at `now`: the method and why the safe refused it.
fn every_desk(s: &mut Safe, who: &str, now: u64) -> Vec<(&'static str, String)> {
    let me = acc(who);
    let mut out = vec![];
    let mut try_ = |name: &'static str, f: &mut dyn FnMut(&mut Safe)| {
        as_at(who, now);
        out.push((name, panics(|| f(s))));
    };
    try_("set_owner", &mut |s| s.set_owner(me.clone()));
    try_("sweep", &mut |s| drop(s.sweep(me.clone(), U128(NEAR))));
    try_("request_exit", &mut |s| s.request_exit(U128(1)));
    try_("check_exit", &mut |s| s.check_exit());
    try_("withdraw", &mut |s| drop(s.withdraw()));
    try_("claim", &mut |s| drop(s.claim(U128(NEAR))));
    try_("book", &mut |s| s.book(U128(NEAR)));
    try_("cash_out", &mut |s| drop(s.cash_out()));
    try_("pause", &mut |s| s.pause());
    try_("unpause", &mut |s| s.unpause());
    out
}

const OWNER_DESK: [&str; 2] = ["set_owner", "sweep"];
const LIMIT_DESK: [&str; 3] = ["request_exit", "check_exit", "withdraw"];
const PAUSE_DESK: [&str; 5] = ["claim", "book", "cash_out", "pause", "unpause"];

#[test]
fn a_safe_is_of_the_owner_kind_unless_new_says_otherwise() {
    let s = practice();
    assert_eq!(s.variant(), Variant::Owner);
    assert_eq!(serde_json::to_value(s.variant()).unwrap(), "owner");
    assert!(!s.is_paused());
    for (name, variant) in [("owner", Variant::Owner), ("limit", Variant::Limit), ("pause", Variant::Pause)] {
        assert_eq!(kind(name), variant);
        let s = practice_of(variant);
        assert_eq!(serde_json::to_value(s.variant()).unwrap(), name);
        // Whatever its kind, a safe is born its own owner with its masks, as the judge reads it when the round opens.
        assert_eq!(s.get_owner(), acc(SAFE));
        assert_eq!(s.masks(), vec![acc(NOVA), acc(ONYX)]);
        assert_eq!(s.is_paused(), variant == Variant::Pause, "only a safe of the pause kind is born paused");
        assert_eq!(s.get_desk(), Desk { asked: U128(0), cleared: false, paused: s.is_paused(), booked: U128(0) });
    }
    assert!(serde_json::from_value::<Variant>(serde_json::json!("Owner")).is_err());
    assert!(serde_json::from_value::<Variant>(serde_json::json!("vault")).is_err());
}

#[test]
fn each_kind_has_its_own_desk_and_refuses_the_calls_of_the_others() {
    for (variant, own) in
        [(Variant::Owner, &OWNER_DESK[..]), (Variant::Limit, &LIMIT_DESK[..]), (Variant::Pause, &PAUSE_DESK[..])]
    {
        let mut s = practice_of(variant);
        for (method, why) in every_desk(&mut s, NOVA, 0) {
            if own.contains(&method) {
                assert_ne!(why, ANOTHER_KIND, "{variant:?} has {method}");
            } else {
                assert_eq!(why, ANOTHER_KIND, "{variant:?} has no {method}");
            }
        }
    }
}

#[test]
fn the_owner_kind_is_the_safe_as_it_was() {
    // Named or left out, it is the same safe: the planted hole of 1.5.0, its logs and its events.
    for named in [None, Some(Variant::Owner)] {
        gone();
        as_(SAFE);
        let mut s = Safe::new(acc(SAFE), vec![acc(NOVA), acc(ONYX)], None, None, named);
        as_(NOVA);
        s.set_owner(acc(NOVA));
        assert_eq!(get_logs()[0], format!("EVENT_JSON:{{\"standard\":\"maskwars_safe\",\"version\":\"1.5.0\",\"event\":\"turn\",\"data\":{{\"turn\":1,\"by\":\"{NOVA}\",\"from\":1,\"until_ns\":\"{TURN_NS}\"}}}}"));
        assert_eq!(get_logs()[2], format!("EVENT_JSON:{{\"standard\":\"maskwars_safe\",\"version\":\"1.5.0\",\"event\":\"move\",\"data\":{{\"n\":1,\"by\":\"{NOVA}\",\"turn\":1}}}}"));
        as_at(NOVA, S);
        drop(s.sweep(acc(NOVA), U128(3 * NEAR)));
        assert_eq!(transfers(), [(NOVA.to_string(), 3 * NEAR)]);
        assert_eq!(get_logs(), ["sweep 3 NEAR to nova.maskwars.testnet", &format!("EVENT_JSON:{{\"standard\":\"maskwars_safe\",\"version\":\"1.5.0\",\"event\":\"move\",\"data\":{{\"n\":2,\"by\":\"{NOVA}\",\"turn\":1}}}}")]);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn the_limit_desk_pays_a_withdrawal_within_the_limit_and_holds_a_bigger_one_for_the_owner() {
    let mut s = practice_of(Variant::Limit);
    // Within the limit: on file, cleared, paid to the caller. One move a call.
    as_(NOVA);
    s.request_exit(U128(WITHDRAW_LIMIT));
    assert_eq!(s.get_desk(), Desk { asked: U128(WITHDRAW_LIMIT), cleared: true, paused: false, booked: U128(0) });
    assert_eq!(moves().len(), 1);
    as_at(NOVA, S);
    drop(s.withdraw());
    assert_eq!(transfers(), [(NOVA.to_string(), WITHDRAW_LIMIT)]);
    assert_eq!(moves().len(), 1);
    assert_eq!(s.get_desk(), Desk::of(Variant::Limit), "nothing is left on file");
    as_at(NOVA, 2 * S);
    assert_eq!(panics(|| drop(s.withdraw())), "no exit on file");

    // Above it: the request waits for the owner, and a mask is not the owner.
    let mut s = practice_of(Variant::Limit);
    as_(NOVA);
    s.request_exit(U128(WITHDRAW_LIMIT + 1));
    assert!(!s.get_desk().cleared);
    as_at(NOVA, S);
    assert_eq!(panics(|| drop(s.withdraw())), "the exit on file waits for the owner");
    as_at(NOVA, S);
    assert_eq!(panics(|| s.check_exit()), "owner only");
    as_at(NOVA, S);
    assert_eq!(panics(|| s.request_exit(U128(0))), "amount: more than nothing");
    assert!(transfers().is_empty());
}

#[test]
fn twelve_honest_calls_at_the_limit_desk_take_less_than_any_round_asks_for() {
    // A plan is 12 calls at most (the bounty contract) and a round's min_loot is 0.1 NEAR at least: six withdrawals
    // within the limit, all a plan has room for, stay far below it.
    let mut s = practice_of(Variant::Limit);
    let mut taken = 0;
    for call in 0..6 {
        as_at(NOVA, 2 * call * S);
        s.request_exit(U128(WITHDRAW_LIMIT));
        as_at(NOVA, (2 * call + 1) * S);
        drop(s.withdraw());
        taken += transfers().iter().map(|(_, yocto)| yocto).sum::<u128>();
    }
    assert_eq!(s.touches(acc(NOVA)).moves, U64(12));
    assert_eq!(taken, 6 * WITHDRAW_LIMIT);
    assert!(taken * 3 < NEAR / 10, "{taken}");
}

#[test]
fn the_planted_hole_of_the_limit_kind_takes_the_safe_in_three_calls() {
    let mut s = armed_of(Variant::Limit);
    as_at(NOVA, OPENS);
    s.request_exit(U128(WITHDRAW_LIMIT));
    assert_eq!(events()[0]["event"], "turn");
    as_at(NOVA, OPENS + S);
    s.request_exit(U128(2 * NEAR));
    as_at(NOVA, OPENS + 2 * S);
    drop(s.withdraw());
    assert_eq!(transfers(), [(NOVA.to_string(), 2 * NEAR)], "the mask itself is paid");
    let m = moves();
    assert_eq!((m.len(), &m[0]["data"]["n"], &m[0]["data"]["turn"]), (1, &serde_json::json!(3), &serde_json::json!(1)));
    assert_eq!(s.touches(acc(NOVA)).moves, U64(3), "three calls, three moves, one turn");
}

#[test]
fn a_withdrawal_is_paid_as_far_as_the_safe_can_pay() {
    // The test safe holds 5 NEAR and its storage locks 1: it can pay out 4.
    let mut s = practice_of(Variant::Limit);
    as_(NOVA);
    assert_eq!(s.available(), U128(4 * NEAR));
    s.request_exit(U128(1));
    as_at(NOVA, S);
    s.request_exit(U128(900 * NEAR));
    as_at(NOVA, 2 * S);
    drop(s.withdraw());
    assert_eq!(transfers(), [(NOVA.to_string(), 4 * NEAR)]);
}

// ---------------------------------------------------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn a_paused_safe_pays_no_claim_and_only_its_owner_lifts_the_pause() {
    let mut s = practice_of(Variant::Pause);
    as_(NOVA);
    assert_eq!(panics(|| drop(s.claim(U128(NEAR)))), "the safe is paused");
    as_(NOVA);
    assert_eq!(panics(|| s.unpause()), "owner only");
    as_(NOVA);
    assert_eq!(panics(|| s.pause()), "owner only");
    as_(NOVA);
    assert_eq!(panics(|| drop(s.cash_out())), "nothing is on the book");
    as_(NOVA);
    assert_eq!(panics(|| s.book(U128(0))), "amount: more than nothing");
    assert!(s.is_paused());
    assert_eq!(s.touches(acc(NOVA)).moves, U64(0), "a refused call is no move");
}

#[test]
fn the_planted_hole_of_the_pause_kind_takes_the_safe_in_two_calls() {
    let mut s = armed_of(Variant::Pause);
    as_at(NOVA, OPENS);
    s.book(U128(2 * NEAR));
    assert_eq!(events()[0]["event"], "turn");
    assert!(transfers().is_empty(), "a booking moves no NEAR");
    assert_eq!(s.get_desk(), Desk { asked: U128(0), cleared: false, paused: true, booked: U128(2 * NEAR) });
    as_at(NOVA, OPENS + S);
    drop(s.cash_out());
    assert_eq!(transfers(), [(NOVA.to_string(), 2 * NEAR)], "the mask itself is paid");
    assert!(s.is_paused(), "and the safe is paused all along");
    let m = moves();
    assert_eq!((m.len(), &m[0]["data"]["n"], &m[0]["data"]["turn"]), (1, &serde_json::json!(2), &serde_json::json!(1)));
    as_at(NOVA, OPENS + 2 * S);
    assert_eq!(panics(|| drop(s.cash_out())), "nothing is on the book", "an exit is paid once");
}

#[test]
fn an_exit_is_paid_as_far_as_the_safe_can_pay() {
    let mut s = practice_of(Variant::Pause);
    as_(NOVA);
    s.book(U128(900 * NEAR));
    as_at(NOVA, S);
    drop(s.cash_out());
    assert_eq!(transfers(), [(NOVA.to_string(), 4 * NEAR)]);
}

// ---------------------------------------------------------------------------------------------------------------------
// every kind: the round's lock, the turns, storage, retire
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn only_a_sealed_mask_of_the_round_reaches_a_desk_and_only_after_the_window() {
    for variant in [Variant::Owner, Variant::Limit, Variant::Pause] {
        let mut s = armed_of(variant);
        // Nobody the safe does not list: not a stranger, not its team, not the bounty contract, not itself.
        for who in ["stranger.testnet", TEAM, BOUNTY, SAFE] {
            for (method, why) in every_desk(&mut s, who, OPENS + S) {
                assert_eq!(why, "this safe is open to the round's masks only", "{variant:?} {method} by {who}");
            }
        }
        // Not a mask of the round before the commit window is over.
        for (method, why) in every_desk(&mut s, NOVA, OPENS - 1) {
            assert_eq!(why, "the safe is locked until the commit window closes", "{variant:?} {method}");
        }
        // Not a later seal while the earlier one has its slot.
        for (method, why) in every_desk(&mut s, ONYX, OPENS) {
            assert_eq!(why, EARLIER_SEAL, "{variant:?} {method}");
        }
        assert_eq!(s.touches(acc(NOVA)).moves, U64(0), "{variant:?}: nothing moved the safe");
    }
    // A mask of the round that sealed nothing.
    for variant in [Variant::Limit, Variant::Pause] {
        gone();
        as_(SAFE);
        let masks = vec![acc(NOVA), acc(ONYX)];
        let mut s = Safe::new(acc(SAFE), masks.clone(), Some(acc(BOUNTY)), Some(acc(TEAM)), Some(variant));
        as_at(BOUNTY, 10 * S);
        s.arm("race-0004".into(), U64(OPENS), masks, acc(TEAM));
        sealed(&mut s, NOVA, 0);
        for (method, why) in every_desk(&mut s, ONYX, OPENS + TURN_NS) {
            assert_eq!(why, "only a mask that sealed a plan moves the safe", "{variant:?} {method}");
        }
    }
}

#[test]
fn every_turn_starts_with_the_desk_as_the_round_left_it() {
    // limit: NOVA clears a small request and puts a big one on file, then stops. ONYX's turn starts with nothing on
    // file: the withdrawal NOVA left is not ONYX's to take.
    let mut s = armed_of(Variant::Limit);
    as_at(NOVA, OPENS);
    s.request_exit(U128(WITHDRAW_LIMIT));
    as_at(NOVA, OPENS + S);
    s.request_exit(U128(2 * NEAR));
    assert_eq!(s.get_desk(), Desk { asked: U128(2 * NEAR), cleared: true, paused: false, booked: U128(0) });
    as_at(ONYX, OPENS + TURN_NS);
    assert_eq!(panics(|| drop(s.withdraw())), "no exit on file");
    assert_eq!(s.touches(acc(ONYX)).first_ns, None, "the refused call started no turn");
    as_at(ONYX, OPENS + TURN_NS);
    s.request_exit(U128(3 * NEAR));
    assert_eq!(s.get_desk(), Desk { asked: U128(3 * NEAR), cleared: false, paused: false, booked: U128(0) });
    as_at(ONYX, OPENS + TURN_NS + S);
    assert_eq!(panics(|| drop(s.withdraw())), "the exit on file waits for the owner");

    // pause: the exit NOVA booked is gone when ONYX's turn starts, and the safe is paused again.
    let mut s = armed_of(Variant::Pause);
    as_at(NOVA, OPENS);
    s.book(U128(2 * NEAR));
    as_at(ONYX, OPENS + TURN_NS);
    assert_eq!(panics(|| drop(s.cash_out())), "nothing is on the book");
    as_at(ONYX, OPENS + TURN_NS);
    assert_eq!(panics(|| drop(s.claim(U128(NEAR)))), "the safe is paused");
}

#[test]
fn a_desk_never_grows_what_the_safe_stores() {
    for variant in [Variant::Owner, Variant::Limit, Variant::Pause] {
        let born = stored(&armed_of(Variant::Owner));
        let mut s = armed_of(variant);
        assert_eq!(stored(&s), born, "{variant:?}: every kind stores the same");
        as_at(NOVA, OPENS);
        match variant {
            Variant::Owner => s.set_owner(acc(NOVA)),
            Variant::Limit => s.request_exit(U128(WITHDRAW_LIMIT)),
            Variant::Pause => s.book(U128(u128::MAX)),
        }
        let first = stored(&s);
        as_at(NOVA, OPENS + S);
        match variant {
            Variant::Owner => drop(s.sweep(acc(NOVA), U128(NEAR))),
            Variant::Limit => {
                s.request_exit(U128(u128::MAX));
                as_at(NOVA, OPENS + 2 * S);
                drop(s.withdraw());
            }
            Variant::Pause => drop(s.cash_out()),
        }
        // The first move of the first turn writes the turn and the time of the last move, once; the desk adds nothing,
        // and a payout, never a turn's first move, leaves the size as it was: it may pay to the last yoctoNEAR.
        assert_eq!(stored(&s), first, "{variant:?}");
    }
}

#[test]
fn a_drained_safe_of_any_kind_retires_like_any_other() {
    for variant in [Variant::Limit, Variant::Pause] {
        let mut s = armed_of(variant);
        as_at(NOVA, OPENS);
        match variant {
            Variant::Limit => {
                s.request_exit(U128(1));
                as_at(NOVA, OPENS + S);
                s.request_exit(U128(900 * NEAR));
                as_at(NOVA, OPENS + 2 * S);
                drop(s.withdraw());
            }
            _ => {
                s.book(U128(900 * NEAR));
                as_at(NOVA, OPENS + S);
                drop(s.cash_out());
            }
        }
        assert_eq!(transfers(), [(NOVA.to_string(), 4 * NEAR)], "{variant:?}: all the safe could pay out");
        // The team asks, the safe asks the bounty contract, and on its word the safe deletes its own account.
        for who in [NOVA, "stranger.testnet"] {
            as_at(who, DEADLINE);
            assert_eq!(panics(|| drop(s.retire())), "only the safe's team retires it", "{variant:?}");
        }
        as_at(TEAM, DEADLINE);
        drop(s.retire());
        as_at(SAFE, DEADLINE);
        let answer = serde_json::json!({ "owner": TEAM, "amount": "1", "target": SAFE,
                                         "deadline_ns": DEADLINE.to_string(), "status": { "state": "drained" } });
        drop(s.on_retire(10 * S, Ok(Some(serde_json::from_value(answer).unwrap()))));
        let e = events();
        assert_eq!((&e[0]["event"], &e[0]["data"]["to"]), (&serde_json::json!("retired"), &serde_json::json!(TEAM)));
        let deleted = near_sdk::test_utils::get_created_receipts().into_iter().any(|r| {
            r.receiver_id.as_str() == SAFE
                && r.actions.iter().any(|a| matches!(a, near_sdk::mock::MockAction::DeleteAccount { .. }))
        });
        assert!(deleted, "{variant:?}: the safe deletes its own account");
    }
}
