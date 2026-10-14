use knext_ffi::export;

#[export]
pub fn f() -> impl Copy {
    1
}

fn main() {}
