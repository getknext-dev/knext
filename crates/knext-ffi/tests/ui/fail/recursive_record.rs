use knext_ffi::{export, record};

#[record]
pub struct Node {
    pub kids: Vec<Node>,
}

#[export]
pub fn f(v: i32) -> i32 {
    v
}

fn main() {}
