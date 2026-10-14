//! Compile-fail cases: every type the type table (README, ADR-0069 D6) rejects
//! is a macro error naming the type and pointing at the table. The expected
//! diagnostics are the `.stderr` files beside each case; regenerate them with
//! `TRYBUILD=overwrite cargo test -p knext-ffi --test ui` after an intentional
//! wording change, and review the diff.

#[test]
fn rejected_types_are_compile_errors() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/ui/fail/*.rs");
    t.pass("tests/ui/pass/*.rs");
}
