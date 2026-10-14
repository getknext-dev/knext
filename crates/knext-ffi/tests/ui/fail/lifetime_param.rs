use knext_ffi::export;

#[export]
pub fn f<'a>(x: &'a str) -> u64 {
    x.len() as u64
}

fn main() {}
