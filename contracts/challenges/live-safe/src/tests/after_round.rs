//! After the round: what the safe's team may take back and when the safe goes (`reclaim`, `retire`). Kept beside
//! lib.rs, not in it: lib.rs is the source the masks read before a race.

use super::*;

// A round nobody won (final review, finding 2): its NEAR stayed in a safe nobody holds a key to, for good.

/// The round's deadline: an hour after the commit window.
const DEADLINE: u64 = OPENS + 3600 * S;
/// When `armed` safes were armed: what the safe's answers to itself carry.
const ARMED: u64 = 10 * S;

/// What the bounty contract's `get` answers for the round.
fn bounty_is(state: &str) -> Result<Option<Bounty>, PromiseError> {
    let answer = serde_json::json!({ "owner": TEAM, "amount": "1", "target": SAFE,
                                     "deadline_ns": DEADLINE.to_string(), "status": { "state": state } });
    Ok(Some(serde_json::from_value(answer).unwrap()))
}

/// The receipts the call made, readable: receiver, then each call with its arguments, or the action. The safe's
/// answers to itself carry when it was armed, in Borsh: shown as that number.
fn receipts() -> String {
    let mut out = String::new();
    for r in near_sdk::test_utils::get_created_receipts() {
        out.push_str(&format!("-> {}:", r.receiver_id));
        for a in r.actions {
            match a {
                near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, .. } => out.push_str(&format!(
                    " call {}({})",
                    String::from_utf8_lossy(&method_name),
                    match <[u8; 8]>::try_from(args.as_slice()) {
                        Ok(armed_ns) => format!("armed_ns {}", u64::from_le_bytes(armed_ns)),
                        Err(_) => String::from_utf8_lossy(&args).into_owned(),
                    }
                )),
                other => out.push_str(&format!(" {other:?}")),
            }
        }
        out.push('\n');
    }
    out
}

#[test]
fn only_the_team_of_an_armed_safe_asks_to_take_back_what_its_round_left() {
    let mut s = armed();
    for who in [NOVA, "stranger.testnet", BOUNTY, SAFE] {
        as_at(who, DEADLINE + CLAIM_GRACE_NS);
        assert_eq!(panics(|| drop(s.reclaim())), "only the safe's team takes back what its round left", "{who}");
    }
    as_at(TEAM, DEADLINE + CLAIM_GRACE_NS);
    drop(s.reclaim());
    // The safe asks the bounty contract that armed it how its round ended; the team's word is not enough.
    let text = receipts();
    assert!(text.contains(&format!("-> {BOUNTY}: call get({{\"id\":\"race-0004\"}})")), "{text}");
    assert!(text.contains(&format!("-> {SAFE}: call on_bounty(armed_ns {ARMED})")), "{text}");
    let mut p = practice();
    as_at(TEAM, DEADLINE + CLAIM_GRACE_NS);
    assert_eq!(panics(|| drop(p.reclaim())), "a practice safe has no team");
    let mut f = fresh(&[NOVA, ONYX]);
    as_at(TEAM, DEADLINE + CLAIM_GRACE_NS);
    assert_eq!(panics(|| drop(f.reclaim())), "the safe took no round");
}

#[test]
fn the_team_takes_back_a_round_nobody_won_only_once_its_bounty_is_refunded_and_the_grace_is_over() {
    let mut s = armed();
    as_at(SAFE, DEADLINE + CLAIM_GRACE_NS);
    assert_eq!(
        panics(|| drop(s.on_bounty(ARMED, bounty_is("open")))),
        "the round is not over: its bounty is still open"
    );
    assert_eq!(panics(|| drop(s.on_bounty(ARMED, Err(PromiseError::Failed)))), "the bounty contract did not answer");
    as_at(SAFE, DEADLINE + CLAIM_GRACE_NS - 1);
    assert_eq!(panics(|| drop(s.on_bounty(ARMED, bounty_is("refunded")))), "the masks can still claim");
    assert!(receipts().is_empty(), "nothing left the safe");
    as_at(SAFE, DEADLINE + CLAIM_GRACE_NS);
    let back = s.on_bounty(ARMED, bounty_is("refunded"));
    assert!(matches!(back, PromiseOrValue::Promise(_)), "the answer comes once the NEAR is with the team");
    drop(back);
    // 5 NEAR, 1 of them locked by the safe's storage: 4 go to the team.
    let text = receipts();
    assert!(text.contains(TEAM) && text.contains(&NearToken::from_near(4).as_yoctonear().to_string()), "{text}");
    let e = events();
    assert_eq!(e[0]["event"], "reclaimed");
    let four = NearToken::from_near(4).as_yoctonear().to_string();
    assert_eq!(e[0]["data"], serde_json::json!({ "bounty": "race-0004", "to": TEAM, "amount": four }));
    // A reclaim is no move: the round the judge checks and the count of moves are as they were.
    assert_eq!(s.get_round().unwrap().bounty, "race-0004");
    assert_eq!(s.touches(acc(TEAM)), Touches { moves: U64(0), last_ns: None, first_ns: None });
}

