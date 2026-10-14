use knext_ffi::{export, record};

#[record]
pub struct P {
    #[serde(rename = "n")]
    pub name: String,
}

fn main() {}
