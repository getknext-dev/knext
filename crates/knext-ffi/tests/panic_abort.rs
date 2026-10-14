//! `panic = "abort"` in the consuming crate's profile must be a compile error:
//! with it, a panic inside an export would kill the whole Bun process instead
//! of becoming status 2. Builds a one-export fixture crate twice, with the
//! same sources and lockfile: once with the default profile (must compile, so
//! the test can tell "refused" from "broken") and once with
//! `CARGO_PROFILE_DEV_PANIC=abort` (must fail with knext-ffi's message).

use std::path::{Path, PathBuf};
use std::process::Command;

fn fixture_dir() -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("panic-abort-fixture");
    std::fs::create_dir_all(dir.join("src")).unwrap();
    let ffi = Path::new(env!("CARGO_MANIFEST_DIR"));
    std::fs::write(
        dir.join("Cargo.toml"),
        format!(
            "[package]\nname = \"panic-abort-fixture\"\nversion = \"0.0.0\"\nedition = \"2021\"\n\
             publish = false\n\n[lib]\ncrate-type = [\"cdylib\"]\n\n[dependencies]\n\
             knext-ffi = {{ path = {:?} }}\n\n[workspace]\n",
            ffi.display().to_string()
        ),
    )
    .unwrap();
    std::fs::write(
        dir.join("src/lib.rs"),
        "#[knext_ffi::export]\npub fn add(a: i32, b: i32) -> i32 { a + b }\n",
    )
    .unwrap();
    // Same dependency versions as the workspace, resolvable offline.
    std::fs::copy(ffi.join("../Cargo.lock"), dir.join("Cargo.lock")).unwrap();
    dir
}

fn check(dir: &Path, abort: bool) -> (bool, String) {
    let mut cmd = Command::new(env!("CARGO"));
    cmd.arg("check")
        .arg("--offline")
        .arg("--quiet")
        .arg("--manifest-path")
        .arg(dir.join("Cargo.toml"))
        .arg("--target-dir")
        .arg(dir.join("target"))
        .env_remove("CARGO_TARGET_DIR")
        .env_remove("RUSTFLAGS")
        .env_remove("CARGO_ENCODED_RUSTFLAGS")
        .env_remove("CARGO_PROFILE_DEV_PANIC");
    if abort {
        cmd.env("CARGO_PROFILE_DEV_PANIC", "abort");
    }
    let out = cmd.output().expect("run cargo");
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[test]
fn panic_abort_profile_is_a_compile_error() {
    let dir = fixture_dir();

    let (ok, stderr) = check(&dir, false);
    assert!(
        ok,
        "the fixture must compile with the default (unwind) profile:\n{stderr}"
    );

    let (ok, stderr) = check(&dir, true);
    assert!(!ok, "panic = \"abort\" must not compile");
    assert!(
        stderr.contains("knext-ffi: panic = \"abort\" is not supported"),
        "the refusal must be knext-ffi's compile_error, not some other failure:\n{stderr}"
    );
}
