// A job of the jobs contract (contracts/jobs), read the way both job judges read it. The contract asks a judge
// `{"job","contract","kind","appeal","prior","check","deliver"}`; the judge reads the job, its entrants and its steps
// from the chain itself, at one final block, through every RPC source it has, and every source must give the same
// bytes.
//
// This file is shared: services/judge-review includes it with `#[path]`, so both judges read a job, keep the winner's
// work for the client, and shape their answer in exactly one way.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

/// The whole answer the jobs contract reads: anything longer is "too long" there and decides nothing.
pub const MAX_REPLY_BYTES: usize = 4096;
/// Steps a job holds at most (16 masks × 4 steps), and so the steps one view hands out at most.
pub const MAX_STEPS: u32 = 64;
/// A source behind the block the first one named, or a job whose judge run is not final yet, gets this many tries.
const TRIES: u32 = 8;
const PAUSE_MS: u64 = 1500;

/// The project's storage on OutLayer, shared by its runs. Public keys anyone may read (`delivery/…`: the winning work
/// sealed for the client; `material/…`, `review/…` for reviews); the rest only this project's runs (`tests/…`: the
/// test set the check kept; `won/…`: the winner's boxes until the client asks; `answers/…`: a review's answers so far).
pub trait Keep {
    fn keep(&self, key: &str, value: &[u8], public: bool) -> Result<(), String>;
    fn load(&self, key: &str, public: bool) -> Result<Option<Vec<u8>>, String>;
}

/// One NEAR RPC endpoint. `rpc` returns the whole JSON-RPC response body, as text: the judge reads it into typed
/// structs, never into a JSON tree, since a view's answer is a byte array of tens of thousands of numbers.
pub trait Chain {
    fn name(&self) -> &str;
    fn rpc(&self, method: &str, params: Value) -> Result<String, String>;
}

/// The question the jobs contract sends (`ask_judge` in contracts/jobs).
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Input {
    pub job: String,
    pub contract: String,
    pub kind: String,
    #[serde(default)]
    pub appeal: bool,
    /// The verdict an appeal is against.
    #[serde(default)]
    pub prior: Option<Value>,
    /// Before the work window: check the client's material, judge nothing.
    #[serde(default)]
    pub check: bool,
    /// Once the job is paid: seal the winner's work for the client's key, judge nothing.
    #[serde(default)]
    pub deliver: bool,
}

/// The jobs contracts a judge serves, written into its wasm: a run on testnet answers only these, a run on mainnet only
/// those (`main.rs` reads which network OutLayer serves). A run asked by any other account answers nothing, so a
/// contract of someone else's never gets an oracle on a client's private set or a call on the judge's NEAR AI key.
///
/// Only the owner of the parent account can create a contract account under it: `tinygif8324.testnet` is the owner's.
/// On mainnet the list is empty until the owner registers `maskwars.near`: an account nobody holds yet is one anybody
/// could take, and with it `jobs.maskwars.near`. Only the `mainnet` build (`build.sh --mainnet`, made once the owner
/// holds the name: scripts/mainnet/README.md) writes it here, as a judge version of its own; the default build is unchanged.
pub const SERVED_TESTNET: &[&str] = &["jobs.tinygif8324.testnet"];
pub const SERVED_MAINNET: &[&str] = if cfg!(feature = "mainnet") { &["jobs.maskwars.near"] } else { &[] };

/// The jobs contracts this judge serves on `network` (`NEAR_NETWORK_ID`): none on any other.
pub fn served(network: Option<&str>) -> Vec<String> {
    let list = match network {
        Some("testnet") => SERVED_TESTNET,
        Some("mainnet") => SERVED_MAINNET,
        _ => &[],
    };
    list.iter().map(|c| c.to_string()).collect()
}

