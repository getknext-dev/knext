//! The e2e fixture zone's Rust functions, called in-process from a Server
//! Action (`src/app/knext-ffi/actions.ts`) through the generated wrapper.
//! One success path, one `Err` path and one panic path: the kind e2e asserts
//! each over HTTP and that the pod is not restarted.

/// Says hello from Rust.
#[knext_ffi::export]
pub fn greet(name: String) -> String {
    format!("Hello, {name}, from Rust!")
}

/// Like `greet`, but an empty name is an `Err` (a `RustError` in TypeScript).
#[knext_ffi::export]
pub fn checked_greet(name: String) -> Result<String, String> {
    if name.is_empty() {
        Err("name must not be empty".to_string())
    } else {
        Ok(format!("Hello, {name}, from Rust!"))
    }
}

/// Panics with `msg` (a `RustPanicError` in TypeScript; the process keeps running).
#[knext_ffi::export]
pub fn explode(msg: String) -> String {
    panic!("{msg}")
}
