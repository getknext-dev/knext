use knext_ffi::export;

#[export]
pub fn f(v: i128) -> i64 {
    v as i64
}

fn main() {}
