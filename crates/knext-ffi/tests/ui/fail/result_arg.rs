use knext_ffi::export;

#[export]
pub fn f(r: Result<i32, String>) -> i32 {
    r.unwrap_or(0)
}

fn main() {}
