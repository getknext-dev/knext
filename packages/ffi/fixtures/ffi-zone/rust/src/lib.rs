//! The e2e fixture zone's Rust functions, called in-process from a Server
//! Action (`src/app/rust-ffi/actions.ts`) through the generated wrapper.
//! One success path, one `Err` path, one panic path and one slow call: the
//! kind e2e asserts each over HTTP, that the pod is not restarted, and that the
//! slow call is counted on the metrics port.

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

/// Sleeps `ms` milliseconds, then returns it: a deliberately blocking call,
/// so the e2e can see it counted as a slow call on the metrics port.
#[knext_ffi::export]
pub fn pause(ms: u32) -> u32 {
    std::thread::sleep(std::time::Duration::from_millis(u64::from(ms)));
    ms
}
