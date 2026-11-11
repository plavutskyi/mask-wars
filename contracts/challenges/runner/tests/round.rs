//! A sealed round in a real local sandbox: the bounty contract, the live safe and the judge are the real code, the
//! masks follow scripts. Seal → window closes → play → reveal → claim → payout. A peeked plan never wins; nobody
//! empties the safe in the commit window, because the safe is locked to the round; only the masks that sealed a plan
//! move the safe after the window, one turn each in the order of the seals, so no plan is spoiled; a round someone
//! outside the team opens on the safe does not take it; a sweep sealed for all the safe holds still pays after the
//! turns before it; and a junk claim with the judge holds no payout.

use race_runner::build_targets;
use race_runner::round::{run_round, Board, MaskScript, Play, Scenario, SWEEP_MARGIN};
use std::sync::Once;

fn built() {
    static BUILD: Once = Once::new();
    BUILD.call_once(|| build_targets().expect("build wasm"));
}

fn steps<'a>(b: &'a Board, mask: &str) -> Vec<(&'a str, bool, &'a str)> {
    b.events.iter().filter(|e| e.mask == mask).map(|e| (e.step.as_str(), e.ok, e.note.as_str())).collect()
}

fn ok(b: &Board, mask: &str, step: &str) -> bool {
    b.events.iter().any(|e| e.mask == mask && e.step == step && e.ok)
}

#[tokio::test]
async fn the_finder_wins_and_no_copycat_does() {
    built();
    let b = run_round(&Scenario::standard()).await.unwrap();
    println!("{}", serde_json::to_string_pretty(&b.events).unwrap());

    // NOVA sealed its plan in the window, played it on the untouched safe, revealed it and was paid.
    assert_eq!(b.winner.as_deref(), Some("nova"), "{:#?}", b.events);
    assert_eq!(b.status["status"]["state"], "drained");
    for step in ["seal", "play set_owner", "play sweep", "reveal", "claim", "paid"] {
        assert!(ok(&b, "nova", step), "nova {step}: {:?}", steps(&b, "nova"));
    }

    // ONYX sealed first, a bare sweep. It borrowed the hole with a set_owner of its own, outside its sealed plan,
    // and took loot from the safe in its turn; but the plan it played is not the one it sealed, and the one it sealed
    // did not start its turn.
    let onyx = steps(&b, "onyx");
    assert!(onyx.contains(&("seal", true, onyx[0].2)) && onyx[0].2.starts_with("seal #0"), "{onyx:?}");
    assert!(ok(&b, "onyx", "play sweep"), "{onyx:?}");
    assert!(
        onyx.iter().any(|(s, ok, n)| *s == "reveal" && !ok && n.contains("the plan does not match the seal")),
        "{onyx:?}"
    );
    assert!(
        onyx.iter().any(|(s, ok, n)| *s == "claim"
            && !ok
            && n.contains("the plan did not start the mask's own turn on the safe")),
        "{onyx:?}"
    );

    // JINX sabotaged: it tried to empty the safe in the commit window, which without the lock left nothing to win,
    // and left a junk claim with the judge while the others claimed. The safe refused it, and the round paid NOVA.
    let jinx = steps(&b, "jinx");
    assert!(jinx[0].2.starts_with("seal #1"), "{jinx:?}");
    for step in ["play set_owner", "play sweep"] {
        assert!(
            jinx.iter()
                .any(|(s, ok, n)| *s == step && !ok && n.contains("the safe is locked until the commit window closes")),
            "jinx {step}: {jinx:?}"
        );
    }
    let at = |mask: &str, step: &str| b.events.iter().position(|e| e.mask == mask && e.step == step);
    let (asked, confirmed, refused) = (at("jinx", "asked"), at("nova", "claim"), at("jinx", "claim"));
    assert!(asked < confirmed && confirmed < refused, "the junk claim was with the judge all along: {:#?}", b.events);
    assert!(
        jinx.iter().any(|(s, ok, n)| *s == "claim" && !ok && n.contains("the drain happened outside the race")),
        "{jinx:?}"
    );

    // ORACLE copied NOVA's plan off the chain: too late to seal, so the safe does not even let it in, and it has
    // nothing to reveal or claim.
    let oracle = steps(&b, "oracle");
    for step in ["play set_owner", "play sweep"] {
        assert!(
            oracle
                .iter()
                .any(|(s, ok, n)| *s == step && !ok && n.contains("only a mask that sealed a plan moves the safe")),
            "oracle {step}: {oracle:?}"
        );
    }
    assert!(
        oracle.iter().any(|(s, ok, n)| *s == "reveal" && !ok && n.contains("this mask sealed no plan")),
        "{oracle:?}"
    );
    assert!(oracle.iter().any(|(s, ok, _)| *s == "claim" && !ok), "{oracle:?}");

    // VOLT found the hole after the window.
    assert!(steps(&b, "volt")
        .iter()
        .any(|(s, ok, n)| *s == "seal" && !ok && n.contains("the commit window is closed")));

    // The round as anyone sees it: three seals, every plan public once revealed, no claim left with the judge.
    let seals = b.round["seals"].as_array().unwrap();
    assert_eq!(seals.len(), 3);
    assert_eq!(
        seals.iter().map(|s| s["state"].as_str().unwrap()).collect::<Vec<_>>(),
        ["refused", "refused", "confirmed"]
    );
    assert!(seals.iter().all(|s| s["plan"].is_string()));
    assert_eq!(b.round["judging"], serde_json::json!([]));
}

