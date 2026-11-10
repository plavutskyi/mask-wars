// HTTPS from inside the TEE, over `wasi:http` alone: one POST with a JSON body. The connection to an RPC provider
// ends in the enclave, not at OutLayer's edge.
//
// Every wait of a request has its own limit, set on the request itself (`wasi:http` request options) and not left to
// the host's default of ten minutes: a provider that takes the connection and then says nothing must cost a few
// seconds, not the run. The reader does not ask a node again once it failed this way (rpc.rs), so a hung provider
// costs one request.

use std::time::Duration;

/// Until the connection is made.
pub const CONNECT: Duration = Duration::from_secs(3);
/// From the request to the first byte of the answer.
pub const FIRST_BYTE: Duration = Duration::from_secs(5);
/// Between two pieces of the answer.
pub const BETWEEN_BYTES: Duration = Duration::from_secs(3);
/// The whole request, from its start to the last byte: an answer that keeps trickling is cut here.
pub const WHOLE: Duration = Duration::from_secs(8);

/// What the manifest must give a host at least (`timeout_secs`): OutLayer's own timer runs over the connection and
/// the first byte, and a request it has to cut counts against the run (two of them end it). With more than
/// `CONNECT + FIRST_BYTE` the module's limits are reached first and a slow node is only a node that is down.
pub const HOST_TIMEOUT_FLOOR: Duration = Duration::from_secs(CONNECT.as_secs() + FIRST_BYTE.as_secs() + 1);

/// An endpoint in the three parts a request is made of: whether it is HTTPS, the authority, the path with its query.
/// `None` for anything that is not an http or https URL with a host.
pub fn split(url: &str) -> Option<(bool, &str, &str)> {
    let (https, rest) = match (url.strip_prefix("https://"), url.strip_prefix("http://")) {
        (Some(rest), _) => (true, rest),
        (_, Some(rest)) => (false, rest),
        _ => return None,
    };
    let rest = rest.split('#').next().unwrap_or("");
    let cut = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(cut);
    // The module's endpoints are fixed in it; this takes their shape and no other: a host, then nothing or a path.
    let ok = !authority.is_empty() && !authority.contains('@') && !url.chars().any(char::is_whitespace) && !path.starts_with('?');
    ok.then_some((https, authority, if path.is_empty() { "/" } else { path }))
}

#[cfg(target_os = "wasi")]
pub use on_wasi::Https;

#[cfg(target_os = "wasi")]
mod on_wasi {
    use super::{split, BETWEEN_BYTES, CONNECT, FIRST_BYTE, WHOLE};
    use crate::rpc::{Transport, MAX_BODY};
    use std::time::Instant;
    use wasi::http::outgoing_handler;
    use wasi::http::types::{Fields, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme};
    use wasi::io::streams::StreamError;

    pub struct Https;

