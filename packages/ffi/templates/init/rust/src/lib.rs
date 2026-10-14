//! Functions this zone calls in-process from TypeScript (Beta, Bun only).
//!
//! Mark a `pub fn` with `#[knext_ffi::export]`, then run `knext ffi generate`:
//! it builds this crate and writes a typed, server-only wrapper. Keep each call
//! short (well under a millisecond on the request path): it blocks the server
//! while it runs.

/// Says hello.
#[knext_ffi::export]
pub fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}