#[tokio::test]
async fn of_two_finders_the_earlier_seal_wins_and_neither_spoils_the_others_plan() {
    built();
    let scenario = Scenario {
        masks: vec![
            MaskScript { name: "nova".into(), play: Play::Finder },
            MaskScript { name: "wraith".into(), play: Play::Finder },
        ],
        ..Scenario::standard()
    };
    let b = run_round(&scenario).await.unwrap();
    assert_eq!(b.winner.as_deref(), Some("nova"), "{:#?}", b.events);
    let wraith = steps(&b, "wraith");
    assert!(ok(&b, "wraith", "play set_owner") && ok(&b, "wraith", "reveal"), "{wraith:?}");
    // WRAITH played its whole plan in a turn of its own, after NOVA's; it took loot, but NOVA sealed first and is
    // paid before WRAITH is even judged.
    assert!(ok(&b, "wraith", "play sweep"), "{wraith:?}");
    assert!(wraith.iter().any(|(s, ok, _)| *s == "claim" && !ok), "{wraith:?}");
}

#[tokio::test]
async fn a_mask_that_sealed_nothing_cannot_move_the_safe_ahead_of_the_sealed_plans() {
    // H1 and review finding 3. HEX sealed nothing: the moment the window closes it tries to move the safe first, to
    // take the loot ahead of every sealed plan or just to spoil one. The safe lets in only the masks that sealed.
    built();
    let scenario = Scenario {
        masks: vec![
            MaskScript { name: "hex".into(), play: Play::Squatter },
            MaskScript { name: "nova".into(), play: Play::Finder },
        ],
        ..Scenario::standard()
    };
    let b = run_round(&scenario).await.unwrap();
    println!("{}", serde_json::to_string_pretty(&b.events).unwrap());
    assert_eq!(b.winner.as_deref(), Some("nova"), "{:#?}", b.events);
    assert_eq!(b.status["status"]["state"], "drained");
    let hex = steps(&b, "hex");
    assert!(
        hex.iter().any(|(s, ok, n)| *s == "play set_owner" && !ok && n.contains("only a mask that sealed a plan")),
        "{hex:?}"
    );
    // NOVA played at once: nobody held the safe.
    let nova = steps(&b, "nova");
    assert!(nova.iter().all(|(s, ok, _)| !s.starts_with("play") || *ok), "{nova:?}");
}

#[tokio::test]
async fn the_earlier_seal_plays_first_and_a_later_seal_waits_its_slot() {
    // Review finding 3. WRAITH sealed after NOVA and plays first the moment the window closes: under first come,
    // first served it took the loot and NOVA's sealed sweep had nothing left. Now WRAITH waits until NOVA has had
    // its turn; NOVA, the earlier seal, is paid.
    built();
    let scenario = Scenario {
        masks: vec![
            MaskScript { name: "nova".into(), play: Play::Finder },
            MaskScript { name: "wraith".into(), play: Play::Finder },
        ],
        // 5 NEAR: the sandbox deploys the safe's unoptimized wasm (≈199 KB, ≈2 NEAR of storage), and NOVA's sealed sweep
        // of 2 NEAR needs room for it; after NOVA's sweep WRAITH's 2 NEAR are still not there.
        safe_near: 5,
        ..Scenario::standard()
    };
    let b = run_round(&scenario).await.unwrap();
    println!("{}", serde_json::to_string_pretty(&b.events).unwrap());
    assert_eq!(b.winner.as_deref(), Some("nova"), "{:#?}", b.events);
    let first_sweep = b.events.iter().find(|e| e.step == "play sweep" && e.ok).map(|e| e.mask.as_str());
    assert_eq!(first_sweep, Some("nova"), "{:#?}", b.events);
}

