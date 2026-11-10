// OutLayer entry: the call's input as JSON on stdin, `{ success, output, error }` on stdout. The check is the library
// (lib.rs); this file only gives it the run's facts and HTTPS. The module needs nothing else of the host: it imports
// WASI and `wasi:http` alone, so the same file runs under any WASI Preview 2 runtime.

/// The manifest OutLayer reads from the wasm itself, covered by the wasm's sha256: the project's signing seed joins
/// every run from the author's secrets, and the module reaches only the five NEAR RPC hosts it names. OutLayer gives
/// each request ten seconds; the module ends a request sooner itself (src/http.rs).
#[cfg(target_os = "wasi")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

#[cfg(target_os = "wasi")]
fn main() {
    use maskwars_check::http::Https;
    use maskwars_check::{answer, Run};
    use std::io::{Read, Write};
    use std::time::{SystemTime, UNIX_EPOCH};

    // An input is an account id and two short fields: 4 KiB is far more than any takes.
    let mut raw = String::new();
    let _ = std::io::stdin().take(4096).read_to_string(&mut raw);
    let input = serde_json::from_str::<serde_json::Value>(&raw).ok();
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    // What the call paid and how it arrived are OutLayer's words, read in one place: `Run::from_env`.
    let run = Run::from_env(|name| std::env::var(name).ok(), now_ms);
    let out = answer(input, &run, &Https);
    let _ = std::io::stdout().write_all(serde_json::to_string(&out).unwrap_or_default().as_bytes());
}

#[cfg(not(target_os = "wasi"))]
fn main() {
    eprintln!("maskwars-check runs on OutLayer: build with services/check/build.sh");
    std::process::exit(1);
}