/// What the run knows about itself, never from the input: who called OutLayer and for which project, from OutLayer;
/// which jobs contracts it serves, from its own code. `predecessor` and `project` are `None` only off OutLayer (tests,
/// the local sandbox); on OutLayer `main.rs` always passes both.
#[derive(Debug, Clone, Default)]
pub struct Caller {
    /// `NEAR_PREDECESSOR_ID`: the account that called OutLayer. A judge judges only for the contract that asked.
    pub predecessor: Option<String>,
    /// `OUTLAYER_PROJECT_ID`: the job must name this project as its judge.
    pub project: Option<String>,
    /// The jobs contracts this judge serves (`served`): a question for any other is refused.
    pub served: Vec<String>,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Scout,
    Striker,
    Verifier,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct JudgeRef {
    pub project: String,
    pub version: String,
    /// The judge's TEE key the job pinned, `x25519:<hex>`.
    #[serde(default)]
    pub key: Option<String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct SecretsRef {
    pub profile: String,
    pub account_id: String,
}

/// What a work needs to win, on chain before anyone started (`bar` in the job's terms). The judge checks the client's
/// material against it and judges by it.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Bar {
    pub win_at: u32,
    /// `tee_tests`: cases in the private set, and the fuel each may burn (a JSON string, as the contract writes a U64).
    #[serde(default)]
    pub cases: Option<u32>,
    #[serde(default)]
    pub fuel: Option<String>,
    /// `tee_tests`: the client's own solution, sealed for the judge, which the check runs.
    #[serde(default)]
    pub reference: Option<String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Terms {
    pub kind: String,
    pub brief: String,
    pub spec: String,
    #[serde(default)]
    pub rubric: Option<String>,
    #[serde(default)]
    pub judge: Option<JudgeRef>,
    #[serde(default)]
    pub secrets: Option<SecretsRef>,
    #[serde(default)]
    pub bar: Option<Bar>,
    /// The client's X25519 key, `x25519:<hex>`: the winning work is sealed for it once the job is paid.
    #[serde(default)]
    pub client_key: Option<String>,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Status {
    pub state: String,
    /// The entrant a paid job paid.
    #[serde(default)]
    pub winner: Option<u32>,
}

/// The job as `get(id)` shows it, as far as a judge reads it.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Job {
    pub id: String,
    pub client: String,
    pub terms: Terms,
    pub status: Status,
    pub entrants: u32,
    pub steps: u32,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Member {
    pub mask: String,
    pub role: Role,
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Entrant {
    #[serde(default)]
    pub crew: Option<String>,
    pub members: Vec<Member>,
}

/// One step as `steps(id)` shows it: sealed in the work window, revealed after it.
#[derive(Deserialize, Debug, Clone, PartialEq)]
pub struct Step {
    pub seq: u32,
    pub entrant: u32,
    pub mask: String,
    pub role: Role,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub copy_of: Option<u32>,
}

impl Step {
    /// Revealed and nobody's copy: the only steps the contract lets a judge count.
    pub fn eligible(&self) -> bool {
        self.content.is_some() && self.copy_of.is_none()
    }
}

/// Everything a judge reads about one job, at one block.
#[derive(Debug, Clone, PartialEq)]
pub struct Read {
    pub job: Job,
    pub entrants: Vec<Entrant>,
    pub steps: Vec<Step>,
    /// The final block every source was read at, and its time (ns): the judge's clock from run to run.
    pub block: u64,
    pub time_ns: u64,
}

impl Read {
    pub fn eligible(&self) -> impl Iterator<Item = &Step> {
        self.steps.iter().filter(|s| s.eligible())
    }
}

/// A verdict as the contract takes it, and what the judge adds for people (the contract ignores the rest).
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub winner: Option<u32>,
    /// Real attempts: their masks' fuel is paid, the winner's split by them.
    pub counted: Vec<u32>,
    /// No real attempt, or work that broke the judge: their masks lose their bonds.
    pub fake: Vec<u32>,
    /// The judge's final word that it cannot decide. Neither judge says it for an outage of what it calls: a failed
    /// call spends nothing, and the judge waits.
    pub undecided: bool,
    /// Shown next to the verdict: how it was reached, scores, evidence. Dropped first if the answer grows too long.
    pub extra: Map<String, Value>,
}

impl Verdict {
    /// The final word that the judge cannot decide, and why.
    pub fn undecided(judge: &str, why: &str) -> Self {
        let mut extra = Map::new();
        extra.insert("judge".into(), json!(judge));
        extra.insert("rule".into(), json!("undecided"));
        extra.insert("why".into(), json!(why.chars().take(300).collect::<String>()));
        Verdict { winner: None, counted: vec![], fake: vec![], undecided: true, extra }
    }
}

/// The judge's stdout: `{"success":true,"output":{"job","winner","counted",…},"error":null}`.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Output {
    pub success: bool,
    pub output: Option<Value>,
    pub error: Option<String>,
}

impl Output {
    pub fn fail(why: impl Into<String>) -> Self {
        Output { success: false, output: None, error: Some(why.into()) }
    }

    pub fn ok(value: Value) -> Self {
        Output { success: true, output: Some(value), error: None }
    }

    /// The verdict on `job`, kept within `MAX_REPLY_BYTES`: the evidence goes first, then the rest of the extras;
    /// the job, the winner, the counted and fake steps and the run's own `asked` always stay.
    pub fn verdict(job: &str, mut v: Verdict) -> Self {
        v.counted.sort_unstable();
        v.counted.dedup();
        v.fake.sort_unstable();
        v.fake.dedup();
        let shape = |extra: &Map<String, Value>| {
            let mut out = Map::new();
            out.insert("job".into(), json!(job));
            out.insert("winner".into(), json!(v.winner));
            out.insert("counted".into(), json!(v.counted));
            out.insert("fake".into(), json!(v.fake));
            if v.undecided {
                out.insert("undecided".into(), json!(true));
            }
            for (k, val) in extra {
                out.insert(k.clone(), val.clone());
            }
            Output::ok(Value::Object(out))
        };
        let mut extra = v.extra.clone();
        for drop in ["calls", "works", "scores", "why"] {
            let out = shape(&extra);
            if out.len() <= MAX_REPLY_BYTES {
                return out;
            }
            extra.remove(drop);
        }
        extra.retain(|k, _| k == "judge" || k == "rule" || k == "asked");
        shape(&extra)
    }

    /// A run that decided nothing, with what the contract needs to know of it: `retry_at` (ns, the chain's clock),
    /// before which a run cannot make progress because what the judge calls is down, and `asked`, the calls this run
    /// made to NEAR AI. The contract asks no run before `retry_at`, and pays a run back from an appeal's held bond
    /// only if it called NEAR AI. With neither, the plain failure.
    pub fn wait(job: &str, why: impl Into<String>, retry_at: Option<u64>, asked: u32) -> Self {
        let mut out = Output::fail(why);
        if retry_at.is_none() && asked == 0 {
            return out;
        }
        let mut o = Map::new();
        o.insert("job".into(), json!(job));
        if let Some(t) = retry_at {
            o.insert("retry_at".into(), json!(t.to_string()));
        }
        if asked > 0 {
            o.insert("asked".into(), json!(asked));
        }
        out.output = Some(Value::Object(o));
        out
    }

    /// The same answer, telling the contract this run made `asked` calls to NEAR AI: a verdict, a check or a failure.
    pub fn asked(mut self, job: &str, asked: u32) -> Self {
        if asked == 0 {
            return self;
        }
        match self.output.as_mut().and_then(Value::as_object_mut) {
            Some(o) => drop(o.insert("asked".into(), json!(asked))),
            None if !self.success => self = Output::wait(job, self.error.unwrap_or_default(), None, asked),
            None => {}
        }
        self
    }

    /// A check's answer: the client's material passed (`Ok`, with what the judge found), or the judge refuses it, and the
    /// contract sends everything back to the client before any mask starts.
    pub fn check(job: &str, judge: &str, result: Result<Map<String, Value>, String>) -> Self {
        let mut out = Map::new();
        out.insert("job".into(), json!(job));
        out.insert("judge".into(), json!(judge));
        match result {
            Ok(found) => {
                out.insert("checked".into(), json!(true));
                out.extend(found);
            }
            Err(why) => {
                out.insert("checked".into(), json!(false));
                out.insert("why".into(), json!(why.chars().take(400).collect::<String>()));
            }
        }
        Output::ok(Value::Object(out))
    }

    /// A delivery's answer: where the winning work, sealed for the client's key, is kept, and the box's sha256.
    pub fn delivered(job: &str, at: &str, sha256: &str) -> Self {
        Output::ok(json!({ "job": job, "delivered": at, "sha256": sha256 }))
    }

    /// Bytes the contract reads: OutLayer hands it the stdout as a JSON string, quotes and backslashes escaped.
    pub fn len(&self) -> usize {
        serde_json::to_string(self).and_then(|s| serde_json::to_vec(&s)).map(|b| b.len()).unwrap_or(usize::MAX)
    }

    pub fn is_empty(&self) -> bool {
        false
    }
}

/// The question, checked against the contracts this judge serves, what OutLayer says about the run and the kind this
/// judge serves.
pub fn question(input: Option<Value>, kind: &str, caller: &Caller) -> Result<Input, String> {
    let input: Input = input.and_then(|i| serde_json::from_value(i).ok()).ok_or("bad input")?;
    if !account_ok(&input.contract) || !id_ok(&input.job) {
        return Err("bad input".into());
    }
    if !caller.served.contains(&input.contract) {
        return Err("this judge serves only the jobs contract written into it".into());
    }
    if input.kind != kind {
        return Err(format!("this judge serves {kind} jobs, not {}", input.kind));
    }
    if let Some(p) = &caller.predecessor {
        if *p != input.contract {
            return Err("a judge answers only the jobs contract that asks it".into());
        }
    }
    Ok(input)
}

/// Reads the job at one final block through every source; all must give the same answer. Waits a little for the
/// judge run to be final, since OutLayer may start before the block that asked is. `key` is this judge's own TEE key:
/// the job must have pinned it.
pub fn read(input: &Input, kind: &str, caller: &Caller, key: &str, sources: &[&dyn Chain]) -> Result<Read, String> {
    let first = *sources.first().ok_or("no RPC source")?;
    // The job alone, until a final block shows it waiting for its judge.
    let mut tries = 0;
    let (block, time_ns) = loop {
        tries += 1;
        let (block, time_ns) = final_block(first)?;
        let get = view(first, &input.contract, "get", json!({ "id": input.job }), block)?;
        let state = serde_json::from_slice::<Job>(&get).map(|j| j.status.state).unwrap_or_default();
        if state == "judging" {
            break (block, time_ns);
        }
        if tries == TRIES {
            return Err(format!("the job is {state}, not waiting for this judge"));
        }
        pause();
    };
    // Then everything, once: every source must give the contract's very bytes at that block, read into a job once.
    let views = views_at(input, first, block).map_err(|e| format!("{}: {e}", first.name()))?;
    for source in &sources[1..] {
        if views_at(input, *source, block).map_err(|e| format!("{}: {e}", source.name()))? != views {
            return Err("the RPC sources disagree".into());
        }
    }
    let r = views.read(block, time_ns)?;
    check(&r, input, kind, caller, key)?;
    Ok(r)
}

/// Reads a paid job at one final block through every source, for a delivery: only `get`, since a paid job's steps are
/// cleared. All must agree; the job must be this judge's, pinned to its `key`, paid, and to a winner.
pub fn read_paid(
    input: &Input,
    kind: &str,
    caller: &Caller,
    key: &str,
    sources: &[&dyn Chain],
) -> Result<(Job, u32), String> {
    let first = *sources.first().ok_or("no RPC source")?;
    let (block, _) = final_block(first)?;
    let get = view(first, &input.contract, "get", json!({ "id": input.job }), block)?;
    for source in &sources[1..] {
        if view(*source, &input.contract, "get", json!({ "id": input.job }), block)? != get {
            return Err("the RPC sources disagree".into());
        }
    }
    let job: Job = serde_json::from_slice(&get).map_err(|_| "get: the contract's answer is not one this judge reads")?;
    if job.id != input.job {
        return Err("the contract answered for another job".into());
    }
    if job.terms.kind != kind {
        return Err(format!("the job is a {} job", job.terms.kind));
    }
    pinned(&job, caller, key)?;
    match (job.status.state.as_str(), job.status.winner) {
        ("paid", Some(w)) => Ok((job, w)),
        (state, _) => Err(format!("the job is {state}: the winning work goes to the client once the job is paid")),
    }
}

/// The steps of the winning entrant a verdict rests on, kept in the project's private storage under
/// `won/<contract>/<job>/<entrant>` until the client asks for them, since a paid job's steps are cleared from the chain.
/// A review keeps the model's reason with them: it cites the work, so it goes to the client with the work and never on
/// chain.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Won {
    pub entrant: u32,
    pub steps: Vec<WonStep>,
    #[serde(default)]
    pub why: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WonStep {
    pub seq: u32,
    pub mask: String,
    pub role: Role,
    /// The box for the judge's key, as the mask revealed it.
    pub content: String,
}

pub fn won_key(contract: &str, job: &str, entrant: u32) -> String {
    format!("won/{contract}/{job}/{entrant}")
}

/// The winner's revealed steps, as the client will get them, with the reason the judge found if it has one.
pub fn won(read: &Read, entrant: u32, why: Option<String>) -> Won {
    let steps = read
        .eligible()
        .filter(|s| s.entrant == entrant)
        .map(|s| WonStep { seq: s.seq, mask: s.mask.clone(), role: s.role, content: s.content.clone().unwrap_or_default() })
        .collect();
    Won { entrant, steps, why }
}

/// The delivery itself, for either judge: what it opens and seals, and where it keeps it.
pub fn delivery(
    q: &Input,
    caller: &Caller,
    chains: &[&dyn Chain],
    keep: &dyn Keep,
    judge: &crate::sealed::JudgeSecret,
    kind: &str,
) -> Result<(String, String), String> {
    let key = crate::sealed::key_text(&crate::sealed::JudgePublic::from(judge));
    let (job, winner) = read_paid(q, kind, caller, &key, chains)?;
    let client_key = job.terms.client_key.as_deref().ok_or("the job names no client key")?;
    let client = crate::sealed::parse_key(client_key)?;
    let won: Won = keep
        .load(&won_key(&q.contract, &q.job, winner), false)?
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or("the winner's work is not in the judge's storage")?;
    if won.entrant != winner {
        return Err("the work the judge kept is not the winner's".into());
    }
    let mut work = vec![];
    for s in &won.steps {
        let mut w = json!({ "seq": s.seq, "mask": s.mask, "role": s.role });
        match crate::sealed::open_work(judge, &q.contract, &q.job, &s.mask, &s.content) {
            Ok(crate::sealed::Work::Module(m)) => w["module"] = json!(crate::sealed::b64url(&m)),
            Ok(crate::sealed::Work::Text(t)) => w["text"] = json!(t),
            Err(_) => continue,
        }
        work.push(w);
    }
    let mut payload = json!({ "job": q.job, "contract": q.contract, "entrant": winner, "work": work });
    if let Some(why) = &won.why {
        payload["why"] = json!(why);
    }
    let payload = payload.to_string();
    let boxed = crate::sealed::seal_delivery(judge, &client, &q.contract, &q.job, &job.client, payload.as_bytes())?;
    let at = format!("delivery/{}/{}", q.contract, q.job);
    keep.keep(&at, boxed.as_bytes(), true)?;
    Ok((at, sha256_hex(boxed.as_bytes())))
}

/// The contract's own answers to `get`, `entrants` and `steps`, as bytes. One page holds every step a job may have.
#[derive(PartialEq)]
struct Views {
    get: Vec<u8>,
    entrants: Vec<u8>,
    steps: Vec<u8>,
}

impl Views {
    fn read(&self, block: u64, time_ns: u64) -> Result<Read, String> {
        fn parse<T: DeserializeOwned>(bytes: &[u8], method: &str) -> Result<T, String> {
            serde_json::from_slice(bytes).map_err(|_| format!("{method}: the contract's answer is not one this judge reads"))
        }
        let job: Job = parse(&self.get, "get")?;
        if job.steps > MAX_STEPS {
            return Err("the job holds more steps than a job may".into());
        }
        Ok(Read { job, entrants: parse(&self.entrants, "entrants")?, steps: parse(&self.steps, "steps")?, block, time_ns })
    }
}

/// The job pinned this judge: its project, as OutLayer names it, and its own TEE key. Work sealed for another key is
/// not this judge's to open, and nothing it says about such a job is a verdict.
fn pinned(job: &Job, caller: &Caller, key: &str) -> Result<(), String> {
    let judge = job.terms.judge.as_ref().ok_or("the job names no judge")?;
    if let Some(p) = &caller.project {
        if judge.project != *p {
            return Err("the job pinned another judge".into());
        }
    }
    if judge.key.as_deref() != Some(key) {
        return Err("the job pinned another judge key: this judge answers nothing for it".into());
    }
    Ok(())
}

fn check(r: &Read, input: &Input, kind: &str, caller: &Caller, key: &str) -> Result<(), String> {
    if r.job.id != input.job {
        return Err("the contract answered for another job".into());
    }
    if r.job.terms.kind != kind {
        return Err(format!("the job is a {} job", r.job.terms.kind));
    }
    pinned(&r.job, caller, key)?;
    if r.entrants.len() != r.job.entrants as usize || r.steps.len() != r.job.steps as usize {
        return Err("the job's entrants or steps did not read whole".into());
    }
    for (i, s) in r.steps.iter().enumerate() {
        if s.seq as usize != i || s.entrant >= r.job.entrants {
            return Err("the job's steps are out of order".into());
        }
    }
    Ok(())
}

/// The final block's height and time (ns).
fn final_block(chain: &dyn Chain) -> Result<(u64, u64), String> {
    #[derive(Deserialize)]
    struct Block {
        header: Header,
    }
    #[derive(Deserialize)]
    struct Header {
        height: u64,
        #[serde(default)]
        timestamp: u64,
    }
    let b: Block = reply(&chain.rpc("block", json!({ "finality": "final" }))?)?;
    Ok((b.header.height, b.header.timestamp))
}

fn views_at(input: &Input, chain: &dyn Chain, block: u64) -> Result<Views, String> {
    let id = json!({ "id": input.job });
    let page = json!({ "id": input.job, "from_index": 0, "limit": MAX_STEPS });
    Ok(Views {
        get: view(chain, &input.contract, "get", id.clone(), block)?,
        entrants: view(chain, &input.contract, "entrants", id, block)?,
        steps: view(chain, &input.contract, "steps", page, block)?,
    })
}

/// A view call at a block: the contract's answer as bytes. A source that has not reached the block yet gets a few
/// more tries.
fn view(chain: &dyn Chain, contract: &str, method: &str, args: Value, block: u64) -> Result<Vec<u8>, String> {
    let request = json!({ "request_type": "call_function", "account_id": contract, "method_name": method,
                          "args_base64": base64(args.to_string().as_bytes()), "block_id": block });
    let mut tries = 0;
    loop {
        tries += 1;
        match view_bytes(&chain.rpc("query", request.clone())?) {
            Err(e) if e.contains("UNKNOWN_BLOCK") && tries < TRIES => pause(),
            other => return other.map_err(|e| format!("{method}: {e}")),
        }
    }
}

/// The contract's answer in a JSON-RPC answer to a view: the byte array `result.result`, found and read in one pass.
/// A view's answer is tens of thousands of numbers; a JSON parser would spend most of a judge run on it.
pub fn view_bytes(body: &str) -> Result<Vec<u8>, String> {
    if let Some(raw) = inner_result(body.as_bytes()) {
        return byte_array(raw);
    }
    // No byte array: an RPC error, or a contract that failed. Such answers are short.
    #[derive(Deserialize)]
    struct Failed {
        #[serde(default)]
        error: Option<String>,
    }
    let failed: Failed = reply(body)?;
    Err(match failed.error {
        Some(e) => format!("the contract failed: {}", e.chars().take(120).collect::<String>()),
        None => "the contract answered nothing".into(),
    })
}

/// A view's answer as `T`, read the way a judge reads it.
pub fn decode<T: DeserializeOwned>(body: &str) -> Result<T, String> {
    serde_json::from_slice(&view_bytes(body)?).map_err(|_| "the contract's answer is not one this judge reads".into())
}

/// The array under key `result` of the object under the top-level key `result`, as its raw text. Strings are
/// skipped whole, escapes included, so text in logs or hashes never looks like structure.
fn inner_result(b: &[u8]) -> Option<&[u8]> {
    // For each open object or array: whether it is the value of a key `result`.
    let mut open: Vec<bool> = vec![];
    let mut key_result = false;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'"' => {
                let start = i + 1;
                i += 1;
                while i < b.len() && b[i] != b'"' {
                    i += if b[i] == b'\\' { 2 } else { 1 };
                }
                let mut j = i + 1;
                while j < b.len() && b[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < b.len() && b[j] == b':' {
                    key_result = &b[start..i.min(b.len())] == b"result";
                }
            }
            b'[' if key_result && open == [false, true] => {
                let end = i + b[i..].iter().position(|c| *c == b']')?;
                return Some(&b[i..=end]);
            }
            b'{' | b'[' => {
                open.push(key_result);
                key_result = false;
            }
            b'}' | b']' => {
                open.pop();
                key_result = false;
            }
            b',' => key_result = false,
            _ => {}
        }
        i += 1;
    }
    None
}

/// A JSON array of numbers 0 to 255, as bytes, in one pass.
fn byte_array(raw: &[u8]) -> Result<Vec<u8>, String> {
    let bad = || "the contract's answer is not bytes".to_string();
    let inner = raw.strip_prefix(b"[").and_then(|r| r.strip_suffix(b"]")).ok_or_else(bad)?;
    let mut out = Vec::with_capacity(inner.len() / 3);
    if inner.iter().all(u8::is_ascii_whitespace) {
        return Ok(out);
    }
    // `ended`: a number was read and a space followed it; only a comma may come next.
    let (mut n, mut digits, mut ended) = (0u32, 0u32, false);
    for &b in inner.iter().chain(b",") {
        match b {
            b'0'..=b'9' if !ended && digits < 3 && !(digits == 1 && n == 0) => {
                n = n * 10 + u32::from(b - b'0');
                digits += 1;
            }
            b',' if digits > 0 && n <= 255 => {
                out.push(n as u8);
                (n, digits, ended) = (0, 0, false);
            }
            b' ' | b'\n' | b'\r' | b'\t' => ended = digits > 0,
            _ => return Err(bad()),
        }
    }
    Ok(out)
}

/// The `result` of a JSON-RPC answer, or the RPC's error by name.
fn reply<T: DeserializeOwned>(body: &str) -> Result<T, String> {
    #[derive(Deserialize)]
    struct Reply<T> {
        result: Option<T>,
        error: Option<Error>,
    }
    #[derive(Deserialize)]
    struct Error {
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        cause: Option<Cause>,
    }
    #[derive(Deserialize)]
    struct Cause {
        #[serde(default)]
        name: Option<String>,
    }
    let r: Reply<T> = serde_json::from_str(body).map_err(|_| "the RPC answer is unreadable".to_string())?;
    if let Some(e) = r.error {
        let why = e.cause.and_then(|c| c.name).or(e.name).unwrap_or_else(|| "error".into());
        return Err(format!("RPC answered {why}"));
    }
    r.result.ok_or_else(|| "RPC answered nothing".into())
}

fn pause() {
    std::thread::sleep(std::time::Duration::from_millis(PAUSE_MS));
}

/// A NEAR account id: 2 to 64 of lowercase letters, digits, `-`, `_`, `.`, no separator at an end or twice.
pub fn account_ok(id: &str) -> bool {
    let b = id.as_bytes();
    (2..=64).contains(&b.len())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"-_.".contains(c))
        && !b"-_.".contains(&b[0])
        && !b"-_.".contains(&b[b.len() - 1])
        && !b.windows(2).any(|w| b"-_.".contains(&w[0]) && b"-_.".contains(&w[1]))
}

