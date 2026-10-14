use knext_ffi::export;

#[export]
pub fn f(fail: bool) -> Result<Option<Option<u64>>, String> {
    if fail {
        Err("no".into())
    } else {
        Ok(Some(None))
    }
}

fn main() {}
