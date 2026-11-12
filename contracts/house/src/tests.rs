//! The rules, natively. The contract itself runs on a real node in contracts/challenges/runner/tests/house.rs.

use crate::json::{self, Value};
use crate::rules::*;

const HOUSE: &str = "house.maskwars.near";
const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const MILLI: u128 = NEAR / 1000;
/// 12.11.2026 18:00 UTC: a slot of mainnet's schedule.
const SLOT: u64 = 1_794_506_400_000_000_000;
const MINUTE: u64 = NS_PER_MINUTE;

/// The terms of mainnet today (packages/network/mainnet.json, `round` and `limits.hand`).
fn mainnet() -> Config {
    Config {
        bounty: "bounty.maskwars.near".into(),
        vault: "vault.house.maskwars.near".into(),
        safe_code: "GBcgJ4RABNHWXb86XHK6aFeEk6qMtSNFhS3ka8NyK7jV".into(),
        masks: vec!["nova.maskwars.near".into(), "onyx.maskwars.near".into(), "oracle.maskwars.near".into()],
        judge_version: "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7".into(),
        safe: 1930 * MILLI,
        deposit: 250 * MILLI,
        min_loot: 100 * MILLI,
        gas: 100 * MILLI,
        hours: 4,
        commit_minutes: 45,
        reveal_minutes: 60,
        first_minute: 1080,
        every_minutes: 1440,
        safe_max: 2500 * MILLI,
        deposit_max: 1100 * MILLI,
    }
}

/// The `new` arguments the owner sends on mainnet (contracts/house/README.md).
const MAINNET_ARGS: &str = r#"{
  "bounty": "bounty.maskwars.near",
  "vault": "vault.house.maskwars.near",
  "safe_code": "GBcgJ4RABNHWXb86XHK6aFeEk6qMtSNFhS3ka8NyK7jV",
  "masks": ["nova.maskwars.near", "onyx.maskwars.near", "oracle.maskwars.near"],
  "judge_version": "1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7",
  "safe": "1930000000000000000000000",
  "deposit": "250000000000000000000000",
  "min_loot": "100000000000000000000000",
  "gas": "100000000000000000000000",
  "hours": 4,
  "commit_minutes": 45,
  "reveal_minutes": 60,
  "first_minute": 1080,
  "every_minutes": 1440,
  "safe_max": "2500000000000000000000000",
  "deposit_max": "1100000000000000000000000",
  "last_round": 2
}"#;

#[test]
fn the_owners_arguments_read_as_mainnets_terms() {
    let o = json::parse(MAINNET_ARGS.as_bytes()).unwrap();
    let c = Config::read(&o, HOUSE, &["last_round"]).unwrap();
    assert_eq!(c, mainnet());
    assert_eq!(o.u32("last_round"), Ok(2));
    // Without `last_round` among the known fields, the same arguments are refused: no field is ever ignored.
    assert_eq!(Config::read(&o, HOUSE, &[]), Err("arguments: a field the house does not know"));
}

#[test]
fn the_terms_as_kept_read_back_the_same() {
    let c = mainnet();
    let kept = c.to_json();
    let back = Config::read(&json::parse(kept.as_bytes()).unwrap(), HOUSE, &[]).unwrap();
    assert_eq!(back, c);
}

/// `new` on the vault, byte for byte as house.ts `vaultInit` sends it (`JSON.stringify`, keys in its order).
#[test]
fn the_vaults_new_is_house_ts_own() {
    assert_eq!(
        mainnet().vault_init(HOUSE),
        r#"{"owner":"vault.house.maskwars.near","masks":["nova.maskwars.near","onyx.maskwars.near","oracle.maskwars.near"],"arbiter":"bounty.maskwars.near","team":"house.maskwars.near"}"#
    );
}

