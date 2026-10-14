use knext_ffi::export;

use std::collections::HashMap;

#[export]
pub fn f(m: HashMap<String, i32>) -> i32 {
    m.len() as i32
}

fn main() {}
