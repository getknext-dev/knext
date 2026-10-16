//! The function's token check: a Tower layer in front of the connect
//! service that rejects every RPC except the health check unless its bearer
//! token verifies. It runs on the request head, before a single byte of the
//! request body is read.
//!
//! It fails closed. A missing token, a malformed `Authorization` header, a
//! missing JWKS, a verifier error and a missing verifier all end the call
//! with `unauthenticated` before the connect service sees it.
//!
//! Token verification against the zone's JWKS is not in this version of the
//! template: until it is, a mounted JWKS rejects every non-health RPC too.
//! The function is reachable only from its zone (cluster-local), and the
//! token is the control that decides which calls it serves, so there is no
//! setting here that turns the check off.

use std::fmt;
use std::future::{Ready, ready};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::task::{Context, Poll};

use connectrpc::{ConnectError, ConnectRpcBody};
use futures_util::future::Either;
use http::{HeaderMap, Request, Response};

/// The one RPC served without a token: the standard gRPC health check, used
/// by probes and by the zone's wake-ahead call, which carry no credentials.
/// Health `Watch` is not exempt.
pub const HEALTH_CHECK_PROCEDURE: &str = "/grpc.health.v1.Health/Check";

/// Where the zone's public keys are mounted, as a volume.
pub const DEFAULT_JWKS_PATH: &str = "/var/run/knext/jwks/jwks.json";

/// Why a token was refused. Never sent to the caller: a refusal on the wire
/// says only `unauthenticated`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// Nothing usable is mounted at the JWKS path.
    NoJwks,
    /// A JWKS is mounted but this version of the template cannot verify
    /// tokens against it, so it refuses them all.
    VerificationUnavailable,
    /// No verifier is configured.
    NoVerifier,
    /// The verifier refused the token.
    Rejected(String),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoJwks => f.write_str("auth: no JWKS is mounted"),
            Self::VerificationUnavailable => {
                f.write_str("auth: token verification is not available in this template version")
            }
            Self::NoVerifier => f.write_str("auth: no verifier configured"),
            Self::Rejected(why) => write!(f, "auth: token rejected: {why}"),
        }
    }
}

impl std::error::Error for AuthError {}

/// Decides whether a bearer token may call `procedure`. `Ok` admits the
/// call; any error rejects it.
pub trait Verifier: Send + Sync + 'static {
    fn verify(&self, token: &str, procedure: &str) -> Result<(), AuthError>;
}

/// The verifier for the JWKS mounted at `path`. The mount is checked on every
/// call, so a JWKS that appears or disappears after start is seen without a
/// restart.
pub fn mounted_jwks(path: impl Into<PathBuf>) -> MountedJwks {
    MountedJwks { path: path.into() }
}

/// See [`mounted_jwks`].
#[derive(Debug, Clone)]
pub struct MountedJwks {
    path: PathBuf,
}

impl Verifier for MountedJwks {
    fn verify(&self, _token: &str, _procedure: &str) -> Result<(), AuthError> {
        if !jwks_mounted(&self.path) {
            return Err(AuthError::NoJwks);
        }
        // TODO(#2051): verify the token's signature, kid, exp, aud, iss and
        // method claim against the mounted JWKS. Until then, refuse every token.
        Err(AuthError::VerificationUnavailable)
    }
}

/// Whether `path` is a non-empty regular file.
pub fn jwks_mounted(path: &Path) -> bool {
    std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0)
}

struct DenyAll(AuthError);

impl Verifier for DenyAll {
    fn verify(&self, _token: &str, _procedure: &str) -> Result<(), AuthError> {
        Err(self.0.clone())
    }
}

/// The token check as a Tower layer. A `None` verifier rejects every call
/// except the health check.
#[derive(Clone)]
pub struct AuthLayer {
    verifier: Arc<dyn Verifier>,
}

impl AuthLayer {
    pub fn new(verifier: Option<Arc<dyn Verifier>>) -> Self {
        let verifier = match verifier {
            Some(verifier) => verifier,
            None => Arc::new(DenyAll(AuthError::NoVerifier)),
        };
        Self { verifier }
    }
}

impl<S> tower::Layer<S> for AuthLayer {
    type Service = AuthService<S>;

    fn layer(&self, inner: S) -> Self::Service {
        AuthService {
            inner,
            verifier: Arc::clone(&self.verifier),
        }
    }
}

/// The service [`AuthLayer`] wraps around the connect service.
#[derive(Clone)]
pub struct AuthService<S> {
    inner: S,
    verifier: Arc<dyn Verifier>,
}

impl<S, B> tower::Service<Request<B>> for AuthService<S>
where
    S: tower::Service<Request<B>, Response = Response<ConnectRpcBody>>,
{
    type Response = Response<ConnectRpcBody>;
    type Error = S::Error;
    type Future = Either<S::Future, Ready<Result<Self::Response, S::Error>>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.inner.poll_ready(cx)
    }

    fn call(&mut self, req: Request<B>) -> Self::Future {
        let procedure = req.uri().path();
        if procedure == HEALTH_CHECK_PROCEDURE {
            return Either::Left(self.inner.call(req));
        }
        let token = req
            .headers()
            .get(http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(bearer_token);
        let Some(token) = token else {
            return Either::Right(ready(Ok(refusal(req.headers(), "missing bearer token"))));
        };
        if let Err(err) = self.verifier.verify(token, procedure) {
            // The cause is logged, never sent: the caller learns only that
            // the token was refused.
            tracing::debug!(procedure, error = %err, "token rejected");
            return Either::Right(ready(Ok(refusal(req.headers(), "token rejected"))));
        }
        Either::Left(self.inner.call(req))
    }
}

/// `unauthenticated` in the caller's protocol: HTTP 401 on Connect,
/// `grpc-status` 16 on gRPC and gRPC-Web.
fn refusal(headers: &HeaderMap, message: &str) -> Response<ConnectRpcBody> {
    ConnectError::unauthenticated(message).into_http_response(headers)
}

/// The token of an `Authorization: Bearer <token>` value.
pub fn bearer_token(header: &str) -> Option<&str> {
    let token = header.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then_some(token)
}

#[cfg(test)]
mod tests;
