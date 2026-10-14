use knext_ffi::export;

#[export]
pub fn f() -> (i32, i32) {
    (1, 2)
}

fn main() {}
