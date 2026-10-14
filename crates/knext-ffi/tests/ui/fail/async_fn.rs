use knext_ffi::export;

#[export]
pub async fn f() -> i32 {
    1
}

fn main() {}
