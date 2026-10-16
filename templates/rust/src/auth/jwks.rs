//! The zone's JWK Set as mounted. Kubernetes updates a ConfigMap volume in
//! place, so the file is re-read when its modification time or size changes,
//! and at least every [`JWKS_REREAD_INTERVAL`] regardless: a warm pod picks
//! up a rotated key without a restart. A file that disappears, grows past
//! [`MAX_JWKS_BYTES`] or stops parsing fails closed; the keys of the last
//! good read are not kept.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::VerifyingKey;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::token::segment;
use super::{AuthError, Clock, JWKS_REREAD_INTERVAL, MAX_JWKS_BYTES};

pub(super) type Keys = Arc<HashMap<String, VerifyingKey>>;

/// Whether `path` is a non-empty regular file.
pub fn jwks_mounted(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0)
}

pub(super) struct JwksFile {
    path: PathBuf,
    clock: Clock,
    last: Mutex<Option<Snapshot>>,
}

/// One read of the file: when, what the file looked like, and its outcome.
struct Snapshot {
    mtime: Option<SystemTime>,
    len: u64,
    at: SystemTime,
    keys: Result<Keys, AuthError>,
}

impl JwksFile {
    pub(super) fn new(path: PathBuf, clock: Clock) -> Self {
        Self {
            path,
            clock,
            last: Mutex::new(None),
        }
    }

    pub(super) fn keys(&self) -> Result<Keys, AuthError> {
        if !jwks_mounted(&self.path) {
            return Err(AuthError::NoJwks);
        }
        let meta = std::fs::metadata(&self.path).map_err(|_| AuthError::NoJwks)?;
        let (mtime, len) = (meta.modified().ok(), meta.len());
        let now = (self.clock)();
        let mut last = self.last.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(read) = last.as_ref() {
            let fresh = now
                .duration_since(read.at)
                .map_or(true, |age| age < JWKS_REREAD_INTERVAL);
            if read.mtime == mtime && read.len == len && fresh {
                return read.keys.clone();
            }
        }
        *last = None;
        let data = read_at_most(&self.path, MAX_JWKS_BYTES)?;
        let keys = parse(&data).map(Arc::new);
        *last = Some(Snapshot {
            mtime,
            len,
            at: now,
            keys: keys.clone(),
        });
        keys
    }
}

fn read_at_most(path: &Path, limit: u64) -> Result<Vec<u8>, AuthError> {
    let file = std::fs::File::open(path).map_err(|_| AuthError::NoJwks)?;
    let mut data = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut data)
        .map_err(|_| AuthError::NoJwks)?;
    if data.len() as u64 > limit {
        return Err(AuthError::BadJwks);
    }
    Ok(data)
}

/// JWK members that hold private or symmetric key material (RFC 7517, RFC
/// 7518 §6.2.2, §6.3.2, §6.4). A published JWK Set holds public keys only.
const PRIVATE_JWK_MEMBERS: [&str; 8] = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];

/// The usable keys of an RFC 7517 JWK Set, by kid. A key is usable when it
/// is an Ed25519 OKP key of 32 bytes whose kid is the one derived from it
/// ([`key_id`]) and which is the canonical encoding of a point of the curve
/// outside its small-order subgroup; any other entry is ignored, so a token
/// naming it is refused as an unknown key. `alg` and `use` are
/// informational. A set in which any JWK carries private key material is
/// refused whole: whatever published it leaked a private key, and that must
/// surface rather than be quietly skipped.
fn parse(data: &[u8]) -> Result<HashMap<String, VerifyingKey>, AuthError> {
    let set: Value = serde_json::from_slice(data).map_err(|_| AuthError::BadJwks)?;
    let Some(entries) = set.get("keys").and_then(Value::as_array) else {
        return Err(AuthError::BadJwks);
    };
    if entries
        .iter()
        .any(|k| PRIVATE_JWK_MEMBERS.iter().any(|m| k.get(m).is_some()))
    {
        return Err(AuthError::BadJwks);
    }
    let mut keys = HashMap::new();
    for k in entries {
        let field = |name: &str| k.get(name).and_then(Value::as_str).unwrap_or("");
        if field("kty") != "OKP" {
            continue;
        }
        if field("crv") != "Ed25519" {
            continue;
        }
        let Ok(raw) = segment(field("x")) else {
            continue;
        };
        let Ok(raw) = <[u8; 32]>::try_from(raw.as_slice()) else {
            continue;
        };
        let kid = field("kid");
        if kid != key_id(&raw) {
            continue;
        }
        let Ok(key) = VerifyingKey::from_bytes(&raw) else {
            continue;
        };
        // Decoding reduces y mod p: only the canonical encoding round-trips.
        if key.to_edwards().compress().to_bytes() != raw {
            continue;
        }
        // verify_strict refuses a small-order key too; refusing it here
        // makes it an unknown key, as in every other verifier of the contract.
        if key.is_weak() {
            continue;
        }
        keys.insert(kid.to_owned(), key);
    }
    Ok(keys)
}

/// The kid of a raw Ed25519 public key: base64url, unpadded, of the first
/// 16 bytes of its SHA-256.
fn key_id(raw: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(&Sha256::digest(raw)[..16])
}
