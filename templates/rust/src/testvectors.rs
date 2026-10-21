//! The shared zone-identity token vectors the token check is tested against:
//! `packages/grpc/testdata/z7-token-vectors.json` in the knext repository,
//! the one file the Go and Rust verifiers and the zone-side signer all share.
//! Tests only.
//!
//! The keys in that file are test material derived from public labels;
//! nothing here is, or may ever be used as, a real key.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::auth::Clock;

/// Overrides where the vectors are read from, for a copy of this template
/// outside the knext repository.
pub const ENV_PATH: &str = "KNEXT_Z7_VECTORS";

#[derive(Deserialize)]
pub struct Vectors {
    pub contract: Contract,
    pub verifier: Expected,
    pub reasons: Vec<String>,
    pub jwks: HashMap<String, serde_json::Value>,
    pub cases: Vec<Case>,
    /// Several tokens presented, in order, to ONE verifier: the replay rules.
    pub sequences: Vec<Sequence>,
}

#[derive(Deserialize)]
pub struct Contract {
    #[serde(rename = "clockSkewSeconds")]
    pub clock_skew_seconds: i64,
    #[serde(rename = "defaultSeenCapacity")]
    pub default_seen_capacity: usize,
    #[serde(rename = "fullSetWireCode")]
    pub full_set_wire_code: String,
    #[serde(rename = "jtiChars")]
    pub jti_chars: JtiChars,
}

#[derive(Deserialize)]
pub struct JtiChars {
    pub min: usize,
    pub max: usize,
}

/// A run of tokens presented to one verifier, each at its own clock reading.
/// `capacity` is the verifier's replay-set size (`None`: its default).
#[derive(Deserialize, Clone)]
pub struct Sequence {
    pub name: String,
    pub jwks: String,
    pub procedure: String,
    pub auth: String,
    pub capacity: Option<usize>,
    pub steps: Vec<Step>,
}

#[derive(Deserialize, Clone)]
pub struct Step {
    pub now: i64,
    pub jws: Vec<String>,
    pub expect: String,
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub reason: String,
}

impl Step {
    pub fn token(&self) -> String {
        self.jws.join(".")
    }
}

#[derive(Deserialize)]
pub struct Expected {
    pub issuer: String,
    pub audience: String,
}

#[derive(Deserialize, Clone)]
pub struct Case {
    pub name: String,
    pub jwks: String,
    pub procedure: String,
    pub auth: String,
    pub now: i64,
    pub jws: Option<Vec<String>>,
    pub expect: String,
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub reason: String,
}

impl Case {
    /// The compact JWS, or `None` for the case with no token at all.
    pub fn token(&self) -> Option<String> {
        self.jws.as_ref().map(|segments| segments.join("."))
    }
}

pub fn path() -> PathBuf {
    match std::env::var_os(ENV_PATH) {
        Some(p) => PathBuf::from(p),
        None => Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/grpc/testdata/z7-token-vectors.json"),
    }
}

/// Reads the vectors, panicking (never skipping) if they are missing: a
/// verifier test that cannot find its vectors proves nothing.
pub fn load() -> Vectors {
    let path = path();
    let data = fs::read(&path).unwrap_or_else(|e| {
        panic!(
            "read the shared token vectors at {} (set {ENV_PATH} for a copy outside the knext repository): {e}",
            path.display()
        )
    });
    let vectors: Vectors = serde_json::from_slice(&data).expect("parse the shared token vectors");
    assert!(
        !vectors.cases.is_empty() && !vectors.jwks.is_empty(),
        "the shared token vectors hold no cases or no JWK Sets"
    );
    vectors
}

impl Vectors {
    pub fn case(&self, name: &str) -> &Case {
        self.cases
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("no vector case {name:?}"))
    }

    pub fn token(&self, name: &str) -> String {
        self.case(name)
            .token()
            .unwrap_or_else(|| panic!("vector case {name:?} has no token"))
    }

    /// The named JWK Set, serialized as it would be mounted.
    pub fn jwks_bytes(&self, name: &str) -> Vec<u8> {
        let set = self
            .jwks
            .get(name)
            .unwrap_or_else(|| panic!("no vector JWK Set {name:?}"));
        serde_json::to_vec(set).unwrap()
    }

    /// Writes the named JWK Set to `path`, replacing what is there.
    pub fn write_jwks(&self, path: &Path, name: &str) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(path, self.jwks_bytes(name)).unwrap();
    }
}

/// A settable test clock.
#[derive(Clone)]
pub struct TestClock(Arc<Mutex<SystemTime>>);

impl TestClock {
    pub fn at(unix: i64) -> Self {
        Self(Arc::new(Mutex::new(
            UNIX_EPOCH + Duration::from_secs(u64::try_from(unix).unwrap()),
        )))
    }

    pub fn advance(&self, by: Duration) {
        *self.0.lock().unwrap() += by;
    }

    /// Moves the clock to an absolute reading, in Unix seconds.
    pub fn set(&self, unix: i64) {
        *self.0.lock().unwrap() = UNIX_EPOCH + Duration::from_secs(u64::try_from(unix).unwrap());
    }

    pub fn clock(&self) -> Clock {
        let now = Arc::clone(&self.0);
        Arc::new(move || *now.lock().unwrap())
    }
}

/// A fresh, empty directory for one test.
pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("knext-fn-z7-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}