/// A job id as the contract takes it: 1 to 64 lowercase letters, digits, `-` or `_`.
pub fn id_ok(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

pub fn hex64_ok(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex(&Sha256::digest(bytes))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(s: &str) -> Result<Vec<u8>, String> {
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not hex".into());
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| "not hex".into())).collect()
}

/// Standard base64 with padding, as NEAR RPC takes `args_base64`.
pub fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
pub mod testing {
    //! A chain of canned answers, for the unit tests of both judges.
    use super::*;
    use std::cell::RefCell;

    /// Answers `block` with `height` and `time_ns`, and every view with what `views` holds for its method.
    pub struct Canned {
        pub name: &'static str,
        pub height: u64,
        pub time_ns: u64,
        pub job: Value,
        pub entrants: Value,
        pub steps: Value,
        pub asked: RefCell<Vec<String>>,
    }

    /// The chain's time in these tests: 9 November 2026, in nanoseconds.
    pub const T0: u64 = 1_794_000_000_000_000_000;
    pub const MINUTE_NS: u64 = 60_000_000_000;

    impl Canned {
        pub fn new(job: Value, entrants: Value, steps: Value) -> Self {
            Canned { name: "canned", height: 100, time_ns: T0, job, entrants, steps, asked: RefCell::new(vec![]) }
        }
    }

