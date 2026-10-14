use knext_ffi::export;

#[export]
pub unsafe fn f(v: i32) -> i32 {
    v
}

fn main() {}
