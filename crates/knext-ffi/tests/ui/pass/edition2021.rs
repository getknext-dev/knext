use knext_ffi::{export, record};

/// Records first, then exports, in one module: the common shape.
#[record]
pub struct Item {
    pub id: u64,
    pub tags: Vec<String>,
    pub kind: Kind,
}

#[record]
#[derive(Clone, Copy)]
pub enum Kind {
    A,
    B = 7,
}

mod nested {
    use knext_ffi::record;

    #[record]
    pub struct Deep {
        pub v: Option<Option<i32>>,
    }
}

use nested::*;

#[export]
pub fn first(items: Vec<Item>) -> Option<Item> {
    items.into_iter().next()
}

#[export]
pub fn deep(d: Deep) -> Deep {
    d
}

#[export]
pub fn r#match(r#type: &str) -> Result<(), std::fmt::Error> {
    let _ = r#type;
    Ok(())
}

fn main() {
    let _ = first(vec![]);
}
