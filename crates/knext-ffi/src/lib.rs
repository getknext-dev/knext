//! Runtime half of knext's in-process Rust (**Beta**): call Rust from a Bun
//! zone through `bun:ffi`, with a generated, typed `server-only` TypeScript
//! wrapper.
//!
//! You write plain Rust and annotate it:
//!
//! ```ignore
//! use knext_ffi::{export, record};
//!
//! #[record]
//! pub struct Point { pub id: u64, pub label: String }
//!
//! /// Says hello.
//! #[export]
//! pub fn greet(name: &str) -> String { format!("Hello, {name}!") }
//! ```
//!
//! `#[export]` generates an `extern "C"` shim per function and `#[record]`
//! derives the JSON encoding of a struct or unit enum; both embed a manifest
//! record in the library, from which the TypeScript wrapper is generated. The
//! ABI (version 1), the type table and the canonical strings are specified in
//! the crates' README (`crates/README.md`, by reference to ADR-0069 D4–D9).
//!
//! Everything under [`__rt`] is called by macro-generated code only and is not
//! a stable API.

#[cfg(panic = "abort")]
compile_error!(
    "knext-ffi: panic = \"abort\" is not supported. With it, a Rust panic inside an exported \
     function would kill the whole Bun process instead of reaching JavaScript as a \
     RustPanicError. Remove `panic = \"abort\"` from the profile in your Cargo.toml."
);

#[cfg(not(target_pointer_width = "64"))]
compile_error!("knext-ffi: ABI v1 supports 64-bit targets only (usize and isize are 64-bit).");

#[cfg(not(target_endian = "little"))]
compile_error!("knext-ffi: ABI v1 supports little-endian targets only.");

pub use knext_ffi_macros::{export, record};
pub use serde;
pub use serde_json;

pub mod wire;

/// The ABI version every `knext_ffi_v1_*` symbol belongs to.
pub const ABI_VERSION: u32 = 1;

/// Shim status: the call returned normally.
pub const STATUS_OK: i32 = 0;
/// Shim status: the function returned `Err(e)`; the out slot holds `e.to_string()`.
pub const STATUS_ERR: i32 = 1;
/// Shim status: the function panicked; the out slot holds the panic message.
pub const STATUS_PANIC: i32 = 2;
/// Shim status: an argument could not be decoded (bad UTF-8 or JSON), or a
/// JSON return value cannot be encoded (a non-finite float); the message names
/// the argument or the path in the result.
pub const STATUS_INVALID_INPUT: i32 = 3;

/// Frees a buffer a shim returned in its out slot (`out[0]` = pointer,
/// `out[1]` = length). The generated wrapper calls it exactly once per
/// non-empty buffer, after copying the bytes. `(NULL, 0)` is a no-op.
///
/// # Safety
/// `ptr`/`len` must be exactly a pair a knext-ffi shim returned, not yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn knext_ffi_v1_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
}

/// The ABI version of this library: always 1 for `knext_ffi_v1_*` symbols.
#[unsafe(no_mangle)]
pub extern "C" fn knext_ffi_v1_abi() -> u32 {
    ABI_VERSION
}

#[doc(hidden)]
pub mod __rt {
    use crate::wire::Wire;
    use std::any::Any;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    pub use crate::{STATUS_ERR, STATUS_INVALID_INPUT, STATUS_OK, STATUS_PANIC};

    /// The caller-owned, 16-byte, 8-byte-aligned out slot.
    pub type Out = *mut [u64; 2];

    /// An argument that could not be decoded: status 3.
    pub struct Invalid(pub String);

    /// How a successful return value is written into the out slot. `Err` is
    /// a value that cannot cross (a non-finite float inside JSON): status 3,
    /// with the out slot holding its message instead.
    pub trait Lower {
        /// # Safety
        /// `out` must point to a writable `[u64; 2]`.
        unsafe fn lower(self, out: Out) -> Result<(), Invalid>;
    }

    macro_rules! by_value {
        ($($t:ty),*) => {$(
            impl Lower for $t {
                #[inline(always)]
                unsafe fn lower(self, out: Out) -> Result<(), Invalid> {
                    unsafe { std::ptr::write_unaligned(out as *mut $t, self) };
                    Ok(())
                }
            }
        )*};
    }
    // `bool` is one byte (0 or 1) at offset 0.
    by_value!(i8, i16, i32, i64, isize, u8, u16, u32, u64, usize, f32, f64, bool);

