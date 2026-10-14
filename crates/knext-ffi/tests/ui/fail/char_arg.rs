use knext_ffi::export;

#[export]
pub fn f(c: char) -> u32 {
    c as u32
}

fn main() {}
