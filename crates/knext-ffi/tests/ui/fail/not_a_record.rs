use knext_ffi::export;

pub struct Plain {
    pub v: i32,
}

#[export]
pub fn f(p: Plain) -> i32 {
    p.v
}

fn main() {}