    /// The jobs contract these tests read, as a judge on OutLayer would be asked by it for `project`.
    pub fn caller(project: &str) -> Caller {
        Caller {
            predecessor: Some("jobs.testnet".into()),
            project: Some(project.into()),
            served: vec!["jobs.testnet".into()],
        }
    }

    /// Off OutLayer: no predecessor or project to check, but the contract served is still the one written in.
    pub fn local() -> Caller {
        Caller { predecessor: None, project: None, served: vec!["jobs.testnet".into()] }
    }

    fn bytes(v: &Value) -> Value {
        json!({ "result": serde_json::to_vec(v).unwrap(), "logs": [], "block_height": 100 })
    }

    impl Chain for Canned {
        fn name(&self) -> &str {
            self.name
        }
        fn rpc(&self, method: &str, params: Value) -> Result<String, String> {
            if method == "block" {
                return Ok(json!({ "result": { "header": { "height": self.height, "timestamp": self.time_ns } } }).to_string());
            }
            let m = params["method_name"].as_str().unwrap_or("").to_string();
            self.asked.borrow_mut().push(m.clone());
            let r = match m.as_str() {
                "get" => bytes(&self.job),
                "entrants" => bytes(&self.entrants),
                "steps" => {
                    let args: Value =
                        serde_json::from_slice(&unbase64(params["args_base64"].as_str().unwrap())).unwrap();
                    let from = args["from_index"].as_u64().unwrap_or(0) as usize;
                    let all = self.steps.as_array().unwrap();
                    bytes(&json!(all[from.min(all.len())..].iter().take(64).collect::<Vec<_>>()))
                }
                _ => return Ok(json!({ "error": { "name": "HANDLER_ERROR", "cause": { "name": "NO_METHOD" } } }).to_string()),
            };
            Ok(json!({ "jsonrpc": "2.0", "id": "x", "result": r }).to_string())
        }
    }

