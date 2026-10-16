//! The function's token check: a Tower layer in front of the connect
//! service that rejects every RPC except the health check unless it carries a
//! zone identity token that verifies. It runs on the request head, before a
//! single byte of the request body is read.
//!
//! The token is a JWS signed by the owning zone with Ed25519 (`alg` EdDSA).
//! It is checked against the zone's public keys, mounted as a JWK Set at
//! [`DEFAULT_JWKS_PATH`]: its signature and key id, its issuer (the owning
//! zone), its audience (this function), its method (the RPC being called),
//! its lifetime, and, for an RPC whose `(knext.v1.auth)` option is
//! `AUTH_USER`, a non-empty subject. The subject is the only user identity a
//! handler may act on: [`Caller::of`] returns it. A user id in the request is
//! never trusted.
//!
//! It fails closed. A missing token, a malformed `Authorization` header, a
//! missing or unreadable JWKS, an unset issuer or audience, an RPC that
//! states no auth option, a verifier error and a missing verifier all end the
//! call with `unauthenticated` before the connect service sees it. The
//! function is reachable only from its zone (cluster-local), and the token is
//! the control that decides which calls it serves, so there is no setting
//! here that turns the check off.

mod jwks;
mod policy;
mod token;

use std::fmt;
use std::future::{Ready, ready};
use std::path::PathBuf;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use connectrpc::{ConnectError, ConnectRpcBody, RequestContext};
use futures_util::future::Either;
use http::{HeaderMap, Request, Response};

pub use jwks::jwks_mounted;
pub use policy::contract_auth;

use crate::proto::knext::v1::Auth;

/// The one RPC served without a token: the standard gRPC health check, used
/// by probes and by the zone's wake-ahead call, which carry no credentials.
/// Health `Watch` is not exempt.
pub const HEALTH_CHECK_PROCEDURE: &str = "/grpc.health.v1.Health/Check";

/// Where the zone's public keys are mounted, as a volume.
pub const DEFAULT_JWKS_PATH: &str = "/var/run/knext/jwks/jwks.json";

/// The env the operator sets on the function: the issuer (the owning zone)
/// and the audience (this function) every token must name.
pub const ENV_ISSUER: &str = "KNEXT_TOKEN_ISSUER";
pub const ENV_AUDIENCE: &str = "KNEXT_TOKEN_AUDIENCE";

/// Bounds `exp - iat`, in seconds.
pub const MAX_TOKEN_LIFETIME_SECS: i64 = 60;
/// How far `exp` and `iat` may be off this pod's clock, in seconds.
pub const CLOCK_SKEW_SECS: i64 = 5;
/// The longest a JWKS read is trusted without re-reading the file, even when
/// its modification time has not changed.
pub const JWKS_REREAD_INTERVAL: Duration = Duration::from_secs(10);
/// Bounds the mounted JWKS: a larger file is refused unread.
pub const MAX_JWKS_BYTES: u64 = 64 << 10;

/// Why a token was refused. Never sent to the caller: a refusal on the wire
/// says only `unauthenticated`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// Nothing usable is mounted at the JWKS path.
    NoJwks,
    /// The mounted JWKS is too large or is not a JWK Set.
    BadJwks,
    /// The issuer or the audience is not set.
    NotConfigured,
    /// The RPC states no `(knext.v1.auth)` option.
    NoAuthOption,
    /// No verifier is configured.
    NoVerifier,
    Malformed(String),
    BadAlg,
    UnknownKid,
    BadSignature,
    Lifetime,
    Expired,
    NotYetValid,
    WrongIssuer,
    WrongAudience,
    WrongMethod,
    MissingSubject,
    /// Another verifier refused the token.
    Rejected(String),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NoJwks => f.write_str("auth: no JWKS is mounted"),
            Self::BadJwks => f.write_str("auth: the mounted JWKS is not a usable JWK Set"),
            Self::NotConfigured => {
                f.write_str("auth: the token issuer or audience is not configured")
            }
            Self::NoAuthOption => f.write_str("auth: the RPC states no auth option"),
            Self::NoVerifier => f.write_str("auth: no verifier configured"),
            Self::Malformed(why) => write!(f, "auth: malformed token: {why}"),
            Self::BadAlg => f.write_str("auth: token algorithm is not EdDSA"),
            Self::UnknownKid => f.write_str("auth: token key id is not in the JWKS"),
            Self::BadSignature => f.write_str("auth: token signature does not verify"),
            Self::Lifetime => f.write_str("auth: token lifetime is out of bounds"),
            Self::Expired => f.write_str("auth: token expired"),
            Self::NotYetValid => f.write_str("auth: token issued in the future"),
            Self::WrongIssuer => f.write_str("auth: token issuer is not this function's zone"),
            Self::WrongAudience => f.write_str("auth: token audience is not this function"),
            Self::WrongMethod => f.write_str("auth: token method is not the RPC called"),
            Self::MissingSubject => f.write_str("auth: token names no user for a user RPC"),
            Self::Rejected(why) => write!(f, "auth: token rejected: {why}"),
        }
    }
}

