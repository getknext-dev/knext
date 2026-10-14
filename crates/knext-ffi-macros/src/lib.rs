//! Proc macros for `knext-ffi` (ABI v1, **Beta**). Use them through the
//! `knext-ffi` crate (`knext_ffi::export`, `knext_ffi::record`), which also
//! provides the runtime the generated code calls.
//!
//! - `#[knext_ffi::export]` on a `pub fn` emits, beside the function:
//!   an `extern "C"` shim `knext_ffi_v1_<fn>_<h>`, its
//!   `knext_ffi_v1_<fn>_<h>_schema() -> u64` companion, and an embedded
//!   manifest record (`KNEXTFFI1` + JSON + NUL).
//! - `#[knext_ffi::record]` on a struct with named fields or a unit-only enum
//!   derives the JSON encoding (serde, 64-bit integers as decimal strings),
//!   the hidden `KnextSchema` impl, and the type's manifest record.
//!
//! The contract is specified in `crates/README.md` (by reference to ADR-0069
//! D4–D7). Types outside the table are compile errors naming the type.

use proc_macro::TokenStream;

mod export;
mod record;
mod types;

/// Exports a `pub fn` to JavaScript through `bun:ffi`. See the crate docs.
#[proc_macro_attribute]
pub fn export(attr: TokenStream, item: TokenStream) -> TokenStream {
    export::expand(attr.into(), item.into()).into()
}

/// Makes a struct (named fields) or a unit-only enum usable as an argument or
/// return of an export, crossing as JSON. See the crate docs.
#[proc_macro_attribute]
pub fn record(attr: TokenStream, item: TokenStream) -> TokenStream {
    record::expand(attr.into(), item.into()).into()
}
