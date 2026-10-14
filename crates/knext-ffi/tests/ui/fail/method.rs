use knext_ffi::export;

pub struct S;

impl S {
    #[export]
    pub fn m(&self) -> i32 {
        1
    }
}

fn main() {}
