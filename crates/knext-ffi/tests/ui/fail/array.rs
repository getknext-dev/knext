use knext_ffi::export;

#[export]
pub fn f(a: [u8; 4]) -> u8 {
    a[0]
}

fn main() {}
