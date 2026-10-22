//! A zone identity token is a JWS in compact form, header
//! `{"alg":"EdDSA","typ":"JWT","kid":"<kid>"}` and claims `iss`, `aud`,
//! `method`, `sub`, `jti`, `iat` and `exp`. It is parsed here by hand and strictly:
//! the algorithm is fixed (never taken from the header), base64url must be
//! canonical and unpadded, JSON must be one object with no duplicate member
//! names, and every claim is required with its exact type. The signature is
//! verified (`verify_strict`) before any claim is read.

use std::collections::HashMap;
use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::de::{Deserializer, Error as _, MapAccess, Visitor};
use serde_json::Value;

use super::replay::{MAX_JTI_CHARS, MIN_JTI_CHARS, valid_jti};
use super::{AuthError, CLOCK_SKEW_SECS, MAX_TOKEN_LIFETIME_SECS};
use crate::proto::knext::v1::Auth;

/// A token's verified claims.
#[derive(Debug)]
pub(super) struct Claims {
    pub iss: String,
    pub aud: String,
    pub method: String,
    pub sub: String,
    pub jti: String,
    pub iat: i64,
    pub exp: i64,
}

fn malformed(why: impl Into<String>) -> AuthError {
    AuthError::Malformed(why.into())
}

/// Parses `token` and verifies its signature with the key its kid names in
/// `keys`, returning its claims for [`Claims::check`].
pub(super) fn verify(
    token: &str,
    keys: &HashMap<String, VerifyingKey>,
) -> Result<Claims, AuthError> {
    let segments: Vec<&str> = token.split('.').collect();
    let [h, p, s] = segments[..] else {
        return Err(malformed(format!("{} segments, want 3", segments.len())));
    };
    let header_json = segment(h)?;
    let payload_json = segment(p)?;
    let signature = segment(s)?;

    let header = object(&header_json)?;
    if let Some(name) = header
        .names()
        .find(|n| !matches!(*n, "alg" | "typ" | "kid"))
    {
        return Err(malformed(format!("header member {name:?}")));
    }
    if header.string("typ")? != "JWT" {
        return Err(malformed("typ"));
    }
    let kid = header.string("kid")?;
    if kid.is_empty() {
        return Err(malformed("empty kid"));
    }
    if header.string("alg").ok() != Some("EdDSA") {
        return Err(AuthError::BadAlg);
    }

    let key = keys.get(kid).ok_or(AuthError::UnknownKid)?;
    let signature = Signature::from_slice(&signature).map_err(|_| AuthError::BadSignature)?;
    let signing_input = format!("{h}.{p}");
    key.verify_strict(signing_input.as_bytes(), &signature)
        .map_err(|_| AuthError::BadSignature)?;

    let payload = object(&payload_json)?;
    let iss = payload.string("iss")?.to_owned();
    let aud = payload.string("aud")?.to_owned();
    let method = payload.string("method")?.to_owned();
    let sub = payload.string("sub")?.to_owned();
    // A token with no jti cannot be remembered, so it could be replayed.
    if payload.get("jti").is_none() {
        return Err(AuthError::MissingJti);
    }
    let jti = payload.string("jti")?.to_owned();
    if !valid_jti(&jti) {
        return Err(malformed(format!(
            "jti is not {MIN_JTI_CHARS}-{MAX_JTI_CHARS} base64url characters"
        )));
    }
    Ok(Claims {
        iss,
        aud,
        method,
        sub,
        jti,
        iat: payload.integer("iat")?,
        exp: payload.integer("exp")?,
    })
}

impl Claims {
    /// Holds verified claims to the function: lifetime and clock, issuer,
    /// audience, method, and a user for an `AUTH_USER` RPC.
    pub(super) fn check(
        &self,
        now: i64,
        issuer: &str,
        audience: &str,
        procedure: &str,
        mode: Auth,
    ) -> Result<(), AuthError> {
        // i128: exact whatever the i64 values.
        if self.exp <= self.iat
            || i128::from(self.exp) - i128::from(self.iat) > i128::from(MAX_TOKEN_LIFETIME_SECS)
        {
            return Err(AuthError::Lifetime);
        }
        if i128::from(self.exp) <= i128::from(now) - i128::from(CLOCK_SKEW_SECS) {
            return Err(AuthError::Expired);
        }
        if i128::from(self.iat) > i128::from(now) + i128::from(CLOCK_SKEW_SECS) {
            return Err(AuthError::NotYetValid);
        }
        if self.iss != issuer {
            return Err(AuthError::WrongIssuer);
        }
        if self.aud != audience {
            return Err(AuthError::WrongAudience);
        }
        if self.method != procedure {
            return Err(AuthError::WrongMethod);
        }
        if mode == Auth::AUTH_USER && self.sub.is_empty() {
            return Err(AuthError::MissingSubject);
        }
        Ok(())
    }
}

/// Decodes one unpadded, canonical base64url segment. The engine refuses
/// padding, bytes outside the URL alphabet and non-zero trailing bits.
pub(super) fn segment(s: &str) -> Result<Vec<u8>, AuthError> {
    URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| malformed(format!("base64url: {e}")))
}

/// A JSON object's members in order, by exact name.
pub(super) struct Members(Vec<(String, Value)>);

impl Members {
    fn names(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(|(n, _)| n.as_str())
    }

    fn get(&self, name: &str) -> Option<&Value> {
        self.0.iter().find(|(n, _)| n == name).map(|(_, v)| v)
    }

    fn string(&self, name: &str) -> Result<&str, AuthError> {
        match self.get(name) {
            Some(Value::String(s)) => Ok(s),
            Some(_) => Err(malformed(format!("{name:?} is not a string"))),
            None => Err(malformed(format!("missing {name:?}"))),
        }
    }

    fn integer(&self, name: &str) -> Result<i64, AuthError> {
        match self.get(name) {
            Some(Value::Number(n)) => n
                .as_i64()
                .ok_or_else(|| malformed(format!("{name:?} is not an integer"))),
            Some(_) => Err(malformed(format!("{name:?} is not an integer"))),
            None => Err(malformed(format!("missing {name:?}"))),
        }
    }
}

/// One JSON object, refusing a duplicate member name (serde_json's own map
/// would keep the last), anything but an object, and trailing data.
pub(super) fn object(data: &[u8]) -> Result<Members, AuthError> {
    serde_json::from_slice::<Members>(data).map_err(|e| malformed(format!("JSON: {e}")))
}

impl<'de> serde::Deserialize<'de> for Members {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ObjectVisitor;

        impl<'de> Visitor<'de> for ObjectVisitor {
            type Value = Members;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Members, A::Error> {
                let mut members: Vec<(String, Value)> = Vec::new();
                while let Some(name) = map.next_key::<String>()? {
                    if members.iter().any(|(n, _)| *n == name) {
                        return Err(A::Error::custom(format!("duplicate member {name:?}")));
                    }
                    let value = map.next_value::<Value>()?;
                    members.push((name, value));
                }
                Ok(Members(members))
            }
        }

        deserializer.deserialize_map(ObjectVisitor)
    }
}
