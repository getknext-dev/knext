use knext_ffi::{export, record};

#[record]
pub struct Wrap<T> {
    pub v: T,
}

#[export]
pub fn f(v: i32) -> i32 {
    v
}

fn main() {}
