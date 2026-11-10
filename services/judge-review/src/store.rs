// The content store: the client's spec and rubric, named by the sha256 the job holds. The judge fetches each from
// public IPFS gateways as a raw block, whose CID is computed from the sha256 itself, and keeps only bytes that hash to
// what it asked for: a gateway can withhold content but never change it.
//
// Publish with `ipfs add --cid-version 1 --raw-leaves <file>` (a file up to 1 MiB with `--chunker size-1048576`): the
// CID it prints is `cid(sha256(file))`.
//
// Missing or unreachable decides who answers for it. The client chose the content and keeps it available; content a
// working gateway does not deliver is missing, and the rule against a client who hides the judge applies (an appeal
// asks again). Only when no gateway can be reached at all is it the network's failure, and no verdict is given. A
// gateway that does not deliver, or answers that it is busy (429), is asked for the empty block, which every gateway
// serves at once: if that comes back, the gateway works and the content is what is missing. Each request has 4
// seconds (the module's manifest), and the judge keeps asking until its fetch deadline before it calls content
// missing, so content that is there but slow to find is found.

use crate::job::{hex64_ok, sha256_hex, unhex};
use std::cell::RefCell;

/// Public IPFS gateways that serve raw blocks (the trustless gateway spec), of two operators. Each is asked in turn.
pub const GATEWAYS: [&str; 3] = ["ipfs.io", "dweb.link", "w3s.link"];
/// The empty block: sha256 of nothing.
const CANARY: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// What a fetch found.
#[derive(Debug, Clone, PartialEq)]
pub enum Got {
    Found(Vec<u8>),
    /// A working gateway did not deliver bytes that hash to the name.
    Missing,
    /// No gateway could be reached: the network failed, not the content. The run fails and can be asked again.
    Unreachable(String),
}

/// Bytes by their sha256, lowercase hex, at most `max` bytes.
pub trait Store {
    fn get(&self, sha256: &str, max: usize) -> Got;
}

/// One HTTP GET reading at most `max` bytes of the body (more means the answer is too long). `Err` only when no HTTP
/// answer came: no connection, no TLS, out of time.
pub trait Http {
    fn get(&self, url: &str, accept: &str, max: usize) -> Result<(u16, Vec<u8>), String>;
    fn pause(&self, ms: u64);
}

/// Between two rounds of the gateways.
const ROUND_PAUSE_MS: u64 = 1000;

/// The content store on IPFS gateways. It remembers, for the run, which gateways work.
pub struct Ipfs<'a> {
    pub http: &'a dyn Http,
    pub gateways: &'a [&'a str],
    /// `Some(true)`: delivered something this run; `Some(false)`: could not be reached at all.
    alive: RefCell<Vec<Option<bool>>>,
    /// The run's clock and the time by which content must be found; without one, one round of the gateways.
    until: Option<(&'a dyn crate::Clock, u64)>,
}

