use knext_ffi::{export, record};

#[record]
pub enum Shape {
    Circle(f64),
    Empty,
}

#[export]
pub fn f(s: Shape) -> i32 {
    match s {
        Shape::Circle(_) => 1,
        Shape::Empty => 0,
    }
}

fn main() {}
