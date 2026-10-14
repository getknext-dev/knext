use knext_ffi::export;

#[export]
pub fn f(v: &i32) -> i32 {
    *v
}

fn main() {}
