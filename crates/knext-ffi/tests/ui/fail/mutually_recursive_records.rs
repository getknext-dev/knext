use knext_ffi::{export, record};

#[record]
pub struct A {
    pub b: Vec<B>,
}

#[record]
pub struct B {
    pub a: Option<Vec<A>>,
}

#[export]
pub fn f(a: A) -> u64 {
    a.b.len() as u64
}

fn main() {}
