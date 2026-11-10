// Reads NEAR straight from JSON-RPC, the way packages/check/src/rpc.ts does: accounts, blocks and view calls, at the
// latest final block or at a given height. Two ways to use two endpoints:
// - failover: the second is tried only when the first is down or overloaded. Answers that are the same on every node
//   (no such account, a contract panic) never switch endpoints.
// - cross-check: every read goes to every endpoint at the same block, and an answer counts only when they all give
//   the same one. The block is the lowest final head any of them names, so each of them has it; heads more than
//   `MAX_LAG_BLOCKS` apart are no common head and stop the check like any other disagreement. A node that is down or
//   no longer keeps a block sits that read out, and the tally says so: the check warns about a read one node alone
//   answered.
//
// One difference from the TypeScript reader, for the enclave: a node that went down is not asked again during the
// same check in failover either. OutLayer ends a run on its second request that times out, so a hung first node must
// cost one timeout, not one per read. The answers come from the same blocks either way.

use serde_json::{json, Map, Value};

/// In cross-check mode, how far apart the endpoints' final heads may be: about a minute of blocks. Further apart, one
/// of them is stale or one is ahead of the chain, and nothing says which, so there is no head to read at.
pub const MAX_LAG_BLOCKS: u64 = 100;

/// A code hash of 32 zero bytes: the account has no contract.
pub const NO_CODE: &str = "11111111111111111111111111111111";

/// The longest answer the reader takes from a node.
pub const MAX_BODY: usize = 1 << 20;