#[test]
fn after_a_mask_won_the_round_the_team_takes_nothing() {
    let mut s = armed();
    as_at(NOVA, OPENS);
    s.set_owner(acc(NOVA));
    sweep_all(&mut s, NOVA, OPENS + S);
    as_at(SAFE, DEADLINE + CLAIM_GRACE_NS);
    for state in ["drained", "paid"] {
        assert_eq!(
            panics(|| drop(s.on_bounty(ARMED, bounty_is(state)))),
            "a mask won the round: what it left in the safe stays"
        );
    }
    assert!(receipts().is_empty(), "nothing left the safe");
}

// Retiring the safe (the daily round in mainnet): a safe nobody holds a key to kept the NEAR its code locks for
// good. Its team retires it once the round is over, and the account that made it makes it again the next day.

/// The safe's whole state, to tell that a refused call changed none of it.
fn state(s: &Safe) -> Vec<u8> {
    near_sdk::borsh::to_vec(s).unwrap()
}

/// The call deleted the safe's own account and left everything to the team, and did nothing else.
fn gone_to_the_team() -> bool {
    receipts() == format!("-> {SAFE}: DeleteAccount {{ receipt_index: 0, beneficiary_id: AccountId(\"{TEAM}\") }}\n")
}

/// A round NOVA won through the planted hole: NOVA is the safe's owner now.
fn won() -> Safe {
    let mut s = armed();
    as_at(NOVA, OPENS);
    s.set_owner(acc(NOVA));
    sweep_all(&mut s, NOVA, OPENS + S);
    s
}

#[test]
fn only_the_team_asks_to_retire_the_safe() {
    let mut s = won();
    assert_eq!(s.get_owner(), acc(NOVA), "the hole gave NOVA the safe, not the right to retire it");
    let before = state(&s);
    // Another mask of the round, the mask that took the safe, a stranger, the bounty contract, the safe itself.
    for who in [ONYX, NOVA, "stranger.testnet", BOUNTY, SAFE] {
        as_at(who, DEADLINE);
        assert_eq!(panics(|| drop(s.retire())), "only the safe's team retires it", "{who}");
        assert!(receipts().is_empty(), "{who}");
    }
    as_at(TEAM, DEADLINE);
    drop(s.retire());
    // The safe asks the bounty contract that armed it how its round ended; the team's word is not enough.
    let text = receipts();
    assert!(text.contains(&format!("-> {BOUNTY}: call get({{\"id\":\"race-0004\"}})")), "{text}");
    assert!(text.contains(&format!("-> {SAFE}: call on_retire(armed_ns {ARMED})")), "{text}");
    assert!(!text.contains("DeleteAccount"), "nothing is deleted before the answer: {text}");
    assert!(events().is_empty());
    assert_eq!(state(&s), before, "asking changes nothing in the safe");
}

#[test]
fn a_practice_safe_is_never_retired() {
    let mut p = practice();
    // Its owner, a mask of it, the mask that took it through the hole: it names no team.
    as_(NOVA);
    p.set_owner(acc(NOVA));
    for who in ["maskwars.testnet", ONYX, NOVA, SAFE] {
        as_at(who, DEADLINE);
        assert_eq!(panics(|| drop(p.retire())), "a practice safe has no team", "{who}");
        assert!(receipts().is_empty(), "{who}");
    }
}

#[test]
fn a_safe_that_took_no_round_is_retired_at_once() {
    let mut s = fresh(&[NOVA, ONYX]);
    for who in [NOVA, "stranger.testnet", BOUNTY, SAFE] {
        as_at(who, S);
        assert_eq!(panics(|| drop(s.retire())), "only the safe's team retires it", "{who}");
    }
    as_at(TEAM, S);
    drop(s.retire());
    // No question to the bounty contract: no round stands on the safe. The whole balance goes to the team.
    assert!(gone_to_the_team(), "{}", receipts());
    let e = events();
    assert_eq!((e.len(), e[0]["event"].as_str(), e[0]["version"].as_str()), (1, Some("retired"), Some("1.5.0")));
    let five = NearToken::from_near(5).as_yoctonear().to_string();
    assert_eq!(e[0]["data"], serde_json::json!({ "bounty": "", "to": TEAM, "amount": five }));
    // It sends its deletion once.
    as_at(TEAM, S);
    assert_eq!(panics(|| drop(s.retire())), RETIRING);
    assert!(receipts().is_empty());
    // A round whose `arm` was on its way when the deletion was sent does not stand on the safe: the bounty contract
    // hears the refusal and keeps the round off it.
    let before = state(&s);
    as_at(BOUNTY, 10 * S);
    assert_eq!(panics(|| s.arm("race-0004".into(), U64(OPENS), vec![acc(NOVA), acc(ONYX)], acc(TEAM))), RETIRING);
    assert_eq!(state(&s), before, "the refused arm changed nothing");
    assert!(s.get_round().is_none());
}