/// `open_safe`, byte for byte as house.ts `roundArgs` sends it: `min_loot` a string, the minutes numbers.
#[test]
fn the_rounds_open_safe_is_house_ts_own() {
    assert_eq!(
        mainnet().round_args("race-0003"),
        concat!(
            r#"{"id":"race-0003","safe":"vault.house.maskwars.near","masks":["nova.maskwars.near","onyx.maskwars.near","oracle.maskwars.near"],"#,
            r#""min_loot":"100000000000000000000000","hours":4,"commit_minutes":45,"reveal_minutes":60,"#,
            r#""safe_code":"GBcgJ4RABNHWXb86XHK6aFeEk6qMtSNFhS3ka8NyK7jV","judge_version":"1f8e1aca123fa63b5b54447e9c722ea78f73322a53efe0ed15a5528b827f86f7"}"#
        )
    );
}

/// `unstick`, `settle` and `refund` as house.ts sends them: `{ id, claim: String(claim) }` and `{ id }`.
#[test]
fn the_passed_on_calls_are_house_ts_own() {
    assert_eq!(unstick_args("race-0003", 17), r#"{"id":"race-0003","claim":"17"}"#);
    assert_eq!(id_args("race-0003"), r#"{"id":"race-0003"}"#);
}

#[test]
fn json_reads_flat_objects_of_strings_numbers_and_lists() {
    let o = json::parse(
        br#" { "a" : "x" , "n":0, "big": 340282366920938463463374607431768211455, "l": [ "p","q" ], "e": [] } "#,
    )
    .unwrap();
    assert_eq!(o.get("a"), Some(&Value::Str("x")));
    assert_eq!(o.u128("n"), Ok(0));
    assert_eq!(o.u128("big"), Ok(u128::MAX));
    assert_eq!(o.list("l"), Ok(&["p", "q"][..]));
    assert_eq!(o.list("e"), Ok(&[][..]));
    assert_eq!(json::parse(b"").unwrap().fields.len(), 0, "no arguments read as {{}}");
    assert_eq!(json::parse(b"{}").unwrap().fields.len(), 0);
    // A number may come as a string of digits, as near-sdk writes U64 and U128.
    let o = json::parse(br#"{"claim":"17"}"#).unwrap();
    assert_eq!(o.u64("claim"), Ok(17));
}

#[test]
fn json_refuses_anything_else() {
    for bad in [
        &br#"{"a":"x\"y"}"#[..],
        // A backslash escape, byte by byte.
        &[b'{', b'"', b'a', b'"', b':', b'"', 92, b'u', b'0', b'0', b'4', b'1', b'"', b'}'][..],
        br#"{"a":{"b":"c"}}"#,
        br#"{"a":01}"#,
        br#"{"a":-1}"#,
        br#"{"a":1.5}"#,
        br#"{"a":true}"#,
        br#"{"a":null}"#,
        br#"{"a":"x"} {"#,
        br#"{"a":"x","a":"y"}"#,
        br#"{"a":"x",}"#,
        br#"{"a":["x",1]}"#,
        br#"{"a":"x""#,
        "{\"a\":\"\u{e9}\"}".as_bytes(),
        b"{\"a\":\"tab\there\"}",
        br#"["a"]"#,
    ] {
        assert!(json::parse(bad).is_err(), "{}", String::from_utf8_lossy(bad));
    }
    let o = json::parse(br#"{"n":"1x","big":"340282366920938463463374607431768211456","s":5}"#).unwrap();
    assert!(o.u128("n").is_err());
    assert!(o.u128("big").is_err(), "u128 overflow");
    assert!(o.str("s").is_err());
    assert!(o.u32("missing").is_err());
    let o = json::parse(br#"{"n":4294967296}"#).unwrap();
    assert!(o.u32("n").is_err());
}

#[test]
fn numbers_write_in_decimal() {
    assert_eq!(json::decimal(0), "0");
    assert_eq!(json::decimal(1930 * MILLI), "1930000000000000000000000");
    assert_eq!(json::decimal(u128::MAX), "340282366920938463463374607431768211455");
}

/// One change to the terms.
type Change = Box<dyn Fn(&mut Config)>;

#[test]
fn every_bad_term_is_refused() {
    let cases: Vec<(Change, &str)> = vec![
        (Box::new(|c| c.vault = "vault.maskwars.near".into()), "the vault is a direct sub-account of the house"),
        (
            Box::new(|c| c.vault = "a.vault.house.maskwars.near".into()),
            "the vault is a direct sub-account of the house",
        ),
        (Box::new(|c| c.vault = "xhouse.maskwars.near".into()), "the vault is a direct sub-account of the house"),
        (Box::new(|c| c.vault = "Vault.house.maskwars.near".into()), "an account id is not a NEAR account id"),
        (Box::new(|c| c.bounty = HOUSE.into()), "the bounty contract is another account"),
        (Box::new(|c| c.bounty = c.vault.clone()), "the bounty contract is another account"),
        (Box::new(|c| c.masks.clear()), "1 to 16 masks"),
        (Box::new(|c| c.masks = (0..17).map(|i| format!("m{i}.near")).collect()), "1 to 16 masks"),
        (Box::new(|c| c.masks.push("nova.maskwars.near".into())), "each mask once"),
        (Box::new(|c| c.masks.push(HOUSE.into())), "a mask is none of the house, the vault and the bounty contract"),
        (
            Box::new(|c| c.masks.push("bounty.maskwars.near".into())),
            "a mask is none of the house, the vault and the bounty contract",
        ),
        (Box::new(|c| c.masks.push("bad..name".into())), "an account id is not a NEAR account id"),
        (Box::new(|c| c.safe_code = "0Bcg".into()), "safe_code: a code hash in base58"),
        (
            Box::new(|c| c.safe_code = "OBcgJ4RABNHWXb86XHK6aFeEk6qMtSNFhS3ka8NyK7jV".into()),
            "safe_code: a code hash in base58",
        ),
        (Box::new(|c| c.judge_version = "1F8E".into()), "judge_version: a sha256 in lowercase hex"),
        (Box::new(|c| c.judge_version.replace_range(0..1, "g")), "judge_version: a sha256 in lowercase hex"),
        (Box::new(|c| c.safe = 0), "safe: more than 0 and at most safe_max"),
        (Box::new(|c| c.safe = c.safe_max + 1), "safe: more than 0 and at most safe_max"),
        (Box::new(|c| c.deposit = 0), "deposit: more than 0 and at most deposit_max"),
        (Box::new(|c| c.deposit = c.deposit_max + 1), "deposit: more than 0 and at most deposit_max"),
        (Box::new(|c| c.min_loot = MIN_LOOT - 1), "min_loot: at least 0.1 NEAR and less than the vault holds"),
        (Box::new(|c| c.min_loot = c.safe), "min_loot: at least 0.1 NEAR and less than the vault holds"),
        (Box::new(|c| c.hours = 0), "hours: 1 to 24"),
        (Box::new(|c| c.hours = 25), "hours: 1 to 24"),
        (Box::new(|c| c.commit_minutes = 0), "commit_minutes: at least 1 and less than the round"),
        (Box::new(|c| c.commit_minutes = 240), "commit_minutes: at least 1 and less than the round"),
        (
            Box::new(|c| c.reveal_minutes = 11),
            "reveal_minutes: 3 for each mask's turn and 3 more, and both windows within the round",
        ),
        (
            Box::new(|c| c.reveal_minutes = 196),
            "reveal_minutes: 3 for each mask's turn and 3 more, and both windows within the round",
        ),
        (Box::new(|c| c.every_minutes = 0), "every_minutes: a round and its claim grace end before the next slot"),
        (Box::new(|c| c.every_minutes = 960), "every_minutes: a round and its claim grace end before the next slot"),
        (Box::new(|c| c.first_minute = u64::MAX), "first_minute: minutes since the Unix epoch"),
    ];
    for (change, why) in cases {
        let mut c = mainnet();
        change(&mut c);
        assert_eq!(c.check(HOUSE), Err(why), "{c:?}");
    }
    let mut c = mainnet();
    c.reveal_minutes = 12;
    c.every_minutes = 961;
    assert_eq!(c.check(HOUSE), Ok(()), "the tightest terms that still close the circle");
}

#[test]
fn slots_fall_as_packages_network_says() {
    // first_minute 1080, every 1440: 18:00 UTC each day.
    assert_eq!(slot_at(1080, 1440, 1079 * MINUTE), None);
    assert_eq!(slot_at(1080, 1440, 1080 * MINUTE), Some(1080 * MINUTE));
    assert_eq!(slot_at(1080, 1440, SLOT - 1), Some(SLOT - 1440 * MINUTE));
    assert_eq!(slot_at(1080, 1440, SLOT), Some(SLOT));
    assert_eq!(slot_at(1080, 1440, SLOT + 1439 * MINUTE), Some(SLOT));
    assert_eq!(slot_at(1080, 1440, SLOT + 1440 * MINUTE), Some(SLOT + 1440 * MINUTE));
}

#[test]
fn a_round_opens_once_a_slot_within_its_window() {
    let c = mainnet();
    let day = Day { last_round: 2, last_slot_ns: SLOT - 1440 * MINUTE, made_slot_ns: SLOT };
    // The window: from 18:00 until a 4-hour round and its 12-hour claim grace end by the next 18:00, i.e. 02:00.
    let w = c.window(SLOT + 5 * MINUTE);
    assert_eq!(w, Window { slot: Some(SLOT), next: SLOT + 1440 * MINUTE, open_until: Some(SLOT + 480 * MINUTE) });
    assert_eq!(c.may_open(&day, "race-0003", SLOT), Ok((3, SLOT)));
    assert_eq!(c.may_open(&day, "race-0003", SLOT + 480 * MINUTE), Ok((3, SLOT)));
    assert_eq!(
        c.may_open(&day, "race-0003", SLOT + 480 * MINUTE + 1),
        Err("too late in the slot: the round would run into the next one")
    );
    assert_eq!(
        c.may_open(&day, "race-0003", SLOT - 1),
        Err("this slot has its round"),
        "yesterday's slot had its round"
    );
    // Once opened in this slot, no second round in it, whatever the id; the next slot takes the next one, on a vault
    // made in it.
    let opened = Day { last_round: 3, last_slot_ns: SLOT, made_slot_ns: SLOT };
    assert_eq!(c.may_open(&opened, "race-0004", SLOT + MINUTE), Err("this slot has its round"));
    let next = Day { made_slot_ns: SLOT + 1440 * MINUTE, ..opened };
    assert_eq!(c.may_open(&next, "race-0004", SLOT + 1440 * MINUTE), Ok((4, SLOT + 1440 * MINUTE)));
    // Before the very first slot.
    let fresh = Day { last_round: 0, last_slot_ns: 0, made_slot_ns: 0 };
    assert_eq!(c.may_open(&fresh, "race-0001", 1079 * MINUTE), Err("no slot has come yet"));
}

/// The bounty contract takes the deposit for a vault that will not arm and only gives it back later, in `on_armed`:
/// the house's `on_opened` hears "opened", and the slot would be gone. So a round opens only on a vault `make_vault`
/// made in this very slot: never on yesterday's vault, still armed for its round, nor on none at all.
#[test]
fn a_round_opens_only_on_a_vault_made_in_its_slot() {
    let c = mainnet();
    let no_vault = "no vault made in this slot: make_vault first";
    // Yesterday's vault stands, armed: the day's first step at 18:00:01 cannot be `open_round`.
    let yesterday = Day { last_round: 2, last_slot_ns: SLOT - 1440 * MINUTE, made_slot_ns: SLOT - 1440 * MINUTE };
    assert_eq!(c.may_open(&yesterday, "race-0003", SLOT + 1_000_000_000), Err(no_vault));
    // Retired (or never made), and while `make_vault` waits for its answer.
    for made in [0, MAKING] {
        let d = Day { made_slot_ns: made, ..yesterday };
        assert_eq!(c.may_open(&d, "race-0003", SLOT + MINUTE), Err(no_vault), "{made}");
    }
    // Made in this slot: it opens.
    let made = Day { made_slot_ns: SLOT, ..yesterday };
    assert_eq!(c.may_open(&made, "race-0003", SLOT + MINUTE), Ok((3, SLOT)));
    // A vault made before a slot whose window has passed counts for nothing in the next one.
    assert_eq!(c.may_open(&made, "race-0003", SLOT + 1440 * MINUTE), Err(no_vault));
    // What `make_vault` hands its answer: the slot it counts for, and what stood before.
    let args = made_args(&c, SLOT + 5 * MINUTE, SLOT - 1440 * MINUTE);
    assert_eq!(read_made(&json::parse(args.as_bytes()).unwrap()), Ok((SLOT, SLOT - 1440 * MINUTE)));
    let early = made_args(&c, 1079 * MINUTE, 0);
    assert_eq!(read_made(&json::parse(early.as_bytes()).unwrap()), Ok((0, 0)), "before the first slot: no slot");
    assert!(read_made(&json::parse(br#"{"slot_ns":"1","before_ns":"0","x":"y"}"#).unwrap()).is_err());
}

#[test]
fn home_reaches_the_rounds_masks_alone() {
    let c = mainnet();
    let mask = |args: &str| home_mask(&c, &json::parse(args.as_bytes()).unwrap()).map(String::from);
    assert_eq!(mask(r#"{"mask":"oracle.maskwars.near"}"#), Ok("oracle.maskwars.near".into()));
    for (args, why) in [
        (r#"{"mask":"house.maskwars.near"}"#, "home: only one of the round's masks"),
        (r#"{"mask":"bounty.maskwars.near"}"#, "home: only one of the round's masks"),
        (r#"{"mask":"vault.house.maskwars.near"}"#, "home: only one of the round's masks"),
        (r#"{"mask":"oracle.maskwars.nea"}"#, "home: only one of the round's masks"),
        (r#"{"mask":"oracle.maskwars.near","to":"x.near"}"#, "arguments: a field the house does not know"),
    ] {
        assert_eq!(mask(args), Err(why), "{args}");
    }
    assert!(mask("{}").is_err());
    assert_eq!(HOME_ARGS, b"{}");
    assert_eq!(HOME_GAS, 10 * TGAS, "home() burns about 2 TGas: it gets exactly 10, as house.ts gives it");
}

#[test]
fn a_rounds_id_comes_after_the_last() {
    let c = mainnet();
    let day = Day { last_round: 2, last_slot_ns: 0, made_slot_ns: SLOT };
    for (id, why) in [
        ("race-0002", "the round's number must come after the last round's"),
        ("race-0001", "the round's number must come after the last round's"),
        ("race-0103", "the round's number runs too far ahead of the last round's"),
        ("race-3", "the round's id is race-<n>"),
        ("race-00003a", "the round's id is race-<n>"),
        ("race-1234567890", "the round's id is race-<n>"),
        ("round-0003", "the round's id is race-<n>"),
        ("race--003", "the round's id is race-<n>"),
        ("", "the round's id is race-<n>"),
    ] {
        assert_eq!(c.may_open(&day, id, SLOT), Err(why), "{id}");
    }
    assert_eq!(c.may_open(&day, "race-0102", SLOT), Ok((102, SLOT)));
    assert_eq!(c.may_open(&day, "race-00005", SLOT), Ok((5, SLOT)));
    assert_eq!(round_no("race-999999999"), Some(999_999_999));
    assert_eq!((round_id(3), round_id(12345)), ("race-0003".to_string(), "race-12345".to_string()));
}

#[test]
fn code_hashes_read_as_near_shows_them() {
    // sha256 of "" and of "maskwars house", base58 (checked with Python), and the edge of leading zeros.
    let empty = hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    assert_eq!(base58(&empty), "GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn");
    let ours = hex("d3f5693cab2e39062732b703c34429127dd6a7a2758df012dd1c242adafd25e2");
    assert_eq!(base58(&ours), "FGQ4tVsFYrHLBNnw7o7bgwrTJqiF5QM7dzv9GBSu369o");
    assert_eq!(base58(&[0u8; 32]), "11111111111111111111111111111111");
    let mut edge = [255u8; 32];
    edge[..2].copy_from_slice(&[0, 0]);
    edge[2] = 1;
    assert_eq!(base58(&edge), "11QF7N3ErceFxTPNH9CGKqHisFCRSeGDL8Bb4wTGTp");
}

#[test]
fn the_day_keeps_in_twenty_bytes() {
    let d = Day { last_round: 7, last_slot_ns: SLOT, made_slot_ns: SLOT + 1 };
    assert_eq!(Day::from_bytes(&d.to_bytes()), Some(d));
    assert_eq!(Day::from_bytes(&[0; 12]), None);
    assert_eq!(Day::from_bytes(&[0; 19]), None);
    let back = Day::read(&json::parse(d.to_json().as_bytes()).unwrap()).unwrap();
    assert_eq!(back, d);
    assert_eq!(
        d.to_json(),
        r#"{"last_round":7,"last_slot_ns":"1794506400000000000","made_slot_ns":"1794506400000000001"}"#
    );
    let making = Day { made_slot_ns: MAKING, ..d };
    assert_eq!(Day::from_bytes(&making.to_bytes()), Some(making));
}

#[test]
fn account_ids_are_nears() {
    for ok in ["house.maskwars.near", "a1", "vault.house.maskwars.near", "x_y-z.near", &"a".repeat(64)] {
        assert!(is_account(ok), "{ok}");
    }
    for bad in ["a", "", "A.near", "a..near", ".near", "near.", "a-.near", "a b", "a\"b", &"a".repeat(65)] {
        assert!(!is_account(bad), "{bad}");
    }
}

#[test]
fn now_says_where_the_schedule_stands() {
    let c = mainnet();
    let day = Day { last_round: 2, last_slot_ns: SLOT - 1440 * MINUTE, made_slot_ns: SLOT };
    let at = SLOT + 10 * MINUTE;
    assert_eq!(
        now_json(&c, day, at, 2280 * MILLI),
        format!(
            r#"{{"now_ns":"{at}","slot_ns":"{SLOT}","next_slot_ns":"{}","open_until_ns":"{}","opened":false,"vault_made":true,"may_open":true,"last_round":2,"next_round":"race-0003","free":"2280000000000000000000000"}}"#,
            SLOT + 1440 * MINUTE,
            SLOT + 480 * MINUTE
        )
    );
    let late = now_json(&c, day, SLOT + 481 * MINUTE, 0);
    assert!(late.contains(r#""may_open":false"#), "{late}");
    let unmade = now_json(&c, Day { made_slot_ns: SLOT - 1440 * MINUTE, ..day }, at, 0);
    assert!(unmade.contains(r#""vault_made":false,"may_open":false"#), "{unmade}");
    let before = now_json(&c, Day::default(), 10, 0);
    assert!(before.contains(r#""slot_ns":null"#) && before.contains(r#""open_until_ns":null"#), "{before}");
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

#[test]
fn the_code_says_where_its_source_is() {
    // NEP-330 as near-sdk writes it: a plain build (build.sh) names its version and the public repository and has no
    // build_info; the build in cargo-near's pinned image adds it (contracts/README.md).
    assert_eq!(VERSION, env!("CARGO_PKG_VERSION"));
    let head =
        format!(r#"{{"version":"{}","link":"https://github.com/plavutskyi/mask-wars"#, env!("CARGO_PKG_VERSION"));
    assert!(SOURCE_METADATA.starts_with(&head), "{SOURCE_METADATA}");
    assert!(SOURCE_METADATA.contains(r#"","standards":[{"standard":"nep330","version":"1.3.0"}],"build_info":"#));
    match option_env!("NEP330_BUILD_INFO_BUILD_ENVIRONMENT") {
        None => assert!(SOURCE_METADATA.ends_with(r#","build_info":null}"#), "{SOURCE_METADATA}"),
        Some(image) => {
            assert!(SOURCE_METADATA.contains(&format!(r#""build_environment":"{image}""#)), "{SOURCE_METADATA}")
        }
    }
}

#[test]
fn the_contracts_without_the_sdk_macros_write_their_source_metadata_with_one_build_script() {
    // The house, home and the mask's code (contracts/masks/mask) have no `#[near]` struct for near-sdk to write it.
    assert_eq!(include_str!("../build.rs"), include_str!("../../home/build.rs"));
    assert_eq!(include_str!("../build.rs"), include_str!("../../masks/mask/build.rs"));
}