impl std::error::Error for AuthError {}

/// Who a verified call is from: the zone that signed its token, and the user
/// that zone vouched for (empty on an `AUTH_PUBLIC` RPC called without one).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Caller {
    /// The token's `sub`: the user id from the zone's `authorize()`.
    pub subject: String,
    /// The token's `iss`: `knext:zone:<namespace>/<zone>`.
    pub zone: String,
}

impl Caller {
    /// The caller of a call that passed the token check. It is the only
    /// source of user identity a handler may use.
    pub fn of(ctx: &RequestContext) -> Option<&Caller> {
        ctx.extensions().get::<Caller>()
    }
}

/// Decides whether a bearer token may call `procedure`. `Ok` admits the
/// call, as the returned caller; any error rejects it.
pub trait Verifier: Send + Sync + 'static {
    fn verify(&self, token: &str, procedure: &str) -> Result<Caller, AuthError>;
}

/// The token check's clock.
pub type Clock = Arc<dyn Fn() -> SystemTime + Send + Sync>;

/// The `(knext.v1.auth)` option of an RPC, by procedure path, or
/// `AUTH_UNSPECIFIED` when it states none or is unknown.
pub type MethodAuth = Arc<dyn Fn(&str) -> Auth + Send + Sync>;

/// What the verifier holds tokens to.
#[derive(Clone)]
pub struct TokenConfig {
    /// The mounted JWK Set of the owning zone.
    pub jwks_path: PathBuf,
    /// The owning zone, `knext:zone:<namespace>/<zone>` (`$KNEXT_TOKEN_ISSUER`).
    pub issuer: String,
    /// This function, `knext:fn:<namespace>/<function>` (`$KNEXT_TOKEN_AUDIENCE`).
    pub audience: String,
    /// Each RPC's auth option: the contract table, [`contract_auth`].
    pub method_auth: MethodAuth,
    pub clock: Clock,
}

impl TokenConfig {
    /// The binary's configuration: the contract table and the system clock.
    pub fn new(
        jwks_path: impl Into<PathBuf>,
        issuer: impl Into<String>,
        audience: impl Into<String>,
    ) -> Self {
        Self {
            jwks_path: jwks_path.into(),
            issuer: issuer.into(),
            audience: audience.into(),
            method_auth: Arc::new(contract_auth),
            clock: Arc::new(SystemTime::now),
        }
    }
}

/// The verifier that checks zone identity tokens against the JWKS mounted at
/// `cfg.jwks_path`, re-reading it when it changes, and at least every
/// [`JWKS_REREAD_INTERVAL`], without a restart.
pub fn token_verifier(cfg: TokenConfig) -> TokenVerifier {
    let jwks = jwks::JwksFile::new(cfg.jwks_path.clone(), Arc::clone(&cfg.clock));
    TokenVerifier { cfg, jwks }
}

/// See [`token_verifier`].
pub struct TokenVerifier {
    cfg: TokenConfig,
    jwks: jwks::JwksFile,
}

impl Verifier for TokenVerifier {
    fn verify(&self, token: &str, procedure: &str) -> Result<Caller, AuthError> {
        let keys = self.jwks.keys()?;
        if self.cfg.issuer.is_empty() || self.cfg.audience.is_empty() {
            return Err(AuthError::NotConfigured);
        }
        let mode = (self.cfg.method_auth)(procedure);
        if !matches!(mode, Auth::AUTH_USER | Auth::AUTH_PUBLIC) {
            return Err(AuthError::NoAuthOption);
        }
        let claims = token::verify(token, &keys)?;
        let now = unix_seconds((self.cfg.clock)());
        claims.check(now, &self.cfg.issuer, &self.cfg.audience, procedure, mode)?;
        Ok(Caller {
            subject: claims.sub,
            zone: claims.iss,
        })
    }
}

fn unix_seconds(t: SystemTime) -> i64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => i64::try_from(d.as_secs()).unwrap_or(i64::MAX),
        Err(e) => i64::try_from(e.duration().as_secs()).map_or(i64::MIN, |s| -s),
    }
}

struct DenyAll(AuthError);

impl Verifier for DenyAll {
    fn verify(&self, _token: &str, _procedure: &str) -> Result<Caller, AuthError> {
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

    fn call(&mut self, mut req: Request<B>) -> Self::Future {
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
        let caller = match self.verifier.verify(token, procedure) {
            Ok(caller) => caller,
            Err(err) => {
                // The cause is logged, never sent: the caller learns only that
                // the token was refused.
                tracing::debug!(procedure, error = %err, "token rejected");
                return Either::Right(ready(Ok(refusal(req.headers(), "token rejected"))));
            }
        };
        // Replaces any caller already in the request: identity comes from
        // the verified token alone.
        req.extensions_mut().insert(caller);
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
#[cfg(test)]
mod vector_tests;
