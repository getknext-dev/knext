use knext_ffi::export;

#[export]
pub fn f<T: Copy>(x: T) -> T {
    x
}

fn main() {}