#[test]
fn the_safe_of_an_open_round_stays_whatever_the_team_says() {
    let mut s = won();
    let before = state(&s);
    // Long after the deadline, and still: an open bounty, a claim with the judge, no answer, an empty answer, an
    // answer the safe cannot read.
    as_at(SAFE, DEADLINE + CLAIM_GRACE_NS);
    for state in ["open", "judging"] {
        assert_eq!(
            panics(|| drop(s.on_retire(ARMED, bounty_is(state)))),
            "the round is not over: its bounty is still open",
            "{state}"
        );
    }
    assert_eq!(
        panics(|| drop(s.on_retire(ARMED, bounty_is("settling")))),
        "the bounty contract does not say how the round ended"
    );
    for none in [Err(PromiseError::Failed), Err(PromiseError::TooLong(4096)), Ok(None)] {
        assert_eq!(panics(|| drop(s.on_retire(ARMED, none))), "the bounty contract did not answer");
    }
    assert!(receipts().is_empty() && events().is_empty(), "nothing left the safe");
    assert_eq!(state(&s), before, "a refusal changes nothing in the safe");
    // The round goes on as if nobody had asked: ONYX, sealed second, still has its turn.
    as_at(ONYX, DEADLINE + CLAIM_GRACE_NS);
    s.set_owner(acc(ONYX));
    assert_eq!(s.touches(acc(ONYX)).moves, U64(3));
}

/// Paid to the winner or refunded to the team, the round still has its deadline: until then the sealed masks have
/// their turns on what is left in the safe, so the safe stays, to the last nanosecond. From the deadline on it
/// goes, and all it holds goes to the team.
fn a_settled_round_lets_the_safe_go_only_from_its_deadline_on(settled: &str) {
    let mut s = won();
    let before = state(&s);
    for early in [OPENS + 2 * S, DEADLINE - 1] {
        as_at(SAFE, early);
        assert_eq!(panics(|| drop(s.on_retire(ARMED, bounty_is(settled)))), BEFORE_DEADLINE, "{early}");
        assert!(receipts().is_empty() && events().is_empty(), "{early}: nothing left the safe");
    }
    assert_eq!(state(&s), before, "a refusal changes nothing in the safe");
    as_at(SAFE, DEADLINE);
    drop(s.on_retire(ARMED, bounty_is(settled)));
    assert!(gone_to_the_team(), "{}", receipts());
    let e = events();
    assert_eq!((e.len(), e[0]["event"].as_str()), (1, Some("retired")));
    let five = NearToken::from_near(5).as_yoctonear().to_string();
    assert_eq!(e[0]["data"], serde_json::json!({ "bounty": "race-0004", "to": TEAM, "amount": five }));
}

#[test]
fn a_drained_round_lets_the_safe_go_only_from_its_deadline_on() {
    a_settled_round_lets_the_safe_go_only_from_its_deadline_on("drained");
}

#[test]
fn a_paid_round_lets_the_safe_go_only_from_its_deadline_on() {
    a_settled_round_lets_the_safe_go_only_from_its_deadline_on("paid");
}

#[test]
fn a_refunded_round_lets_the_safe_go_only_from_its_deadline_on() {
    // The bounty contract refunds a round only 12 hours after its deadline, so this deadline has always passed;
    // the safe checks it all the same and keeps one rule for every way a round ends.
    a_settled_round_lets_the_safe_go_only_from_its_deadline_on("refunded");
}

