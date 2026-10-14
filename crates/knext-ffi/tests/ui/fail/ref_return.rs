use knext_ffi::export;

#[export]
pub fn f() -> &'static str {
    "x"
}

fn main() {}
