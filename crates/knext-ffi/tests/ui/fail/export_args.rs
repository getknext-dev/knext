use knext_ffi::export;

#[export(name = "g")]
pub fn f(v: i32) -> i32 {
    v
}

fn main() {}