    impl Lower for () {
        #[inline(always)]
        unsafe fn lower(self, _out: Out) -> Result<(), Invalid> {
            Ok(())
        }
    }
    impl Lower for String {
        #[inline(always)]
        unsafe fn lower(self, out: Out) -> Result<(), Invalid> {
            unsafe { write_buf(out, self.into_bytes()) };
            Ok(())
        }
    }
    impl Lower for Vec<u8> {
        #[inline(always)]
        unsafe fn lower(self, out: Out) -> Result<(), Invalid> {
            unsafe { write_buf(out, self) };
            Ok(())
        }
    }

    /// A return value that crosses as JSON (records, enums, Option, Vec<T≠u8>).
    pub struct Json<T>(pub T);
    impl<T: Wire> Lower for Json<T> {
        unsafe fn lower(self, out: Out) -> Result<(), Invalid> {
            let mut buf = Vec::new();
            let mut ser = serde_json::Serializer::new(&mut buf);
            self.0
                .ser(&mut ser)
                .map_err(|e| crate::wire::at("result", e))
                .map_err(|e| {
                    Invalid(format!(
                        "knext-ffi: the return value cannot cross as JSON: {e}"
                    ))
                })?;
            unsafe { write_buf(out, buf) };
            Ok(())
        }
    }

    /// Hands `v` to the caller as a `Box<[u8]>` `(ptr, len)`; `(0, 0)` and no
    /// allocation for an empty value.
    ///
    /// # Safety
    /// `out` must point to a writable `[u64; 2]`.
    #[inline(always)]
    pub unsafe fn write_buf(out: Out, v: Vec<u8>) {
        if v.is_empty() {
            unsafe { *out = [0, 0] };
            return;
        }
        let b: Box<[u8]> = v.into_boxed_slice();
        let len = b.len();
        let ptr = Box::into_raw(b) as *mut u8;
        unsafe { *out = [ptr as u64, len as u64] };
    }

    /// A borrowed byte argument. A NULL pointer is legal when `len == 0`
    /// (`bun:ffi` passes an empty typed array as NULL); it never reaches
    /// `slice::from_raw_parts`, which would be undefined behaviour.
    ///
    /// # Safety
    /// Unless `len == 0`, `ptr` must be valid for `len` bytes for the call.
    #[inline(always)]
    pub unsafe fn bytes_arg<'a>(ptr: *const u8, len: usize) -> &'a [u8] {
        if len == 0 {
            &[]
        } else {
            unsafe { std::slice::from_raw_parts(ptr, len) }
        }
    }

    /// A borrowed UTF-8 argument; bad UTF-8 is status 3.
    ///
    /// # Safety
    /// As [`bytes_arg`].
    #[inline(always)]
    pub unsafe fn str_arg<'a>(ptr: *const u8, len: usize, name: &str) -> Result<&'a str, Invalid> {
        std::str::from_utf8(unsafe { bytes_arg(ptr, len) }).map_err(|e| {
            Invalid(format!(
                "knext-ffi: argument `{name}` is not valid UTF-8: {e}"
            ))
        })
    }

    /// A JSON argument (record, enum, Option, Vec<T≠u8>); malformed JSON,
    /// trailing data or a value that does not match the type is status 3.
    ///
    /// # Safety
    /// As [`bytes_arg`].
    pub unsafe fn json_arg<T: Wire>(ptr: *const u8, len: usize, name: &str) -> Result<T, Invalid> {
        let bytes = unsafe { bytes_arg(ptr, len) };
        let mut de = serde_json::Deserializer::from_slice(bytes);
        T::de(&mut de)
            .and_then(|v| de.end().map(|()| v))
            .map_err(|e| {
                Invalid(format!(
                    "knext-ffi: argument `{name}` could not be decoded: {e}"
                ))
            })
    }

    fn panic_message(p: &(dyn Any + Send)) -> String {
        if let Some(s) = p.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = p.downcast_ref::<String>() {
            s.clone()
        } else {
            "panic with a non-string payload".to_string()
        }
    }

    /// Runs a shim body under `catch_unwind` and writes the outcome. Never
    /// unwinds: a panic becomes status 2 with its message, and dropping the
    /// payload is itself guarded.
    ///
    /// # Safety
    /// `out` must point to a writable `[u64; 2]`.
    #[inline(always)]
    pub unsafe fn call<R: Lower, F>(out: Out, f: F) -> i32
    where
        F: FnOnce() -> Result<Result<R, String>, Invalid>,
    {
        let r = catch_unwind(AssertUnwindSafe(move || match f() {
            Ok(Ok(v)) => match unsafe { v.lower(out) } {
                Ok(()) => STATUS_OK,
                Err(Invalid(msg)) => {
                    unsafe { write_buf(out, msg.into_bytes()) };
                    STATUS_INVALID_INPUT
                }
            },
            Ok(Err(msg)) => {
                unsafe { write_buf(out, msg.into_bytes()) };
                STATUS_ERR
            }
            Err(Invalid(msg)) => {
                unsafe { write_buf(out, msg.into_bytes()) };
                STATUS_INVALID_INPUT
            }
        }));
        match r {
            Ok(status) => status,
            Err(payload) => {
                let msg = panic_message(&*payload);
                let _ = catch_unwind(AssertUnwindSafe(move || drop(payload)));
                unsafe { write_buf(out, msg.into_bytes()) };
                STATUS_PANIC
            }
        }
    }

