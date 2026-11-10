// Times as the check writes them: UTC, to the second, `2026-11-08T23:30:45Z`.

/// Milliseconds since the Unix epoch as an ISO time without the fraction.
pub fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// Days since 1970-01-01 as a date of the Gregorian calendar (Howard Hinnant's `civil_from_days`).
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `YYYY-MM-DD` naming a day that exists.
pub fn date_ok(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' || !b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) {
        return false;
    }
    let n = |r: std::ops::Range<usize>| s[r].parse::<i64>().unwrap_or(0);
    let (y, m, d) = (n(0..4), n(5..7), n(8..10));
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let last = match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => 28 + i64::from(leap),
        _ => return false,
    };
    (1..=last).contains(&d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_utc_to_the_second() {
        assert_eq!(iso(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso(1_794_180_645_810), "2026-11-08T23:30:45Z");
        assert_eq!(iso(1_793_984_400_000), "2026-11-06T17:00:00Z");
        assert_eq!(iso(1_709_164_799_999), "2024-02-28T23:59:59Z");
        assert_eq!(iso(1_709_164_800_000), "2024-02-29T00:00:00Z");
        assert_eq!(iso(4_102_444_800_000), "2100-01-01T00:00:00Z");
        assert_eq!(iso(-1), "1969-12-31T23:59:59Z");
    }

    #[test]
    fn knows_a_day_that_exists() {
        assert!(date_ok("2026-11-06") && date_ok("2024-02-29"));
        for bad in ["2026-02-29", "2026-13-01", "2026-00-10", "2026-11-31", "26-11-06", "2026-11-6", "2026/11/06"] {
            assert!(!date_ok(bad), "{bad}");
        }
    }
}