#[tokio::test]
async fn a_round_someone_else_opens_on_the_fresh_safe_does_not_take_it() {
    // Review finding 1. Before the team opens its round, an account outside it opens one of its own on the fresh
    // safe, with the same masks, code and judge, all public. Before the fix the safe armed for that round, and the
    // team's round found it taken and was refunded. Now the safe takes only its own team's round.
    built();
    let scenario = Scenario { intruder: true, ..Scenario::standard() };
    let b = run_round(&scenario).await.unwrap();
    println!("{}", serde_json::to_string_pretty(&b.events).unwrap());
    let intruder = steps(&b, "intruder");
    assert!(
        intruder
            .iter()
            .any(|(s, ok, n)| *s == "open" && !ok && n.starts_with("refunded; the safe is locked to no round")),
        "{intruder:?}"
    );
    assert!(ok(&b, "team", "open"), "{:#?}", b.events);
    assert_eq!(b.winner.as_deref(), Some("nova"), "{:#?}", b.events);
}

/// Three masks seal before NOVA a plan that only takes the safe, and play their turns before NOVA's: each turn adds
/// to what the safe stores. NOVA sealed a sweep of all the safe could pay out, less `margin`, on a safe that keeps
/// almost nothing back beyond the 0.01 NEAR step.
fn occupied(margin: u128) -> Scenario {
    let mask = |name: &str, play| MaskScript { name: name.into(), play };
    Scenario {
        masks: vec![
            mask("hex", Play::Occupant),
            mask("jinx", Play::Occupant),
            mask("volt", Play::Occupant),
            mask("nova", Play::Finder),
        ],
        sweep_margin: Some(margin),
        tight_safe: true,
        ..Scenario::standard()
    }
}

#[tokio::test]
async fn a_sweep_sealed_without_a_margin_fails_after_the_turns_before_it() {
    // Review finding 2, as it was: the sweep cut to all the safe could pay out, rounded down to 0.01 NEAR, kept back
    // whatever the rounding left. The turns before NOVA's grew the safe's storage, and the honest sealed sweep failed.
    built();
    let b = run_round(&occupied(0)).await.unwrap();
    println!("{}", serde_json::to_string_pretty(&b.events).unwrap());
    for m in ["hex", "jinx", "volt"] {
        assert!(ok(&b, m, "play set_owner"), "{m}: {:#?}", b.events);
    }
    let nova = steps(&b, "nova");
    assert!(
        nova.iter().any(|(s, ok, n)| *s == "play sweep" && !ok && n.contains("not that much in the safe")),
        "{nova:?}"
    );
    assert!(!ok(&b, "nova", "claim"), "no drain to claim: {nova:?}");
    assert_ne!(seal_state(&b, "nova"), Some("confirmed"));
}

/// Where a mask's seal stands at the end of the round.
fn seal_state<'a>(b: &'a Board, mask: &str) -> Option<&'a str> {
    let prefix = format!("{mask}.");
    let seals = b.round["seals"].as_array()?;
    seals.iter().find(|s| s["mask"].as_str().is_some_and(|m| m.starts_with(&prefix)))?["state"].as_str()
}

#[tokio::test]
async fn a_sweep_sealed_with_the_margin_pays_after_the_turns_before_it() {
    // Review finding 2, fixed: our masks leave 0.03 NEAR for the storage the turns before theirs may add.
    built();
    let b = run_round(&occupied(SWEEP_MARGIN)).await.unwrap();
    println!("{}", serde_json::to_string_pretty(&b.events).unwrap());
    assert!(ok(&b, "nova", "play sweep"), "{:#?}", b.events);
    // The judge confirmed the drain. The earlier seals never revealed, so NOVA is paid by `settle` once the reveal
    // window is over: until then an earlier seal could still win.
    assert!(ok(&b, "nova", "claim"), "{:#?}", b.events);
    assert_eq!(seal_state(&b, "nova"), Some("confirmed"), "{:#?}", b.round);
}
