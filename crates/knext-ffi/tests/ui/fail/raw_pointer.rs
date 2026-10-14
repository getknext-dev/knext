use knext_ffi::export;

#[export]
pub fn f(p: *const u8) -> u64 {
    p as u64
}

fn main() {}
