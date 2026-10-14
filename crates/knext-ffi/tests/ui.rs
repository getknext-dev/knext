//! Compile-fail cases: every type the type table (README, "Type table") rejects
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

/// The diagnostics are user-facing: they point at the public docs page, never
/// at an internal design record. trybuild holds every `.stderr` file equal to
/// what the compiler printed, so scanning them scans the real messages.
#[test]
fn compile_errors_point_users_at_the_docs_page_not_internal_records() {
    let mut scanned = 0;
    let mut hinted = 0;
    for entry in std::fs::read_dir("tests/ui/fail").unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("stderr") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap();
        scanned += 1;
        assert!(
            !text.contains("ADR-") && !text.contains("ADR "),
            "{} names an internal design record",
            path.display()
        );
        if text.contains("supported types are listed at https://knext-platform.dev/docs/rust-in-process#type-mapping") {
            hinted += 1;
        }
    }
    assert!(scanned >= 30, "only {scanned} .stderr files found");
    assert!(
        hinted >= 30,
        "only {hinted} diagnostics point at the type table"
    );
}
