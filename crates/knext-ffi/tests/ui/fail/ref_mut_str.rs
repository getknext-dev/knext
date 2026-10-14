use knext_ffi::export;

#[export]
pub fn f(v: &mut str) -> u64 {
    v.len() as u64
}

fn main() {}
