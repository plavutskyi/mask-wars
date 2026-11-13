//! HTTPS out of the TEE, over `wasi:http` itself: one POST with a JSON body.
//!
//! The body is written in pieces, after the request has left. `wasi:io` gives one `blocking-write-and-flush` at most `PIECE` bytes, and the host
//! ends the whole run with a trap on a longer one: no error comes back to answer with. The mind's request carries the
//! target's source, some 50 thousand bytes, so a client that writes the body in one call never reaches the model.

/// The most bytes one `blocking-write-and-flush` takes (wasi:io/streams).
pub const PIECE: usize = 4096;
/// The longest answer the module reads: an answer of the whole allowance, thinking included, is well under it.
pub const MAX_ANSWER: usize = 4 << 20;

/// A body as it is written to the request's stream: in order, whole, no piece over `PIECE`.
pub fn pieces(body: &[u8]) -> impl Iterator<Item = &[u8]> {
    body.chunks(PIECE)
}

/// One POST to `<authority><path>`, over HTTPS unless `secure` is false (a test's own server on this machine: the
/// module itself asks only cloud-api.near.ai, over HTTPS). `Ok` is the status and the answer's body; `Err` is why no answer came, with
/// the host's own error name in it (`ConnectionTimeout` and the like), which the caller reads.
#[cfg(target_os = "wasi")]
pub fn post(
    secure: bool,
    authority: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
    connect: std::time::Duration,
) -> Result<(u16, Vec<u8>), String> {
    use wasi::http::outgoing_handler;
    use wasi::http::types::{
        Fields, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme,
    };
    use wasi::io::streams::StreamError;

    let list: Vec<(String, Vec<u8>)> = headers
        .iter()
        .map(|(k, v)| (k.to_string(), v.as_bytes().to_vec()))
        .collect();
    let fields = Fields::from_list(&list).map_err(|e| format!("no request ({e:?})"))?;
    let request = OutgoingRequest::new(fields);
    request
        .set_method(&Method::Post)
        .and_then(|()| request.set_scheme(Some(if secure { &Scheme::Https } else { &Scheme::Http })))
        .and_then(|()| request.set_authority(Some(authority)))
        .and_then(|()| request.set_path_with_query(Some(path)))
        .map_err(|()| "no request (the host takes no such URL)".to_string())?;

    // The request leaves first, and its body after it: the host takes the body's bytes only once the request is on
    // its way, so a body longer than what the host holds in between would wait for ever if it were written first.
    let outgoing = request
        .body()
        .map_err(|()| "no request (the body cannot be written)".to_string())?;
    let options = RequestOptions::new();
    options
        .set_connect_timeout(Some(connect.as_nanos() as u64))
        .map_err(|()| "no request (the host takes no time limit)".to_string())?;
    let future = outgoing_handler::handle(request, Some(options))
        .map_err(|e| format!("no answer ({e:?})"))?;
    let written = (|| {
        let stream = outgoing.write().map_err(|()| "the body cannot be written".to_string())?;
        for piece in pieces(body) {
            stream
                .blocking_write_and_flush(piece)
                .map_err(|e| format!("{e:?}"))?;
        }
        Ok::<(), String>(())
    })();
    // A host that closed the body's stream has an answer or an error of its own: that is what is read next, and the
    // write's own failure is told only when there is neither.
    match &written {
        Ok(()) => OutgoingBody::finish(outgoing, None).map_err(|e| format!("no request ({e:?})"))?,
        Err(_) => drop(outgoing),
    }
    future.subscribe().block();
    let response = match (future.get(), written) {
        (Some(Ok(Ok(response))), _) => response,
        (Some(Ok(Err(e))), _) => return Err(format!("no answer ({e:?})")),
        (_, Err(why)) => return Err(format!("no request ({why})")),
        _ => return Err("no answer".into()),
    };
    drop(future);

    let status = response.status();
    let incoming = response
        .consume()
        .map_err(|()| "the answer has no body".to_string())?;
    let stream = incoming
        .stream()
        .map_err(|()| "the answer has no body".to_string())?;
    let mut out = vec![];
    loop {
        match stream.blocking_read(64 * 1024) {
            Ok(piece) => out.extend(piece),
            Err(StreamError::Closed) => break,
            Err(StreamError::LastOperationFailed(e)) => {
                return Err(format!("the answer was cut ({})", e.to_debug_string()))
            }
        }
        if out.len() > MAX_ANSWER {
            return Err("the answer is too long".into());
        }
    }
    // The stream is the body's child: it goes first.
    drop(stream);
    drop(incoming);
    Ok((status, out))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A body of any length leaves whole and in order, and no piece is longer than one write takes.
    #[test]
    fn a_body_is_written_whole_in_pieces_one_write_takes() {
        for len in [0, 1, PIECE - 1, PIECE, PIECE + 1, 3 * PIECE, 57_123] {
            let body: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
            let written: Vec<&[u8]> = pieces(&body).collect();
            assert!(written.iter().all(|p| !p.is_empty() && p.len() <= PIECE), "{len}");
            assert_eq!(written.len(), len.div_ceil(PIECE), "{len}");
            assert_eq!(written.concat(), body, "{len}");
        }
    }
}