    // ---- schema hashing -------------------------------------------------------

    /// The canonical schema of a `#[knext_ffi::record]` type, as its
    /// `KnextSchema` const: `Name{field:tok,…}` or `Name[A|B]`, and the
    /// records/enums its fields name.
    pub struct Schema {
        pub name: &'static str,
        /// `"record"` or `"enum"`, as in the manifest type descriptor.
        pub kind: &'static str,
        pub canon: &'static str,
        pub deps: &'static [&'static Schema],
    }

    /// Implemented by `#[knext_ffi::record]` for each struct and unit enum.
    #[diagnostic::on_unimplemented(
        message = "`{Self}` is not a #[knext_ffi::record] type",
        label = "an exported function can only name records and unit enums declared with #[knext_ffi::record]",
        note = "add #[knext_ffi::record] to `{Self}`; supported types are listed at https://knext-platform.dev/docs/rust-in-process#type-mapping"
    )]
    pub trait KnextSchema: Wire {
        const SCHEMA: &'static Schema;
    }

    /// The most records/enums one export can reach (a compile error beyond).
    pub const MAX_SCHEMAS: usize = 256;

    const FNV64_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV64_PRIME: u64 = 0x0000_0100_0000_01b3;

    const fn fnv64(mut h: u64, s: &str) -> u64 {
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            h ^= b[i] as u64;
            h = h.wrapping_mul(FNV64_PRIME);
            i += 1;
        }
        h
    }

    const fn str_eq(a: &str, b: &str) -> bool {
        let (a, b) = (a.as_bytes(), b.as_bytes());
        if a.len() != b.len() {
            return false;
        }
        let mut i = 0;
        while i < a.len() {
            if a[i] != b[i] {
                return false;
            }
            i += 1;
        }
        true
    }

    /// Byte-wise `a < b`.
    const fn str_lt(a: &str, b: &str) -> bool {
        let (a, b) = (a.as_bytes(), b.as_bytes());
        let mut i = 0;
        while i < a.len() && i < b.len() {
            if a[i] != b[i] {
                return a[i] < b[i];
            }
            i += 1;
        }
        a.len() < b.len()
    }

    /// FNV-1a (64-bit) of `sig` followed by the canonical form of every
    /// record/enum reachable from `roots` (transitively, deduplicated by
    /// name, sorted by name byte-wise), with no separators. Const-evaluated
    /// into each export's `<symbol>_schema()`.
    pub const fn schema_hash(sig: &str, roots: &[&'static Schema]) -> u64 {
        let mut seen: [Option<&'static Schema>; MAX_SCHEMAS] = [None; MAX_SCHEMAS];
        let mut n = 0;
        let mut stack: [Option<&'static Schema>; MAX_SCHEMAS] = [None; MAX_SCHEMAS];
        let mut sp = 0;
        let mut r = 0;
        while r < roots.len() {
            assert!(
                sp < MAX_SCHEMAS,
                "knext-ffi: too many record types reachable from one export"
            );
            stack[sp] = Some(roots[r]);
            sp += 1;
            r += 1;
        }
        while sp > 0 {
            sp -= 1;
            let s = match stack[sp] {
                Some(s) => s,
                None => panic!("unreachable"),
            };
            let mut dup = false;
            let mut i = 0;
            while i < n {
                let o = match seen[i] {
                    Some(o) => o,
                    None => panic!("unreachable"),
                };
                if str_eq(o.name, s.name) {
                    assert!(
                        str_eq(o.canon, s.canon),
                        "knext-ffi: two different record types with the same name are reachable from one export; record names must be unique in a library"
                    );
                    dup = true;
                }
                i += 1;
            }
            if dup {
                continue;
            }
            assert!(
                n < MAX_SCHEMAS,
                "knext-ffi: too many record types reachable from one export"
            );
            seen[n] = Some(s);
            n += 1;
            let mut d = 0;
            while d < s.deps.len() {
                assert!(
                    sp < MAX_SCHEMAS,
                    "knext-ffi: too many record types reachable from one export"
                );
                stack[sp] = Some(s.deps[d]);
                sp += 1;
                d += 1;
            }
        }
        // insertion sort by name
        let mut i = 1;
        while i < n {
            let mut j = i;
            while j > 0 {
                let (a, b) = match (seen[j - 1], seen[j]) {
                    (Some(a), Some(b)) => (a, b),
                    _ => panic!("unreachable"),
                };
                if str_lt(b.name, a.name) {
                    seen[j - 1] = Some(b);
                    seen[j] = Some(a);
                    j -= 1;
                } else {
                    break;
                }
            }
            i += 1;
        }
        let mut h = fnv64(FNV64_OFFSET, sig);
        let mut k = 0;
        while k < n {
            if let Some(s) = seen[k] {
                h = fnv64(h, s.canon);
            }
            k += 1;
        }
        h
    }

    // ---- manifest assembly ------------------------------------------------------

    /// Total length of a manifest record's pieces.
    pub const fn pieces_len(p: &[&str]) -> usize {
        let mut n = 0;
        let mut i = 0;
        while i < p.len() {
            n += p[i].len();
            i += 1;
        }
        n
    }

    /// Concatenates a manifest record's pieces at compile time.
    pub const fn pieces_concat<const N: usize>(p: &[&str]) -> [u8; N] {
        let mut out = [0u8; N];
        let mut k = 0;
        let mut i = 0;
        while i < p.len() {
            let b = p[i].as_bytes();
            let mut j = 0;
            while j < b.len() {
                out[k] = b[j];
                k += 1;
                j += 1;
            }
            i += 1;
        }
        assert!(k == N, "knext-ffi: manifest length mismatch");
        out
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn fnv64_str(s: &str) -> u64 {
            fnv64(FNV64_OFFSET, s)
        }

        #[test]
        fn fnv64_matches_the_reference_vectors() {
            assert_eq!(fnv64_str(""), 0xcbf29ce484222325);
            assert_eq!(fnv64_str("a"), 0xaf63dc4c8601ec8c);
            assert_eq!(fnv64_str("foobar"), 0x85944171f73967e8);
        }

        // Three records, C two levels below A: A{b:B} -> B{c:vec<C>} -> C{x:...}
        static C1: Schema = Schema {
            name: "C",
            kind: "record",
            canon: "C{x:u64}",
            deps: &[],
        };
        static C2: Schema = Schema {
            name: "C",
            kind: "record",
            canon: "C{x:i64}",
            deps: &[],
        };
        static C3: Schema = Schema {
            name: "C",
            kind: "record",
            canon: "C{y:u64}",
            deps: &[],
        };
        static B1: Schema = Schema {
            name: "B",
            kind: "record",
            canon: "B{c:vec<C>}",
            deps: &[&C1],
        };
        static B2: Schema = Schema {
            name: "B",
            kind: "record",
            canon: "B{c:vec<C>}",
            deps: &[&C2],
        };
        static B3: Schema = Schema {
            name: "B",
            kind: "record",
            canon: "B{c:vec<C>}",
            deps: &[&C3],
        };
        static A1: Schema = Schema {
            name: "A",
            kind: "record",
            canon: "A{b:B}",
            deps: &[&B1],
        };
        static A2: Schema = Schema {
            name: "A",
            kind: "record",
            canon: "A{b:B}",
            deps: &[&B2],
        };
        static A3: Schema = Schema {
            name: "A",
            kind: "record",
            canon: "A{b:B}",
            deps: &[&B3],
        };

        #[test]
        fn a_field_two_records_deep_changes_the_schema_hash() {
            let sig = "f(A)->u64";
            let h1 = schema_hash(sig, &[&A1]);
            assert_eq!(h1, fnv64_str("f(A)->u64A{b:B}B{c:vec<C>}C{x:u64}"));
            assert_ne!(h1, schema_hash(sig, &[&A2]), "retyping C.x");
            assert_ne!(h1, schema_hash(sig, &[&A3]), "renaming C.x");
        }

        #[test]
        fn schemas_are_deduplicated_and_sorted_by_name() {
            static E: Schema = Schema {
                name: "E",
                kind: "enum",
                canon: "E[X|Y]",
                deps: &[],
            };
            static Z: Schema = Schema {
                name: "Z",
                kind: "record",
                canon: "Z{e:E,a:A}",
                deps: &[&E, &A1],
            };
            let h = schema_hash("g(Z,E)->A", &[&Z, &E, &A1]);
            assert_eq!(
                h,
                fnv64_str("g(Z,E)->AA{b:B}B{c:vec<C>}C{x:u64}E[X|Y]Z{e:E,a:A}")
            );
            assert_eq!(schema_hash("noop()->unit", &[]), fnv64_str("noop()->unit"));
        }
    }
}
