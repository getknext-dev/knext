use knext_ffi::export;

#[export]
pub fn f(v: Option<Option<i32>>) -> i32 {
    v.flatten().unwrap_or(0)
}

fn main() {}