impl<'a> Ipfs<'a> {
    pub fn new(http: &'a dyn Http, gateways: &'a [&'a str]) -> Self {
        Ipfs { http, gateways, alive: RefCell::new(vec![None; gateways.len()]), until: None }
    }

    /// Keeps asking, round after round, until `deadline` ms on `clock`.
    pub fn until(mut self, clock: &'a dyn crate::Clock, deadline: u64) -> Self {
        self.until = Some((clock, deadline));
        self
    }

    fn fetch(&self, gw: &str, sha256: &str, max: usize) -> Result<(u16, Vec<u8>), String> {
        let url = format!("https://{gw}/ipfs/{}?format=raw", cid(sha256));
        self.http.get(&url, "application/vnd.ipld.raw", max + 1)
    }
}

impl Store for Ipfs<'_> {
    fn get(&self, sha256: &str, max: usize) -> Got {
        if !hex64_ok(sha256) {
            return Got::Missing;
        }
        let mut last = String::from("no gateway");
        loop {
            for (i, gw) in self.gateways.iter().enumerate() {
                if self.alive.borrow()[i] == Some(false) {
                    continue;
                }
                match self.fetch(gw, sha256, max) {
                    Ok((200, body)) if body.len() <= max && sha256_hex(&body) == sha256 => {
                        self.alive.borrow_mut()[i] = Some(true);
                        return Got::Found(body);
                    }
                    Ok((status, _)) if status != 429 => self.alive.borrow_mut()[i] = Some(true),
                    answer => {
                        last = match answer {
                            Err(e) => format!("{gw}: {e}"),
                            Ok(_) => format!("{gw}: busy"),
                        };
                        if self.alive.borrow()[i].is_none() {
                            let works = matches!(self.fetch(gw, CANARY, 0), Ok((200, b)) if b.is_empty());
                            self.alive.borrow_mut()[i] = Some(works);
                        }
                    }
                }
            }
            let any_alive = self.alive.borrow().contains(&Some(true));
            if !any_alive {
                return Got::Unreachable(last);
            }
            match self.until {
                Some((clock, deadline)) if clock.ms() + ROUND_PAUSE_MS < deadline => self.http.pause(ROUND_PAUSE_MS),
                _ => return Got::Missing,
            }
        }
    }
}

/// Content kept in memory: the local sandbox and the tests.
impl Store for std::collections::BTreeMap<String, Vec<u8>> {
    fn get(&self, sha256: &str, max: usize) -> Got {
        match self.get(sha256) {
            Some(b) if b.len() <= max && sha256_hex(b) == sha256 => Got::Found(b.clone()),
            _ => Got::Missing,
        }
    }
}

/// The CIDv1 of a raw IPFS block whose sha256 is `sha256`: `b` and base32 of 0x01 (v1), 0x55 (raw), 0x12 (sha2-256),
/// 0x20 (32 bytes) and the digest.
pub fn cid(sha256: &str) -> String {
    let mut bytes = vec![0x01, 0x55, 0x12, 0x20];
    bytes.extend(unhex(sha256).unwrap_or_default());
    format!("b{}", base32(&bytes))
}

