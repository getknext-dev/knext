use knext_ffi::export;

#[export]
pub fn f(v: Vec<Option<Option<i64>>>) -> u64 {
    v.len() as u64
}

fn main() {}
