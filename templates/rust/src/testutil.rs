//! Helpers shared by the unit tests.

/// The value of `name` in the trailer frame of a gRPC-Web response body
/// (a frame whose flag byte has the 0x80 bit set carries the trailers as
/// HTTP/1-style header lines).
pub fn grpc_web_trailer(body: &[u8], name: &str) -> Option<String> {
    let mut rest = body;
    while rest.len() >= 5 {
        let flag = rest[0];
        let len = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
        let frame = rest.get(5..5 + len)?;
        if flag & 0x80 != 0 {
            let text = std::str::from_utf8(frame).ok()?;
            return text.split("\r\n").find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.trim()
                    .eq_ignore_ascii_case(name)
                    .then(|| value.trim().to_owned())
            });
        }
        rest = &rest[5 + len..];
    }
    None
}