    pub fn unbase64(s: &str) -> Vec<u8> {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = vec![];
        let mut acc = 0u32;
        let mut n = 0;
        for c in s.bytes().filter(|c| *c != b'=') {
            acc = (acc << 6 | T.iter().position(|t| *t == c).unwrap() as u32) & 0xffff;
            n += 6;
            if n >= 8 {
                n -= 8;
                out.push((acc >> n) as u8);
            }
        }
        out
    }

    /// A job of `kind` in its judge run, pinned to `maskwars.testnet/<kind>`.
    pub fn job(kind: &str, entrants: u32, steps: u32) -> Value {
        json!({ "id": "job-1", "client": "dao.testnet",
                "terms": { "kind": kind, "brief": "b", "spec": "a".repeat(64), "rubric": "b".repeat(64),
                           "judge": { "kind": kind, "project": format!("maskwars.testnet/{kind}"), "version": "c".repeat(64) },
                           "secrets": null },
                "status": { "state": "judging", "height": "90", "run": 1 }, "entrants": entrants, "steps": steps,
                "phase": "judging" })
    }

    pub fn step(seq: u32, entrant: u32, mask: &str, role: &str, content: Option<&str>, copy_of: Option<u32>) -> Value {
        json!({ "seq": seq, "entrant": entrant, "mask": mask, "role": role, "hash": "d".repeat(64), "at_ns": "1",
                "content": content, "digest": content.map(|c| sha256_hex(c.as_bytes())), "copy_of": copy_of })
    }