#[test]
fn the_safe_goes_once_however_often_the_team_asks() {
    let mut s = won();
    // The team asks twice before the first answer is back: both questions go out, and nothing has changed yet.
    for _ in 0..2 {
        as_at(TEAM, DEADLINE);
        drop(s.retire());
        assert!(receipts().contains("call on_retire(") && !receipts().contains("DeleteAccount"));
    }
    // The first answer lets the safe go. The second finds it going: it sends no second deletion, which could
    // reach a new safe made under the same name.
    as_at(SAFE, DEADLINE);
    drop(s.on_retire(ARMED, bounty_is("drained")));
    assert!(gone_to_the_team(), "{}", receipts());
    as_at(SAFE, DEADLINE);
    assert_eq!(panics(|| drop(s.on_retire(ARMED, bounty_is("drained")))), RETIRING);
    assert!(receipts().is_empty() && events().is_empty());
    // Asked once more, the safe only asks the bounty contract again; that answer is refused the same way.
    as_at(TEAM, DEADLINE);
    drop(s.retire());
    assert!(!receipts().contains("DeleteAccount"), "{}", receipts());
    as_at(SAFE, DEADLINE);
    assert_eq!(panics(|| drop(s.on_retire(ARMED, bounty_is("drained")))), RETIRING);
}

#[test]
fn an_answer_on_its_way_to_an_earlier_safe_of_the_same_name_moves_nothing_in_a_new_one() {
    // The safe is made again under the same name for the next round. An answer the bounty contract gave the old
    // safe about the old round, settled long ago, may reach the new one. It must not retire the new safe in the
    // middle of its own round, nor send its NEAR to the team. The old safe was armed at another moment: a block
    // earlier at the latest, and no two blocks share a time.
    let mut s = armed();
    let before = state(&s);
    as_at(SAFE, DEADLINE + CLAIM_GRACE_NS);
    for old in [ARMED - 1, ARMED - 9 * S, 0, ARMED + 1] {
        for settled in ["drained", "refunded"] {
            assert_eq!(panics(|| drop(s.on_retire(old, bounty_is(settled)))), ANOTHER_ROUND, "{old}");
            assert_eq!(panics(|| drop(s.on_bounty(old, bounty_is(settled)))), ANOTHER_ROUND, "{old}");
        }
    }
    assert!(receipts().is_empty() && events().is_empty(), "nothing left the safe");
    assert_eq!(state(&s), before);
    // A new safe that has not taken its round yet: no answer is about it.
    let mut f = fresh(&[NOVA, ONYX]);
    as_at(SAFE, DEADLINE + CLAIM_GRACE_NS);
    assert_eq!(panics(|| drop(f.on_retire(ARMED, bounty_is("drained")))), "the safe took no round");
    assert_eq!(panics(|| drop(f.on_bounty(ARMED, bounty_is("refunded")))), "the safe took no round");
    assert!(receipts().is_empty());
}

/// The state of a safe from before `retire` (1.4.0), field for field.
#[near(serializers = [borsh])]
struct SafeBeforeRetire {
    owner: AccountId,
    masks: Vec<AccountId>,
    moves: u64,
    last_ns: Option<u64>,
    first: LookupMap<AccountId, u64>,
    home: AccountId,
    arbiter: Option<AccountId>,
    team: Option<AccountId>,
    round: Option<Round>,
    turn: Option<Turn>,
    turns: u64,
    seals: [u32; MAX_MASKS],
}

#[test]
fn retiring_adds_one_byte_after_the_state_the_round_reads() {
    // Everything the round's path reads lies where it lay: the new flag is one byte after it, there from `new` on.
    let mut s = won();
    // What the masks' first moves wrote goes to storage, as at the end of a call on chain.
    s.first.flush();
    let bytes = state(&s);
    // Since 1.7.0 the safe's kind and its desks follow the flag, 35 bytes that are there from `new` on too.
    let (bytes, desks) = bytes.split_at(bytes.len() - 35);
    assert_eq!(desks, [vec![0u8], vec![0u8; 34]].concat(), "the owner kind, and nothing at its desks");
    let (was, flag) = bytes.split_at(bytes.len() - 1);
    assert_eq!(flag, [0], "not retiring");
    let old: SafeBeforeRetire = near_sdk::borsh::from_slice(was).unwrap();
    assert_eq!(near_sdk::borsh::to_vec(&old).unwrap(), was);
    assert_eq!((&old.owner, &old.masks, &old.home), (&s.owner, &s.masks, &s.home));
    assert_eq!((old.moves, old.last_ns, old.turns, old.seals), (s.moves, s.last_ns, s.turns, s.seals));
    assert_eq!((&old.arbiter, &old.team, &old.round, &old.turn), (&s.arbiter, &s.team, &s.round, &s.turn));
    assert_eq!(old.first.get(&acc(NOVA)), Some(&OPENS));
    // Retiring flips that byte and nothing else: the safe stores no more than before, so a safe whose every free
    // yoctoNEAR the team has taken back (`reclaim`) still retires.
    as_at(SAFE, DEADLINE);
    drop(s.on_retire(ARMED, bounty_is("drained")));
    assert_eq!(state(&s), [was, &[1], desks].concat());
}
