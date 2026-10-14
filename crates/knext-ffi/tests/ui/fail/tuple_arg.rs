use knext_ffi::export;

#[export]
pub fn f(p: (i32, i32)) -> i32 {
    p.0
}

fn main() {}