    /// The project's storage, in memory: public and private keys apart, kept from run to run.
    #[derive(Default)]
    pub struct Kept(pub RefCell<std::collections::BTreeMap<(bool, String), Vec<u8>>>);

    impl Keep for Kept {
        fn keep(&self, key: &str, value: &[u8], public: bool) -> Result<(), String> {
            self.0.borrow_mut().insert((public, key.to_string()), value.to_vec());
            Ok(())
        }
        fn load(&self, key: &str, public: bool) -> Result<Option<Vec<u8>>, String> {
            Ok(self.0.borrow().get(&(public, key.to_string())).cloned())
        }
    }

    impl Kept {
        pub fn public(&self, key: &str) -> Option<Vec<u8>> {
            self.0.borrow().get(&(true, key.to_string())).cloned()
        }
        pub fn private(&self, key: &str) -> Option<Vec<u8>> {
            self.0.borrow().get(&(false, key.to_string())).cloned()
        }
    }

    pub fn solo(mask: &str) -> Value {
        json!({ "crew": null, "version": 0, "members": [{ "mask": mask, "role": "striker" }],
                "split": { "scout": 0, "striker": 10000, "verifier": 0 } })
    }

    pub fn ask(kind: &str) -> Input {
        Input {
            job: "job-1".into(),
            contract: "jobs.testnet".into(),
            kind: kind.into(),
            appeal: false,
            prior: None,
            check: false,
            deliver: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    const KEY: &str = "x25519:6c8fed6f2acd4093f45f4921108f6234ab86cf6b1b4ef2c1c8668b8ba1f53864";

    fn canned() -> Canned {
        let mut job = job("tee_tests", 2, 3);
        job["terms"]["judge"]["key"] = json!(KEY);
        Canned::new(
            job,
            json!([solo("nova.testnet"), solo("onyx.testnet")]),
            json!([
                step(0, 0, "nova.testnet", "striker", Some("a"), None),
                step(1, 1, "onyx.testnet", "striker", Some("a"), Some(0)),
                step(2, 1, "onyx.testnet", "striker", Some("b"), None),
            ]),
        )
    }

    #[test]
    fn a_job_reads_whole_at_one_block_from_every_source() {
        let (a, mut b) = (canned(), canned());
        b.name = "second";
        let r = read(&ask("tee_tests"), "tee_tests", &caller("maskwars.testnet/tee_tests"), KEY, &[&a, &b]).unwrap();
        assert_eq!((r.block, r.time_ns, r.steps.len(), r.entrants.len()), (100, T0, 3, 2));
        assert_eq!(r.eligible().map(|s| s.seq).collect::<Vec<_>>(), vec![0, 2]);
        assert_eq!(*b.asked.borrow(), vec!["get", "entrants", "steps"]);
    }

    #[test]
    fn every_source_must_agree() {
        let a = canned();
        let mut b = canned();
        b.steps[2]["content"] = json!("c");
        let err = read(&ask("tee_tests"), "tee_tests", &local(), KEY, &[&a, &b]).unwrap_err();
        assert_eq!(err, "the RPC sources disagree");
    }

    #[test]
    fn a_judge_answers_only_the_contract_that_asked_and_only_its_own_jobs() {
        let input = json!({ "job": "job-1", "contract": "jobs.testnet", "kind": "tee_tests", "appeal": false, "prior": null });
        let mimic = Caller { predecessor: Some("mimic.testnet".into()), project: None, served: vec!["jobs.testnet".into()] };
        assert_eq!(question(Some(input.clone()), "tee_tests", &mimic).unwrap_err(), "a judge answers only the jobs contract that asks it");
        let over_https = Caller { predecessor: Some(String::new()), project: None, served: vec!["jobs.testnet".into()] };
        assert!(question(Some(input.clone()), "tee_tests", &over_https).is_err());
        assert!(question(Some(input.clone()), "ai_review", &local()).is_err());
        for bad in [json!({ "job": "Job 1", "contract": "jobs.testnet", "kind": "tee_tests" }), json!([1]), json!({ "kind": "tee_tests" })] {
            assert_eq!(question(Some(bad), "tee_tests", &local()).unwrap_err(), "bad input");
        }
        let other = Caller { predecessor: None, project: Some("someone.testnet/tests".into()), served: vec!["jobs.testnet".into()] };
        let c = canned();
        assert_eq!(read(&ask("tee_tests"), "tee_tests", &other, KEY, &[&c]).unwrap_err(), "the job pinned another judge");
        assert_eq!(read(&ask("ai_review"), "ai_review", &local(), KEY, &[&c]).unwrap_err(), "the job is a tee_tests job");
    }

    /// Third review, finding 3: a judge served any contract that called it, so a contract of someone else's, which
    /// answers its views as it likes, got an oracle on a client's private set and calls on the judge's NEAR AI key.
    /// Now the contracts a judge serves are written into its wasm, one a network, and it answers no other, even one
    /// that calls it itself.
    #[test]
    fn a_judge_serves_only_the_jobs_contract_written_into_it() {
        assert_eq!(served(Some("testnet")), vec!["jobs.tinygif8324.testnet"]);
        if cfg!(feature = "mainnet") {
            assert_eq!(served(Some("mainnet")), vec!["jobs.maskwars.near"], "the mainnet build, once the owner holds the name");
        } else {
            assert!(served(Some("mainnet")).is_empty(), "nothing on mainnet until the owner holds maskwars.near");
        }
        assert!(served(Some("localnet")).is_empty() && served(None).is_empty());
        let fake = json!({ "job": "job-1", "contract": "fake-jobs.testnet", "kind": "tee_tests" });
        let itself = Caller { predecessor: Some("fake-jobs.testnet".into()), project: None, served: served(Some("testnet")) };
        assert_eq!(question(Some(fake), "tee_tests", &itself).unwrap_err(), "this judge serves only the jobs contract written into it");
        let ours = json!({ "job": "job-1", "contract": "jobs.tinygif8324.testnet", "kind": "tee_tests" });
        let asked = Caller { predecessor: Some("jobs.tinygif8324.testnet".into()), project: None, served: served(Some("testnet")) };
        assert!(question(Some(ours.clone()), "tee_tests", &asked).is_ok());
        let mainnet = Caller { served: served(Some("mainnet")), ..asked };
        assert!(question(Some(ours), "tee_tests", &mainnet).is_err(), "a mainnet run does not serve the testnet contract");
    }

    /// Fourth review, finding 2: the mainnet list named `jobs.maskwars.near`, and `maskwars.near` is not registered
    /// (free at block 223791971). Whoever registers it first creates `jobs.maskwars.near`, deploys a contract that
    /// answers its views as it likes, and every mainnet build of the judges answers it: an oracle on any client's
    /// private set and calls on the judge's NEAR AI key. Now a mainnet run serves nobody until the owner holds the name,
    /// and the build that serves it (`--features mainnet`) is made only after.
    #[cfg(not(feature = "mainnet"))]
    #[test]
    fn a_mainnet_run_serves_no_account_the_owner_does_not_hold() {
        for kind in ["tee_tests", "ai_review"] {
            let squatter = Caller {
                predecessor: Some("jobs.maskwars.near".into()),
                project: Some(format!("maskwars.near/{kind}")),
                served: served(Some("mainnet")),
            };
            for input in [
                json!({ "job": "job-1", "contract": "jobs.maskwars.near", "kind": kind, "check": true }),
                json!({ "job": "job-1", "contract": "jobs.maskwars.near", "kind": kind }),
                json!({ "job": "job-1", "contract": "jobs.maskwars.near", "kind": kind, "deliver": true }),
            ] {
                assert_eq!(
                    question(Some(input), kind, &squatter).unwrap_err(),
                    "this judge serves only the jobs contract written into it"
                );
            }
        }
        assert!(SERVED_MAINNET.iter().chain(SERVED_TESTNET).all(|c| c.ends_with(".tinygif8324.testnet") || c.ends_with(".maskwars.near")));
    }

    /// The mainnet build, made once the owner holds `maskwars.near`: it answers `jobs.maskwars.near` when that contract
    /// itself asks, and still no other account on mainnet, a look-alike or a testnet one.
    #[cfg(feature = "mainnet")]
    #[test]
    fn the_mainnet_build_serves_jobs_maskwars_near_and_nothing_else() {
        for kind in ["tee_tests", "ai_review"] {
            let ours = json!({ "job": "job-1", "contract": "jobs.maskwars.near", "kind": kind });
            let asked = Caller { predecessor: Some("jobs.maskwars.near".into()), project: None, served: served(Some("mainnet")) };
            assert!(question(Some(ours), kind, &asked).is_ok());
            for other in ["jobs-maskwars.near", "jobs.maskwars.near.evil.near", "jobs.tinygif8324.testnet"] {
                let input = json!({ "job": "job-1", "contract": other, "kind": kind });
                let itself = Caller { predecessor: Some(other.into()), project: None, served: served(Some("mainnet")) };
                assert_eq!(question(Some(input), kind, &itself).unwrap_err(), "this judge serves only the jobs contract written into it");
            }
        }
    }

    /// Third review, finding 5: a judge never compared its own key with the one the job pinned. Now a job pinned to
    /// another key, or to none, gets no check, verdict or delivery from it.
    #[test]
    fn a_judge_answers_only_a_job_pinned_to_its_own_key() {
        let mut c = canned();
        let other = "x25519:7c8a393f8708112b7cd720c8f66296a659ccb3a5c7594692a5599a76dd47514d";
        assert!(read(&ask("tee_tests"), "tee_tests", &local(), other, &[&c]).unwrap_err().starts_with("the job pinned another judge key"));
        c.job["terms"]["judge"]["key"] = Value::Null;
        assert!(read(&ask("tee_tests"), "tee_tests", &local(), KEY, &[&c]).is_err());
        c.job["terms"]["judge"]["key"] = json!(KEY);
        c.job["status"] = json!({ "state": "paid", "winner": 1 });
        let mut input = ask("tee_tests");
        input.deliver = true;
        assert!(read_paid(&input, "tee_tests", &local(), other, &[&c]).unwrap_err().starts_with("the job pinned another judge key"));
        assert!(read_paid(&input, "tee_tests", &local(), KEY, &[&c]).is_ok());
    }

    #[test]
    fn a_verdict_names_its_fake_steps_and_an_undecided_one_says_so() {
        let v = Verdict { winner: Some(0), counted: vec![2, 0, 2], fake: vec![3, 1, 3], undecided: false, extra: Map::new() };
        let o = Output::verdict("job-1", v).output.unwrap();
        assert_eq!((o["counted"].clone(), o["fake"].clone(), o.get("undecided")), (json!([0, 2]), json!([1, 3]), None));
        let o = Output::verdict("job-1", Verdict::undecided("ai_review", "every seed spent")).output.unwrap();
        assert_eq!((o["undecided"].clone(), o["winner"].clone(), o["rule"].clone()), (json!(true), Value::Null, json!("undecided")));
    }

    #[test]
    fn a_paid_job_reads_for_a_delivery_and_nothing_else_does() {
        let mut c = canned();
        let caller = local();
        let mut input = ask("tee_tests");
        input.deliver = true;
        assert!(read_paid(&input, "tee_tests", &caller, KEY, &[&c]).unwrap_err().ends_with("once the job is paid"));
        c.job["status"] = json!({ "state": "paid", "winner": 1 });
        let (job, winner) = read_paid(&input, "tee_tests", &caller, KEY, &[&c]).unwrap();
        assert_eq!((job.id.as_str(), winner), ("job-1", 1));
        assert_eq!(*c.asked.borrow(), vec!["get", "get"], "a delivery reads only the job");
    }

    #[test]
    fn a_check_answers_whether_the_material_passed() {
        let mut found = Map::new();
        found.insert("criteria".into(), json!(2));
        let o = Output::check("job-1", "ai_review", Ok(found)).output.unwrap();
        assert_eq!(o, json!({ "job": "job-1", "judge": "ai_review", "checked": true, "criteria": 2 }));
        let o = Output::check("job-1", "ai_review", Err("x".repeat(500))).output.unwrap();
        assert_eq!((o["checked"].clone(), o["why"].as_str().unwrap().len()), (json!(false), 400));
        let input = json!({ "job": "job-1", "contract": "jobs.testnet", "kind": "tee_tests", "appeal": false, "prior": null, "check": true });
        assert!(question(Some(input), "tee_tests", &local()).unwrap().check);
    }

    #[test]
    fn an_answer_stays_within_what_the_contract_reads() {
        let mut extra = Map::new();
        extra.insert("judge".into(), json!("ai_review"));
        extra.insert("rule".into(), json!("review"));
        extra.insert("calls".into(), json!(["x".repeat(3000)]));
        extra.insert("why".into(), json!("y".repeat(5000)));
        let out = Output::verdict("job-1", Verdict { winner: Some(1), counted: vec![3, 1, 3], fake: vec![], undecided: false, extra });
        assert!(out.len() <= MAX_REPLY_BYTES);
        let o = out.output.unwrap();
        assert_eq!((o["winner"].clone(), o["counted"].clone(), o["rule"].clone()), (json!(1), json!([1, 3]), json!("review")));
        assert!(o.get("calls").is_none() && o.get("why").is_none());
    }

    #[test]
    fn a_view_s_byte_array_reads_in_one_pass() {
        assert_eq!(byte_array(b"[123, 34,0 ,255]").unwrap(), vec![123, 34, 0, 255]);
        assert_eq!(byte_array(b"[]").unwrap(), Vec::<u8>::new());
        for bad in ["[256]", "[1,,2]", "[1,]", "[-1]", "[1.5]", "[\"1\"]", "[1000]", "{}", "[012]", "[1 2]"] {
            assert!(byte_array(bad.as_bytes()).is_err(), "{bad}");
        }
        // Wherever the RPC puts its fields, and whatever its logs say, only `result.result` is read.
        let bytes = b"[1,2]".to_vec();
        for body in [
            json!({ "jsonrpc": "2.0", "id": "x", "result": { "logs": [], "result": bytes, "block_height": 7 } }).to_string(),
            json!({ "result": { "block_hash": "x", "logs": ["\"result\":[9,9]", "]"], "result": bytes }, "id": "result" }).to_string(),
            "{ \"id\" : \"x\", \"result\" : { \"result\" : [ 91 , 49 , 44 , 50 , 93 ], \"logs\": [] } }".to_string(),
        ] {
            assert_eq!(decode::<Vec<u8>>(&body).unwrap(), vec![1, 2], "{body}");
        }
        let failed = json!({ "result": { "error": "wasm execution failed with error: no such job", "logs": [] } });
        assert!(decode::<Value>(&failed.to_string()).unwrap_err().starts_with("the contract failed: wasm execution failed"));
        let unknown = json!({ "error": { "name": "HANDLER_ERROR", "cause": { "name": "UNKNOWN_BLOCK" } } });
        assert_eq!(decode::<Value>(&unknown.to_string()).unwrap_err(), "RPC answered UNKNOWN_BLOCK");
    }

    #[test]
    fn base64_matches_the_standard() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(br#"{"id":"job-1"}"#), "eyJpZCI6ImpvYi0xIn0=");
        assert_eq!(unbase64("eyJpZCI6ImpvYi0xIn0="), br#"{"id":"job-1"}"#);
    }

    #[test]
    fn account_ids() {
        for ok in ["jobs.testnet", "a1", "maskwars_jobs.near", "0e6879a4be88"] {
            assert!(account_ok(ok), "{ok}");
        }
        for bad in ["", "A.near", "a..b", ".a", "a-", "x"] {
            assert!(!account_ok(bad), "{bad}");
        }
    }
}