/// RFC 4648 base32, lowercase, no padding: the multibase `b` alphabet.
fn base32(bytes: &[u8]) -> String {
    const A: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0);
    for b in bytes {
        acc = (acc << 8 | u32::from(*b)) & 0xffff;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(A[(acc >> bits & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(A[(acc << (5 - bits) & 31) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cid_is_computed_from_the_sha256() {
        // `echo -n hello | ipfs add --cid-version 1 --raw-leaves` prints this CID.
        let sha = sha256_hex(b"hello");
        assert_eq!(sha, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        assert_eq!(cid(&sha), "bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq");
        assert_eq!(cid(CANARY), "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    }

    /// How a gateway answers a URL: `Ok` an HTTP answer, `Err` none.
    type Answers = fn(&str) -> Result<(u16, Vec<u8>), String>;

    /// Gateways that answer each URL as told. The canary is told apart by its CID.
    struct Gateways {
        answer: Answers,
        asked: RefCell<Vec<(String, usize)>>,
    }

    impl Http for Gateways {
        fn get(&self, url: &str, accept: &str, max: usize) -> Result<(u16, Vec<u8>), String> {
            assert_eq!(accept, "application/vnd.ipld.raw");
            self.asked.borrow_mut().push((url.to_string(), max));
            (self.answer)(url)
        }
        fn pause(&self, _: u64) {}
    }

    fn ask(answer: Answers) -> (Got, Vec<(String, usize)>) {
        let http = Gateways { answer, asked: RefCell::new(vec![]) };
        let got = Ipfs::new(&http, &GATEWAYS).get(&sha256_hex(b"hello"), 64);
        (got, http.asked.into_inner())
    }

    const CANARY_CID: &str = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

    #[test]
    fn only_bytes_that_hash_to_the_name_are_kept() {
        let (got, asked) = ask(|url| Ok((200, if url.contains("ipfs.io") { b"hullo".to_vec() } else { b"hello".to_vec() })));
        assert_eq!(got, Got::Found(b"hello".to_vec()));
        assert_eq!(asked[0], ("https://ipfs.io/ipfs/bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq?format=raw".into(), 65));
        assert!(asked[1].0.starts_with("https://dweb.link/ipfs/"));
    }

    #[test]
    fn content_a_working_gateway_does_not_deliver_is_missing() {
        // Every gateway times out on the content but serves the empty block: they work, the content is missing.
        let (got, asked) = ask(|url| if url.contains(CANARY_CID) { Ok((200, vec![])) } else { Err("timeout".into()) });
        assert_eq!(got, Got::Missing);
        assert_eq!(asked.len(), 6, "each gateway once for the content, once for the empty block");
        // A gateway that answers 404 or 504 is a working gateway too.
        let (got, _) = ask(|_| Ok((504, vec![])));
        assert_eq!(got, Got::Missing);
        // Content over the limit is not taken, and at most the limit and a byte are read.
        let (got, asked) = ask(|_| Ok((200, vec![b'h'; 65])));
        assert_eq!((got, asked[0].1), (Got::Missing, 65));
    }

    #[test]
    fn content_that_is_slow_to_find_is_asked_for_until_the_deadline() {
        use std::cell::Cell;
        struct Ticks(Cell<u64>);
        impl crate::Clock for Ticks {
            fn ms(&self) -> u64 {
                self.0.set(self.0.get() + 4000);
                self.0.get()
            }
        }
        // The gateways find the content on the third round; a busy answer (429) says nothing about it.
        thread_local!(static ROUND: Cell<u32> = const { Cell::new(0) });
        let http = Gateways {
            answer: |url| {
                if url.contains(CANARY_CID) {
                    return Ok((200, vec![]));
                }
                if url.contains("w3s.link") {
                    ROUND.with(|r| r.set(r.get() + 1));
                    if ROUND.with(|r| r.get()) >= 3 {
                        return Ok((200, b"hello".to_vec()));
                    }
                }
                Ok((if url.contains("ipfs.io") { 429 } else { 504 }, vec![]))
            },
            asked: RefCell::new(vec![]),
        };
        let clock = Ticks(Cell::new(0));
        let ipfs = Ipfs::new(&http, &GATEWAYS).until(&clock, 40_000);
        assert_eq!(ipfs.get(&sha256_hex(b"hello"), 64), Got::Found(b"hello".to_vec()));
        // Never found: missing once the deadline passes, not before.
        let clock = Ticks(Cell::new(0));
        let http = Gateways { answer: |_| Ok((504, vec![])), asked: RefCell::new(vec![]) };
        assert_eq!(Ipfs::new(&http, &GATEWAYS).until(&clock, 40_000).get(&sha256_hex(b"hello"), 64), Got::Missing);
        assert!(http.asked.borrow().len() >= 9, "three rounds at least: {}", http.asked.borrow().len());
    }

    #[test]
    fn a_dead_network_is_not_the_client_s_fault() {
        let (got, asked) = ask(|_| Err("no route".into()));
        assert_eq!(got, Got::Unreachable("w3s.link: no route".into()));
        assert_eq!(asked.len(), 6);
    }

    #[test]
    fn a_gateway_that_cannot_be_reached_is_not_asked_again_in_the_run() {
        let http = Gateways { answer: |url| if url.contains("w3s.link") { Ok((200, b"hello".to_vec())) } else { Err("down".into()) }, asked: RefCell::new(vec![]) };
        let ipfs = Ipfs::new(&http, &GATEWAYS);
        assert_eq!(ipfs.get(&sha256_hex(b"hello"), 64), Got::Found(b"hello".to_vec()));
        let first = http.asked.borrow().len();
        assert_eq!(ipfs.get(&sha256_hex(b"hello"), 64), Got::Found(b"hello".to_vec()));
        assert_eq!(http.asked.borrow().len() - first, 1, "ipfs.io and dweb.link are skipped the second time");
    }
}