/// HTTPS as the module has it: one POST with a JSON body. `Err` is why nothing came back.
pub trait Transport {
    fn post(&self, url: &str, body: &str) -> Result<(u16, Vec<u8>), String>;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// The endpoint did not answer.
    Transport,
    /// The endpoint answered with an error of its own: overload, not synced, 5xx.
    Server,
    UnknownAccount,
    /// Never produced, or already garbage-collected on this node.
    UnknownBlock,
    UnknownKey,
    /// The view call panicked, or the account has no such method or no code.
    Contract,
    /// A request the node refuses as such.
    Handler,
    /// Cross-check: two endpoints gave different answers to the same read at the same block.
    Disagree,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Transport => "transport",
            Kind::Server => "server",
            Kind::UnknownAccount => "unknown_account",
            Kind::UnknownBlock => "unknown_block",
            Kind::UnknownKey => "unknown_key",
            Kind::Contract => "contract",
            Kind::Handler => "handler",
            Kind::Disagree => "disagree",
        }
    }

    /// Errors the next endpoint may not have: it may be synced, archival or less busy.
    fn retry_elsewhere(self) -> bool {
        matches!(self, Kind::Transport | Kind::Server | Kind::UnknownBlock)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChainError {
    pub kind: Kind,
    /// `<endpoint>: <what happened>`.
    pub message: String,
}

impl ChainError {
    pub fn new(endpoint: &str, kind: Kind, message: impl AsRef<str>) -> Self {
        ChainError { kind, message: format!("{endpoint}: {}", message.as_ref()) }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum At {
    Final,
    Height(u64),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccountInfo {
    pub amount: String,
    /// The contract's code hash; `NO_CODE` for a plain account. A global contract's hash when the account uses one.
    pub code_hash: String,
    pub block_height: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlockInfo {
    pub height: u64,
    pub hash: String,
    /// Nanoseconds since the Unix epoch, exact.
    pub timestamp_ns: u64,
}

impl BlockInfo {
    /// The block's time in milliseconds since the Unix epoch.
    pub fn time_ms(&self) -> i64 {
        (self.timestamp_ns / 1_000_000) as i64
    }
}

/// How one check's reads were answered.
#[derive(Default, Debug)]
pub struct Tally {
    /// Reads that got an answer.
    pub reads: u32,
    /// Reads every endpoint answered, all alike.
    pub agreed: u32,
    /// An endpoint that sat a read out → what it said, the latest; in the order they first sat out.
    pub missing: Vec<(String, String)>,
    /// Endpoints that were down → the error they gave: not asked again during this check.
    down: Vec<(String, ChainError)>,
}

type Answer = Map<String, Value>;

enum Outcome {
    Said { endpoint: String, result: Answer, print: String },
    Failed { endpoint: String, error: ChainError },
}

/// One check's reader: its tally starts at zero.
pub struct Reader<'t> {
    pub endpoints: Vec<String>,
    pub cross_check: bool,
    archival: Vec<(String, String)>,
    transport: &'t dyn Transport,
    pub tally: Tally,
}

impl<'t> Reader<'t> {
    pub fn new(endpoints: &[&str], archival: &[(&str, &str)], cross_check: bool, transport: &'t dyn Transport) -> Self {
        assert!(!endpoints.is_empty(), "at least one RPC endpoint");
        Reader {
            endpoints: endpoints.iter().map(|e| e.to_string()).collect(),
            cross_check,
            archival: archival.iter().map(|(e, a)| (e.to_string(), a.to_string())).collect(),
            transport,
            tally: Tally::default(),
        }
    }

    /// One JSON-RPC call: failover, or every endpoint at one block in cross-check mode.
    pub fn rpc(&mut self, method: &str, mut params: Answer) -> Result<Answer, ChainError> {
        if !self.cross_check {
            return self.failover(method, &params);
        }
        if params.get("finality").and_then(Value::as_str) == Some("final") {
            // Two nodes rarely sit on the same final head: pin the read to one height both of them have.
            params.shift_remove("finality");
            params.insert("block_id".into(), json!(self.final_height()?));
        }
        self.agreed(method, &params)
    }

    fn down(&self, endpoint: &str) -> Option<&ChainError> {
        self.tally.down.iter().find(|(e, _)| e == endpoint).map(|(_, error)| error)
    }

    fn note_down(&mut self, error: &ChainError, endpoint: &str) {
        if matches!(error.kind, Kind::Transport | Kind::Server) && self.down(endpoint).is_none() {
            self.tally.down.push((endpoint.to_string(), error.clone()));
        }
    }

    /// Moves to the next endpoint only on errors another node may not have.
    fn failover(&mut self, method: &str, params: &Answer) -> Result<Answer, ChainError> {
        let mut failures = vec![];
        for endpoint in self.endpoints.clone() {
            if let Some(earlier) = self.down(&endpoint) {
                failures.push(earlier.clone());
                continue;
            }
            match self.ask(&endpoint, method, params) {
                Ok(result) => return Ok(result),
                Err(e) if e.kind.retry_elsewhere() => {
                    self.note_down(&e, &endpoint);
                    failures.push(e);
                }
                Err(e) => return Err(e),
            }
        }
        Err(all_failed(failures))
    }

    /// The endpoints still worth asking in this check.
    fn live(&self) -> Vec<String> {
        self.endpoints.iter().filter(|e| self.down(e).is_none()).cloned().collect()
    }

    /// The endpoints that went down earlier in this check, as the errors they gave.
    fn earlier(&self) -> Vec<ChainError> {
        self.endpoints.iter().filter_map(|e| self.down(e)).map(|d| ChainError::new("rpc", Kind::Transport, &d.message)).collect()
    }

    /// The lowest final head among the endpoints that answer: every one of them has that block, so none can pull the
    /// check to a height the others have not reached. Heads more than `MAX_LAG_BLOCKS` apart are a disagreement: the
    /// endpoint ahead may have made its head up, the one behind may serve an old chain, and one answer cannot tell.
    fn final_height(&mut self) -> Result<u64, ChainError> {
        let before = self.earlier();
        let (mut heads, mut errors) = (vec![], vec![]);
        for endpoint in self.live() {
            let mut params = Map::new();
            params.insert("finality".into(), json!("final"));
            match self.call(&endpoint, "block", &params).and_then(|r| parse_block(&r)) {
                Ok(block) => heads.push((endpoint, block.height)),
                Err(e) => {
                    self.note_down(&e, &endpoint);
                    errors.push(e);
                }
            }
        }
        let heights = || heads.iter().map(|(_, height)| *height);
        let (Some(low), Some(top)) = (heights().min(), heights().max()) else {
            errors.extend(before);
            return Err(all_failed(errors));
        };
        if top - low > MAX_LAG_BLOCKS {
            let said: Vec<String> = heads.iter().map(|(endpoint, height)| format!("{} {height}", host_of(endpoint))).collect();
            return Err(ChainError::new("rpc", Kind::Disagree, format!("final head: {}, {} blocks apart", said.join(" vs "), top - low)));
        }
        Ok(low)
    }

    /// Every endpoint, the same read: the answer when all that answer agree, a `disagree` error when they do not.
    fn agreed(&mut self, method: &str, params: &Answer) -> Result<Answer, ChainError> {
        let live = self.live();
        let before = self.earlier();
        let mut outcomes = vec![];
        for endpoint in &live {
            let said = self.ask(endpoint, method, params).and_then(|result| fingerprint(method, params, &result).map(|print| (result, print)));
            outcomes.push(match said {
                Ok((result, print)) => Outcome::Said { endpoint: endpoint.clone(), result, print },
                Err(error) => {
                    self.note_down(&error, endpoint);
                    Outcome::Failed { endpoint: endpoint.clone(), error }
                }
            });
        }
        let answers = |o: &&Outcome| !matches!(o, Outcome::Failed { error, .. } if error.kind.retry_elsewhere());
        let sat: Vec<(&String, &ChainError)> = outcomes
            .iter()
            .filter_map(|o| match o {
                Outcome::Failed { endpoint, error } if error.kind.retry_elsewhere() => Some((endpoint, error)),
                _ => None,
            })
            .collect();
        if outcomes.iter().filter(answers).count() == 0 {
            return Err(all_failed(sat.iter().map(|(_, e)| (*e).clone()).chain(before).collect()));
        }
        let said: Vec<(&String, String)> = outcomes
            .iter()
            .filter(answers)
            .map(|o| match o {
                Outcome::Said { endpoint, print, .. } => (endpoint, print.clone()),
                Outcome::Failed { endpoint, error } => (endpoint, format!("error {}", error.kind.name())),
            })
            .collect();
        if said.iter().any(|(_, print)| *print != said[0].1) {
            let each: Vec<String> = said.iter().map(|(endpoint, print)| format!("{} {}", host_of(endpoint), short(print))).collect();
            return Err(ChainError::new("rpc", Kind::Disagree, format!("{}: {}", describe(method, params), each.join(" vs "))));
        }
        let all = self.endpoints.len();
        self.tally.reads += 1;
        if said.len() == all && all > 1 {
            self.tally.agreed += 1;
        }
        let mut missing: Vec<(String, String)> = sat.iter().map(|(endpoint, error)| ((*endpoint).clone(), error.message.clone())).collect();
        for endpoint in self.endpoints.iter().filter(|e| !live.contains(e)) {
            let why = self.down(endpoint).map(|d| d.message.clone()).unwrap_or_else(|| format!("{endpoint}: down"));
            missing.push((endpoint.clone(), why));
        }
        for (endpoint, why) in missing {
            match self.tally.missing.iter_mut().find(|(e, _)| *e == endpoint) {
                Some(seen) => seen.1 = why,
                None => self.tally.missing.push((endpoint, why)),
            }
        }
        match outcomes.into_iter().find(|o| answers(&o)) {
            Some(Outcome::Said { result, .. }) => Ok(result),
            Some(Outcome::Failed { error, .. }) => Err(error),
            None => unreachable!("an answer was counted above"),
        }
    }

    /// One endpoint; for a block it no longer keeps, the same provider's archival node.
    fn ask(&self, endpoint: &str, method: &str, params: &Answer) -> Result<Answer, ChainError> {
        match self.call(endpoint, method, params) {
            Err(e) if e.kind == Kind::UnknownBlock => match self.archival.iter().find(|(e, _)| e == endpoint) {
                Some((_, archive)) => self.call(archive, method, params),
                None => Err(e),
            },
            other => other,
        }
    }

    /// The latest final block.
    pub fn head(&mut self) -> Result<BlockInfo, ChainError> {
        let mut params = Map::new();
        params.insert("finality".into(), json!("final"));
        parse_block(&self.rpc("block", params)?)
    }

    /// A block by height; `None` when no node has it (skipped height or garbage-collected).
    pub fn block(&mut self, height: u64) -> Result<Option<BlockInfo>, ChainError> {
        let mut params = Map::new();
        params.insert("block_id".into(), json!(height));
        match self.rpc("block", params) {
            Ok(r) => parse_block(&r).map(Some),
            Err(e) if e.kind == Kind::UnknownBlock => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// The account at `at`; `None` when it does not exist there.
    pub fn account(&mut self, account_id: &str, at: At) -> Result<Option<AccountInfo>, ChainError> {
        let mut params = Map::new();
        params.insert("request_type".into(), json!("view_account"));
        params.insert("account_id".into(), json!(account_id));
        put_at(&mut params, at);
        let r = match self.rpc("query", params) {
            Ok(r) => r,
            Err(e) if e.kind == Kind::UnknownAccount => return Ok(None),
            Err(e) => return Err(e),
        };
        let (Some(amount), Some(code_hash), Some(block_height)) =
            (r.get("amount").and_then(Value::as_str), r.get("code_hash").and_then(Value::as_str), r.get("block_height").and_then(Value::as_u64))
        else {
            return Err(ChainError::new("rpc", Kind::Server, "view_account returned a wrong shape"));
        };
        let global = r.get("global_contract_hash").and_then(Value::as_str);
        Ok(Some(AccountInfo { amount: amount.to_string(), code_hash: global.unwrap_or(code_hash).to_string(), block_height }))
    }

    /// A view call; the contract's JSON answer.
    pub fn view(&mut self, contract_id: &str, method: &str, args: &Value, at: At) -> Result<Value, ChainError> {
        let mut params = Map::new();
        params.insert("request_type".into(), json!("call_function"));
        params.insert("account_id".into(), json!(contract_id));
        params.insert("method_name".into(), json!(method));
        params.insert("args_base64".into(), json!(crate::encode::base64(args.to_string().as_bytes())));
        put_at(&mut params, at);
        let r = self.rpc("query", params)?;
        let Some(bytes) = r.get("result").and_then(Value::as_array) else {
            return Err(ChainError::new("rpc", Kind::Server, format!("{method}: no result bytes")));
        };
        let bytes: Vec<u8> = bytes.iter().map(|b| b.as_u64().unwrap_or(0) as u8).collect();
        serde_json::from_str(&String::from_utf8_lossy(&bytes))
            .map_err(|_| ChainError::new("rpc", Kind::Contract, format!("{method}: the answer is not JSON")))
    }

    fn call(&self, endpoint: &str, method: &str, params: &Answer) -> Result<Answer, ChainError> {
        let body = json!({ "jsonrpc": "2.0", "id": "maskwars-check", "method": method, "params": params });
        let (status, bytes) = self.transport.post(endpoint, &body.to_string()).map_err(|why| ChainError::new(endpoint, Kind::Transport, why))?;
        let json: Value =
            serde_json::from_slice(&bytes).map_err(|_| ChainError::new(endpoint, Kind::Server, format!("HTTP {status}, invalid JSON")))?;
        if let Some(error) = json.get("error").filter(|e| truthy(e)) {
            // nearcore names every error it gives; an error without a name is the provider's own (a rate limit, a plan
            // limit, a deprecation notice), not an answer about the chain.
            let Some(name) = error.get("name").and_then(Value::as_str) else {
                let said = error.get("message").filter(|v| !v.is_null()).or_else(|| error.get("code").filter(|v| !v.is_null()));
                let said: String = said.map(plain).unwrap_or_else(|| "error".into()).chars().take(160).collect();
                return Err(ChainError::new(endpoint, Kind::Server, format!("HTTP {status}: {said}")));
            };
            let (kind, detail) = classify(name, error);
            return Err(ChainError::new(endpoint, kind, detail));
        }
        if !(200..300).contains(&status) {
            return Err(ChainError::new(endpoint, Kind::Server, format!("HTTP {status}")));
        }
        let Some(result) = json.get("result").and_then(Value::as_object) else {
            return Err(ChainError::new(endpoint, Kind::Server, "empty result"));
        };
        if let Some(message) = result.get("error").and_then(Value::as_str) {
            return Err(ChainError::new(endpoint, classify_legacy(message), message));
        }
        Ok(result.clone())
    }
}

fn put_at(params: &mut Answer, at: At) {
    match at {
        At::Final => params.insert("finality".into(), json!("final")),
        At::Height(h) => params.insert("block_id".into(), json!(h)),
    };
}

/// What JavaScript takes for true.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// A JSON value as the text a message carries.
fn plain(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(_) | Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

const SERVER_CAUSES: [&str; 5] = ["NO_SYNCED_BLOCKS", "UNAVAILABLE_SHARD", "INTERNAL_ERROR", "TIMEOUT_ERROR", "NOT_SYNCED_YET"];

fn classify(name: &str, error: &Value) -> (Kind, String) {
    let cause = error.pointer("/cause/name").and_then(Value::as_str).unwrap_or(name);
    let detail = match error.get("data").and_then(Value::as_str) {
        Some(data) => format!("{cause}: {data}"),
        None => cause.to_string(),
    };
    let kind = match cause {
        "UNKNOWN_ACCOUNT" => Kind::UnknownAccount,
        "UNKNOWN_BLOCK" | "GARBAGE_COLLECTED_BLOCK" => Kind::UnknownBlock,
        "UNKNOWN_ACCESS_KEY" => Kind::UnknownKey,
        "CONTRACT_EXECUTION_ERROR" | "NO_CONTRACT_CODE" => Kind::Contract,
        _ if SERVER_CAUSES.contains(&cause) || name == "INTERNAL_ERROR" => Kind::Server,
        _ => Kind::Handler,
    };
    (kind, detail)
}

/// Older nodes answer a failed `query` with a result that only carries an `error` string.
fn classify_legacy(message: &str) -> Kind {
    let says = |start: &str| message.strip_prefix(start).is_some_and(|rest| rest.contains(" does not exist while viewing"));
    if says("account ") {
        Kind::UnknownAccount
    } else if says("access key ") {
        Kind::UnknownKey
    } else {
        Kind::Contract
    }
}

pub fn parse_block(r: &Answer) -> Result<BlockInfo, ChainError> {
    let h = r.get("header");
    let field = |name: &str| h.and_then(|h| h.get(name));
    match (
        field("height").and_then(Value::as_u64),
        field("hash").and_then(Value::as_str),
        field("timestamp_nanosec").and_then(Value::as_str).and_then(|t| t.parse::<u64>().ok()),
    ) {
        (Some(height), Some(hash), Some(timestamp_ns)) => Ok(BlockInfo { height, hash: hash.to_string(), timestamp_ns }),
        _ => Err(ChainError::new("rpc", Kind::Server, "block returned a wrong shape")),
    }
}

/// What every endpoint failing means: an answer when none of them has the block, an outage otherwise.
fn all_failed(mut failures: Vec<ChainError>) -> ChainError {
    if !failures.is_empty() && failures.iter().all(|f| f.kind == Kind::UnknownBlock) {
        return failures.pop().expect("not empty");
    }
    let Some(outage) = failures.iter().find(|f| f.kind != Kind::UnknownBlock).or(failures.first()) else {
        return ChainError::new("rpc", Kind::Transport, "no endpoint to ask");
    };
    let all: Vec<&str> = failures.iter().map(|f| f.message.as_str()).collect();
    ChainError::new("rpc", outage.kind, format!("every endpoint failed: {}", all.join("; ")))
}

/// What two honest nodes must say alike about one read at one block: the fields the reader uses, plus the block hash,
/// so a node on another fork or another height cannot pass. Fields a newer node adds do not count.
fn fingerprint(method: &str, params: &Answer, r: &Answer) -> Result<String, ChainError> {
    let kind = if method == "query" { params.get("request_type").and_then(Value::as_str).unwrap_or("undefined") } else { method };
    let pick = |keys: &[&str]| Value::Array(keys.iter().map(|k| r.get(*k).cloned().unwrap_or(Value::Null)).collect()).to_string();
    Ok(match kind {
        "block" => {
            let b = parse_block(r)?;
            json!([b.height, b.hash, b.timestamp_ns.to_string()]).to_string()
        }
        "view_account" => {
            let code = r.get("global_contract_hash").filter(|v| !v.is_null()).or_else(|| r.get("code_hash")).cloned().unwrap_or(Value::Null);
            let field = |k: &str| r.get(k).cloned().unwrap_or(Value::Null);
            Value::Array(vec![field("block_hash"), field("amount"), field("locked"), code, field("storage_usage")]).to_string()
        }
        "call_function" => pick(&["block_hash", "result"]),
        "view_access_key" => pick(&["block_hash", "permission"]),
        _ => Value::Object(r.clone()).to_string(),
    })
}

fn describe(method: &str, params: &Answer) -> String {
    let at = params.get("block_id").and_then(Value::as_u64).map(|h| format!(" at block {h}")).unwrap_or_default();
    if method == "block" {
        return format!("block{at}");
    }
    let what: Vec<&str> = ["request_type", "account_id", "method_name"].iter().filter_map(|k| params.get(*k).and_then(Value::as_str)).collect();
    let what = what.join(" ");
    format!("{}{at}", if what.is_empty() { method } else { &what })
}

/// The host of an endpoint, with its port when it is not the scheme's own; the endpoint as it is when it is no URL.
pub fn host_of(endpoint: &str) -> String {
    let Some((scheme, rest)) = endpoint.split_once("://") else {
        return endpoint.to_string();
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = authority.rsplit('@').next().unwrap_or("").to_lowercase();
    let own = match scheme {
        "https" => ":443",
        "http" => ":80",
        _ => "\n",
    };
    host.strip_suffix(own).unwrap_or(&host).to_string()
}

fn short(print: &str) -> String {
    if print.chars().count() > 120 {
        format!("{}...", print.chars().take(117).collect::<String>())
    } else {
        print.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_host_of_an_endpoint() {
        assert_eq!(host_of("https://rpc.mainnet.fastnear.com"), "rpc.mainnet.fastnear.com");
        assert_eq!(host_of("https://Near.dRPC.org:443/path?x=1"), "near.drpc.org");
        assert_eq!(host_of("http://127.0.0.1:3030"), "127.0.0.1:3030");
        assert_eq!(host_of("rpc"), "rpc");
    }

    #[test]
    fn tells_what_an_error_is_about() {
        let e = |cause: &str| json!({ "name": "HANDLER_ERROR", "cause": { "name": cause }, "data": "why" });
        assert_eq!(classify("HANDLER_ERROR", &e("UNKNOWN_ACCOUNT")), (Kind::UnknownAccount, "UNKNOWN_ACCOUNT: why".into()));
        assert_eq!(classify("HANDLER_ERROR", &e("GARBAGE_COLLECTED_BLOCK")).0, Kind::UnknownBlock);
        assert_eq!(classify("HANDLER_ERROR", &e("NO_CONTRACT_CODE")).0, Kind::Contract);
        assert_eq!(classify("HANDLER_ERROR", &e("TIMEOUT_ERROR")).0, Kind::Server);
        assert_eq!(classify("INTERNAL_ERROR", &json!({ "name": "INTERNAL_ERROR" })), (Kind::Server, "INTERNAL_ERROR".into()));
        assert_eq!(classify("REQUEST_VALIDATION_ERROR", &e("PARSE_ERROR")).0, Kind::Handler);
        assert_eq!(classify_legacy("account a.near does not exist while viewing"), Kind::UnknownAccount);
        assert_eq!(classify_legacy("wasm execution failed with error: MethodNotFound"), Kind::Contract);
    }

    #[test]
    fn every_endpoint_failing_is_an_outage_unless_none_has_the_block() {
        let gone = |e: &str| ChainError::new(e, Kind::UnknownBlock, "UNKNOWN_BLOCK");
        assert_eq!(all_failed(vec![gone("a"), gone("b")]), gone("b"));
        let out = all_failed(vec![gone("a"), ChainError::new("b", Kind::Server, "HTTP 503")]);
        assert_eq!((out.kind, out.message.as_str()), (Kind::Server, "rpc: every endpoint failed: a: UNKNOWN_BLOCK; b: HTTP 503"));
        assert_eq!(all_failed(vec![]).message, "rpc: no endpoint to ask");
    }
}