    impl Transport for Https {
        fn post(&self, url: &str, body: &str) -> Result<(u16, Vec<u8>), String> {
            let started = Instant::now();
            let (https, authority, path) = split(url).ok_or("not an http(s) URL")?;
            let headers = Fields::from_list(&[
                ("content-type".to_string(), b"application/json".to_vec()),
                ("user-agent".to_string(), b"maskwars-check".to_vec()),
            ])
            .map_err(|e| format!("no request ({e:?})"))?;
            let request = OutgoingRequest::new(headers);
            let built = request
                .set_method(&Method::Post)
                .and_then(|()| request.set_scheme(Some(if https { &Scheme::Https } else { &Scheme::Http })))
                .and_then(|()| request.set_authority(Some(authority)))
                .and_then(|()| request.set_path_with_query(Some(path)));
            built.map_err(|()| "no request (the endpoint is not a URL the host takes)".to_string())?;

            let outgoing = request.body().map_err(|()| "no request (the body cannot be written)".to_string())?;
            {
                let stream = outgoing.write().map_err(|()| "no request (the body cannot be written)".to_string())?;
                // One blocking write takes 4096 bytes at most.
                for piece in body.as_bytes().chunks(4096) {
                    stream.blocking_write_and_flush(piece).map_err(|e| format!("no request ({e:?})"))?;
                }
            }
            OutgoingBody::finish(outgoing, None).map_err(|e| format!("no request ({e:?})"))?;

            let nanos = |d: std::time::Duration| Some(d.as_nanos() as u64);
            let options = RequestOptions::new();
            let limits = options
                .set_connect_timeout(nanos(CONNECT))
                .and_then(|()| options.set_first_byte_timeout(nanos(FIRST_BYTE)))
                .and_then(|()| options.set_between_bytes_timeout(nanos(BETWEEN_BYTES)));
            limits.map_err(|()| "no request (the host takes no time limits)".to_string())?;

            let future = outgoing_handler::handle(request, Some(options)).map_err(|e| format!("no answer ({e:?})"))?;
            future.subscribe().block();
            let response = match future.get() {
                Some(Ok(Ok(response))) => response,
                Some(Ok(Err(e))) => return Err(format!("no answer ({e:?})")),
                _ => return Err("no answer".into()),
            };
            drop(future);

            let status = response.status();
            let incoming = response.consume().map_err(|()| "the answer has no body".to_string())?;
            let stream = incoming.stream().map_err(|()| "the answer has no body".to_string())?;
            let mut out = vec![];
            loop {
                match stream.blocking_read(64 * 1024) {
                    Ok(piece) => out.extend(piece),
                    Err(StreamError::Closed) => break,
                    Err(StreamError::LastOperationFailed(_)) => return Err("the answer was cut".into()),
                }
                if out.len() > MAX_BODY {
                    return Err("the answer is too long".into());
                }
                if started.elapsed() > WHOLE {
                    return Err("the answer took too long".into());
                }
            }
            // The stream is the body's child: it goes first.
            drop(stream);
            drop(incoming);
            Ok((status, out))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::{Network, MAINNET_ARCHIVAL};
    use serde_json::Value;

    #[test]
    fn splits_an_endpoint_into_what_a_request_is_made_of() {
        assert_eq!(split("https://rpc.mainnet.fastnear.com"), Some((true, "rpc.mainnet.fastnear.com", "/")));
        assert_eq!(split("https://near.drpc.org/"), Some((true, "near.drpc.org", "/")));
        assert_eq!(split("http://127.0.0.1:3030/rpc?key=1#top"), Some((false, "127.0.0.1:3030", "/rpc?key=1")));
        for not_an_endpoint in [
            "rpc.mainnet.fastnear.com",
            "ftp://a.example",
            "https://",
            "https:///path",
            "https://user@a.example",
            "https://a.example?x=1",
            "https://a b",
        ] {
            assert_eq!(split(not_an_endpoint), None, "{not_an_endpoint}");
        }
    }

    /// Every endpoint the module can reach is in the manifest, nothing else is, and each has more time from OutLayer
    /// than the module gives itself: its own limits are reached first.
    #[test]
    fn the_manifest_names_exactly_the_modules_endpoints_and_gives_each_enough_time() {
        let manifest: Value = serde_json::from_str(include_str!("../manifest.json")).unwrap();
        let mut named = vec![];
        for entry in manifest["capabilities"]["network"].as_array().unwrap() {
            let secs = entry["timeout_secs"].as_u64().expect("every host has its time");
            assert!(secs >= HOST_TIMEOUT_FLOOR.as_secs(), "{entry}");
            named.push(entry["host"].as_str().unwrap().to_string());
        }
        let mut reached: Vec<String> = [Network::Mainnet, Network::Testnet]
            .iter()
            .flat_map(|n| n.rpc().iter().copied())
            .chain(MAINNET_ARCHIVAL.iter().map(|(_, archive)| *archive))
            .map(|endpoint| split(endpoint).map(|(https, host, path)| (https, host.to_string(), path)).expect("an endpoint is a URL"))
            .map(|(https, host, path)| {
                assert!(https && path == "/", "{host}");
                host
            })
            .collect();
        named.sort();
        reached.sort();
        assert_eq!(named, reached);
        assert!(WHOLE >= FIRST_BYTE && BETWEEN_BYTES <= WHOLE);
    }
}
