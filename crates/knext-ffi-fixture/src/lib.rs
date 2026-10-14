//! Test fixture for knext-ffi: one export per row of the type table (argument
//! and return), plus the error, panic and leak-check exports. Built as a cdylib
//! for the Bun harness (`crates/harness/ffi-harness.ts`) and as an rlib for the
//! Rust ABI tests (`tests/abi.rs`), which call the generated shims exactly as
//! `bun:ffi` does.
//!
//! Records live in a private module and are glob-imported, which is the
//! documented way to use a record from another module (README, "Records").

mod types {
    use knext_ffi::record;

    /// A point with every JSON field kind.
    #[record]
    #[derive(Debug, Clone, PartialEq)]
    pub struct Point {
        /// 64-bit: crosses as a decimal string.
        pub id: u64,
        pub delta: i64,
        pub size: usize,
        pub offset: isize,
        pub x: f64,
        pub y: f32,
        pub small: u8,
        pub label: String,
        pub tags: Vec<String>,
        pub maybe: Option<i64>,
        pub color: Color,
        pub raw: Vec<u8>,
        pub child: Option<Child>,
        pub ids: Vec<u64>,
        /// 64-bit inside an Option: a decimal string or null.
        pub count: Option<usize>,
        /// 64-bit inside an Option inside a Vec: decimal strings and nulls.
        pub deltas: Vec<Option<i64>>,
    }

    /// A unit enum crosses as its variant name.
    #[record]
    #[derive(Debug, Clone, Copy, PartialEq)]
    pub enum Color {
        Red,
        Green,
        Blue,
    }

    #[record]
    #[derive(Debug, Clone, PartialEq)]
    pub struct Child {
        pub name: String,
        pub flag: bool,
    }
}

pub use types::*;

use knext_ffi::export;

// ---- integers, floats and bool, by value -------------------------------------

#[export]
pub fn echo_i8(v: i8) -> i8 {
    v
}
#[export]
pub fn echo_i16(v: i16) -> i16 {
    v
}
#[export]
pub fn echo_i32(v: i32) -> i32 {
    v
}
#[export]
pub fn echo_u8(v: u8) -> u8 {
    v
}
#[export]
pub fn echo_u16(v: u16) -> u16 {
    v
}
#[export]
pub fn echo_u32(v: u32) -> u32 {
    v
}
#[export]
pub fn echo_i64(v: i64) -> i64 {
    v
}
#[export]
pub fn echo_u64(v: u64) -> u64 {
    v
}
#[export]
pub fn echo_isize(v: isize) -> isize {
    v
}
#[export]
pub fn echo_usize(v: usize) -> usize {
    v
}
#[export]
pub fn echo_f32(v: f32) -> f32 {
    v
}
#[export]
pub fn echo_f64(v: f64) -> f64 {
    v
}
#[export]
pub fn not(v: bool) -> bool {
    !v
}
/// Adds two numbers, wrapping on overflow.
#[export]
pub fn add(a: i32, b: i32) -> i32 {
    a.wrapping_add(b)
}

// ---- strings -----------------------------------------------------------------

/// Says hello.
#[export]
pub fn greet(name: String) -> String {
    format!("Hello, {name}!")
}
#[export]
pub fn greet_ref(name: &str) -> String {
    format!("Hello, {name}!")
}
#[export]
pub fn echo_string(s: String) -> String {
    s
}
#[export]
pub fn str_len(s: &str) -> u64 {
    s.len() as u64
}
/// Two string arguments: the harness passes two large ones to force the
/// wrapper's scratch buffer to grow between them.
#[export]
pub fn concat(a: &str, b: String) -> String {
    let mut s = String::with_capacity(a.len() + b.len());
    s.push_str(a);
    s.push_str(&b);
    s
}
#[export]
pub fn empty_string() -> String {
    String::new()
}
#[export]
pub fn make_string(n: u32) -> String {
    "x".repeat(n as usize)
}

// ---- bytes -------------------------------------------------------------------

#[export]
pub fn echo_bytes(b: Vec<u8>) -> Vec<u8> {
    b
}
#[export]
pub fn sum_bytes(b: &[u8]) -> u64 {
    b.iter().map(|&x| x as u64).sum()
}
#[export]
pub fn bytes_len(b: &[u8]) -> u64 {
    b.len() as u64
}
#[export]
pub fn empty_bytes() -> Vec<u8> {
    Vec::new()
}
#[export]
pub fn make_bytes(n: u32) -> Vec<u8> {
    (0..n).map(|i| i as u8).collect()
}

// ---- unit --------------------------------------------------------------------

#[export]
pub fn noop() {}
#[export]
pub fn unit_ret(_v: i32) {}

// ---- records, enums, Option, Vec (JSON) --------------------------------------

#[export]
pub fn echo_point(p: Point) -> Point {
    p
}
/// The midpoint of two points; the label and tags come from `a`.
#[export]
pub fn mid(a: Point, b: Point) -> Point {
    Point {
        x: (a.x + b.x) / 2.0,
        y: (a.y + b.y) / 2.0,
        ..a
    }
}
#[export]
pub fn next_color(c: Color) -> Color {
    match c {
        Color::Red => Color::Green,
        Color::Green => Color::Blue,
        Color::Blue => Color::Red,
    }
}
#[export]
pub fn echo_opt_i64(v: Option<i64>) -> Option<i64> {
    v
}
#[export]
pub fn echo_opt_u64(v: Option<u64>) -> Option<u64> {
    v
}
#[export]
pub fn echo_opt_string(v: Option<String>) -> Option<String> {
    v
}
#[export]
pub fn echo_vec_point(v: Vec<Point>) -> Vec<Point> {
    v
}
#[export]
pub fn echo_vec_i64(v: Vec<i64>) -> Vec<i64> {
    v
}
#[export]
pub fn echo_vec_usize(v: Vec<usize>) -> Vec<usize> {
    v
}
#[export]
pub fn echo_vec_string(v: Vec<String>) -> Vec<String> {
    v
}
#[export]
pub fn echo_opt_color(v: Option<Color>) -> Option<Color> {
    v
}

// ---- Result, panics ----------------------------------------------------------

/// Parses a decimal i32.
#[export]
pub fn parse_i32(s: &str) -> Result<i32, std::num::ParseIntError> {
    s.trim().parse()
}
#[export]
pub fn fallible_unit(fail: bool) -> Result<(), String> {
    if fail {
        Err("failed on purpose".to_string())
    } else {
        Ok(())
    }
}
#[export]
pub fn fallible_point(fail: bool, p: Point) -> Result<Point, String> {
    if fail {
        Err(format!("no point for {}", p.label))
    } else {
        Ok(p)
    }
}
#[export]
pub fn boom(msg: &str) -> String {
    panic!("{msg}")
}
#[export]
pub fn boom_static() -> i32 {
    panic!("static boom")
}
#[export]
pub fn boom_any() -> i32 {
    std::panic::panic_any(42_i32)
}
