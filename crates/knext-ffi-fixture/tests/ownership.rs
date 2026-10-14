//! Memory ownership (README "ABI v1", ownership): no pointer to an argument
//! outlives the call, every non-empty returned buffer is one Rust allocation
//! that `knext_ffi_v1_free` releases exactly, and an empty return allocates
//! nothing. Measured with a counting global allocator, per thread (the shim
//! runs on the calling thread), so parallel tests do not disturb the counts.

mod common;
use common::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct Counting;

thread_local! {
    static LIVE_BYTES: Cell<isize> = const { Cell::new(0) };
    static ALLOCS: Cell<usize> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let _ = LIVE_BYTES.try_with(|c| c.set(c.get() + l.size() as isize));
        let _ = ALLOCS.try_with(|c| c.set(c.get() + 1));
        unsafe { System.alloc(l) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        let _ = LIVE_BYTES.try_with(|c| c.set(c.get() - l.size() as isize));
        unsafe { System.dealloc(p, l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        let _ = LIVE_BYTES.try_with(|c| c.set(c.get() - l.size() as isize + new as isize));
        let _ = ALLOCS.try_with(|c| c.set(c.get() + 1));
        unsafe { System.realloc(p, l, new) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn live() -> isize {
    LIVE_BYTES.with(|c| c.get())
}
fn allocs() -> usize {
    ALLOCS.with(|c| c.get())
}

/// Calls `f` and returns the raw out slot WITHOUT copying or freeing.
fn raw(f: impl FnOnce(&mut Out) -> i32) -> (i32, Out) {
    let mut out: Out = [0, 0];
    let st = f(&mut out);
    (st, out)
}

#[test]
fn every_returned_buffer_is_released_exactly_by_the_paired_free() {
    let name = "x".repeat(1000);
    let bytes: Vec<u8> = (0..1000u32).map(|i| i as u8).collect();
    let point = br#"{"id":"1","delta":"-1","size":"2","offset":"-2","x":1.0,"y":2.0,"small":3,"label":"l","tags":["t"],"maybe":null,"color":"Red","raw":[1],"child":null,"ids":["9"]}"#;

    let before = live();
    for _ in 0..2000 {
        let (st, out) =
            raw(|o| unsafe { knext_ffi_v1_greet_8a119d0c(name.as_ptr(), name.len(), o) });
        assert_eq!(st, 0);
        let (ptr, len) = (out[0] as *mut u8, out[1] as usize);
        assert_eq!(len, name.len() + 8);
        unsafe { knext_ffi_v1_free(ptr, len) };

        let (st, out) =
            raw(|o| unsafe { knext_ffi_v1_echo_bytes_0ff3cd4c(bytes.as_ptr(), bytes.len(), o) });
        assert_eq!(st, 0);
        unsafe { knext_ffi_v1_free(out[0] as *mut u8, out[1] as usize) };

        let (st, out) =
            raw(|o| unsafe { knext_ffi_v1_echo_point_8aec475d(point.as_ptr(), point.len(), o) });
        assert_eq!(st, 0);
        unsafe { knext_ffi_v1_free(out[0] as *mut u8, out[1] as usize) };

        // error and panic messages are freed the same way
        let (st, out) = raw(|o| unsafe { knext_ffi_v1_parse_i32_c4cfc8ac(b"x".as_ptr(), 1, o) });
        assert_eq!(st, 1);
        unsafe { knext_ffi_v1_free(out[0] as *mut u8, out[1] as usize) };
    }
    assert_eq!(
        live() - before,
        0,
        "net live bytes after 2000 x (String, Vec<u8>, record, Err) calls"
    );
}

#[test]
fn skipping_the_free_leaks_exactly_the_returned_buffer() {
    // The control for the test above: it proves the counter can see a leak.
    let name = "y".repeat(500);
    let before = live();
    let mut kept = Vec::new();
    for _ in 0..100 {
        let (st, out) =
            raw(|o| unsafe { knext_ffi_v1_greet_8a119d0c(name.as_ptr(), name.len(), o) });
        assert_eq!(st, 0);
        kept.push(out);
    }
    let leaked = live() - before - (kept.capacity() * std::mem::size_of::<Out>()) as isize;
    assert_eq!(
        leaked,
        100 * (500 + 8),
        "each un-freed return is one Box<[u8]> of exactly len bytes"
    );
    for out in kept {
        unsafe { knext_ffi_v1_free(out[0] as *mut u8, out[1] as usize) };
    }
}

#[test]
fn empty_returns_allocate_nothing_and_free_of_0_0_is_a_no_op() {
    let n = allocs();
    let before = live();
    let (st, out) = raw(|o| unsafe { knext_ffi_v1_empty_string_04c94897(o) });
    assert_eq!((st, out), (0, [0, 0]));
    let (st, out) = raw(|o| unsafe { knext_ffi_v1_empty_bytes_5bca29bd(o) });
    assert_eq!((st, out), (0, [0, 0]));
    let (st, _) = raw(|o| unsafe { knext_ffi_v1_bytes_len_f460e1fa(std::ptr::null(), 0, o) });
    assert_eq!(st, 0);
    assert_eq!(
        allocs() - n,
        0,
        "no allocation for an empty return or a borrowed empty argument"
    );
    unsafe { knext_ffi_v1_free(std::ptr::null_mut(), 0) };
    assert_eq!(live(), before);
}

#[test]
fn borrowed_arguments_are_not_copied() {
    // &str / &[u8] arguments borrow the caller's memory for the call: the
    // only allocation is the returned buffer (or none for a scalar return).
    let s = "z".repeat(1 << 16);
    let n = allocs();
    let (st, out) = raw(|o| unsafe { knext_ffi_v1_str_len_0ef98dc4(s.as_ptr(), s.len(), o) });
    assert_eq!((st, scalar::<u64>(&out)), (0, 1 << 16));
    let (st, _) = raw(|o| unsafe { knext_ffi_v1_sum_bytes_0620d4ae(s.as_ptr(), s.len(), o) });
    assert_eq!(st, 0);
    assert_eq!(allocs() - n, 0);
}
