//! Shared C-ABI declarations for the fixture's shims.
//!
//! The symbol names are GOLDEN: `knext_ffi_v1_<fn>_<h>`, where `<h>` is the
//! 8-hex-digit FNV-1a (32-bit) of the canonical signature `sig` (README,
//! "ABI v1"), and so are the `<symbol>_schema()` values (FNV-1a 64-bit of
//! `sig` followed by every reachable record/enum's canonical form, sorted by
//! name). Both were computed independently of the macro, by a short script
//! over the README grammar, so a change to the grammar, either hash function
//! or the naming scheme fails to link (or fails `schema_values_are_golden`).
#![allow(dead_code)]

use knext_ffi_fixture as _;

pub type Out = [u64; 2];

unsafe extern "C" {
    pub fn knext_ffi_v1_free(ptr: *mut u8, len: usize);
    pub fn knext_ffi_v1_abi() -> u32;

    pub fn knext_ffi_v1_echo_i8_cdf4f152(v: i8, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_i16_3a0f121b(v: i16, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_i32_c395ed91(v: i32, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_u8_4330bed6(v: u8, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_u16_19f998df(v: u16, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_u32_bb0f9ff5(v: u32, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_i64_06384cc2(v: i64, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_u64_5289f9ce(v: u64, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_isize_3c7eb2f1(v: isize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_usize_cc728625(v: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_f32_3ce3d5ac(v: f32, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_f64_486685cb(v: f64, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_not_3febaaca(v: bool, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_add_43c960c6(a: i32, b: i32, out: *mut Out) -> i32;

    pub fn knext_ffi_v1_greet_8a119d0c(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_greet_ref_403508c6(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_string_0fd53432(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_str_len_0ef98dc4(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_concat_c0077780(
        ap: *const u8,
        al: usize,
        bp: *const u8,
        bl: usize,
        out: *mut Out,
    ) -> i32;
    pub fn knext_ffi_v1_empty_string_04c94897(out: *mut Out) -> i32;
    pub fn knext_ffi_v1_make_string_d9e63de8(n: u32, out: *mut Out) -> i32;

    pub fn knext_ffi_v1_echo_bytes_0ff3cd4c(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_sum_bytes_0620d4ae(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_bytes_len_f460e1fa(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_empty_bytes_5bca29bd(out: *mut Out) -> i32;
    pub fn knext_ffi_v1_make_bytes_0b1567ca(n: u32, out: *mut Out) -> i32;

    pub fn knext_ffi_v1_noop_0d4fe413(out: *mut Out) -> i32;
    pub fn knext_ffi_v1_unit_ret_1d8bcdfd(v: i32, out: *mut Out) -> i32;

    pub fn knext_ffi_v1_echo_point_8aec475d(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_mid_c61bad57(
        ap: *const u8,
        al: usize,
        bp: *const u8,
        bl: usize,
        out: *mut Out,
    ) -> i32;
    pub fn knext_ffi_v1_echo_vec_point_e1008be8(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_next_color_95dd2ed4(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_opt_color_d1930232(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_opt_i64_39cbdcec(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_opt_u64_1cbc2610(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_opt_string_5e5cc696(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_vec_i64_aa288515(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_vec_usize_80167490(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_echo_vec_string_4f1b32f7(p: *const u8, l: usize, out: *mut Out) -> i32;

    pub fn knext_ffi_v1_parse_i32_c4cfc8ac(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_fallible_unit_bfc26025(fail: bool, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_fallible_point_480ebe3f(
        fail: bool,
        p: *const u8,
        l: usize,
        out: *mut Out,
    ) -> i32;
    pub fn knext_ffi_v1_boom_c713b06c(p: *const u8, l: usize, out: *mut Out) -> i32;
    pub fn knext_ffi_v1_boom_static_d517f329(out: *mut Out) -> i32;
    pub fn knext_ffi_v1_boom_any_a38fce13(out: *mut Out) -> i32;

    pub fn knext_ffi_v1_add_43c960c6_schema() -> u64;
    pub fn knext_ffi_v1_noop_0d4fe413_schema() -> u64;
    pub fn knext_ffi_v1_greet_8a119d0c_schema() -> u64;
    pub fn knext_ffi_v1_echo_bytes_0ff3cd4c_schema() -> u64;
    pub fn knext_ffi_v1_echo_opt_u64_1cbc2610_schema() -> u64;
    pub fn knext_ffi_v1_echo_point_8aec475d_schema() -> u64;
    pub fn knext_ffi_v1_mid_c61bad57_schema() -> u64;
    pub fn knext_ffi_v1_echo_vec_point_e1008be8_schema() -> u64;
    pub fn knext_ffi_v1_fallible_point_480ebe3f_schema() -> u64;
    pub fn knext_ffi_v1_next_color_95dd2ed4_schema() -> u64;
    pub fn knext_ffi_v1_echo_opt_color_d1930232_schema() -> u64;
}

/// `(ptr, len)` of a borrowed slice, NULL for an empty one (what `bun:ffi`
/// sends for an empty typed array).
pub fn arg(b: &[u8]) -> (*const u8, usize) {
    if b.is_empty() {
        (std::ptr::null(), 0)
    } else {
        (b.as_ptr(), b.len())
    }
}

/// Copies the returned `(ptr, len)` buffer and frees it, as the wrapper does.
pub fn take(out: Out) -> Vec<u8> {
    if out == [0, 0] {
        return Vec::new();
    }
    let (ptr, len) = (out[0] as *mut u8, out[1] as usize);
    assert!(
        !ptr.is_null(),
        "non-empty buffer with a null pointer: {out:?}"
    );
    let v = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    unsafe { knext_ffi_v1_free(ptr, len) };
    v
}

pub fn take_string(out: Out) -> String {
    String::from_utf8(take(out)).expect("returned string is UTF-8")
}

/// Reads a scalar at offset 0 of the out slot (little-endian, native width).
pub fn scalar<T: Copy>(out: &Out) -> T {
    unsafe { std::ptr::read_unaligned(out.as_ptr() as *const T) }
}
