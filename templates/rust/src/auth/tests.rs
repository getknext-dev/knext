//! The token check on its own: an [`AuthLayer`] in front of a stand-in for
//! the connect service that records whether a call reached it. The wired
//! server is covered in `rpc::tests` (every registered procedure, on the
//! wire).

use std::convert::Infallible;
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use bytes::Bytes;
use connectrpc::ConnectRpcBody;
use http::{Request, Response, StatusCode};
use http_body_util::{BodyExt, Empty, Full};
use tower::{Layer, Service, ServiceExt};

use super::*;

const GET_ITEM: &str = "/example.v1.ExampleService/GetItem";
const PUT_ITEM: &str = "/example.v1.ExampleService/PutItem";
const HEALTH_WATCH: &str = "/grpc.health.v1.Health/Watch";

/// A verifier that records what it was asked and answers `result`.
struct Recording {
    calls: AtomicUsize,
    result: Result<Caller, AuthError>,
}

impl Recording {
    fn new(result: Result<Caller, AuthError>) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            result,
        })
    }
}

impl Verifier for Recording {
    fn verify(&self, _token: &str, _procedure: &str) -> Result<Caller, AuthError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.result.clone()
    }
}

/// The checked service in front of a stand-in that counts the calls that
/// reach it and answers 200.
fn checked(
    verifier: Option<Arc<dyn Verifier>>,
) -> (
    impl Service<Request<Empty<Bytes>>, Response = Response<ConnectRpcBody>, Error = Infallible>,
    Arc<AtomicUsize>,
) {
    let reached = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&reached);
    let inner = tower::service_fn(move |_req: Request<Empty<Bytes>>| {
        counter.fetch_add(1, Ordering::SeqCst);
        async {
            Ok::<_, Infallible>(Response::new(ConnectRpcBody::Full(Full::new(
                Bytes::from_static(b"served"),
            ))))
        }
    });
    (AuthLayer::new(verifier).layer(inner), reached)
}

fn request(
    procedure: &str,
    content_type: &str,
    authorization: Option<&str>,
) -> Request<Empty<Bytes>> {
    let mut builder = Request::post(procedure).header("content-type", content_type);
    if let Some(value) = authorization {
        builder = builder.header("authorization", value);
    }
    builder.body(Empty::new()).unwrap()
}

/// The Connect or gRPC status code of a response: the `code` of a Connect
/// error body, or `grpc-status` (header or trailer). `None` means served.
async fn code_of(resp: Response<ConnectRpcBody>) -> Option<String> {
    let status = resp.status();
    let grpc_status = resp
        .headers()
        .get("grpc-status")
        .map(|v| v.to_str().unwrap().to_owned());
    let collected = resp.into_body().collect().await.unwrap();
    let trailer_status = collected
        .trailers()
        .and_then(|t| t.get("grpc-status"))
        .map(|v| v.to_str().unwrap().to_owned());
    let body = collected.to_bytes();
    if status != StatusCode::OK {
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        return Some(json["code"].as_str().unwrap().to_owned());
    }
    let web_status = crate::testutil::grpc_web_trailer(&body, "grpc-status");
    match grpc_status.or(trailer_status).or(web_status) {
        Some(code) if code != "0" => Some(code),
        _ => None,
    }
}

async fn call(
    svc: &mut (
             impl Service<Request<Empty<Bytes>>, Response = Response<ConnectRpcBody>, Error = Infallible>
             + Send
         ),
    req: Request<Empty<Bytes>>,
) -> Option<String> {
    let resp = svc.ready().await.unwrap().call(req).await.unwrap();
    code_of(resp).await
}

/// The binary's verifier (issuer and audience set) reading the JWKS at
/// `path`.
fn mounted(path: impl Into<PathBuf>) -> TokenVerifier {
    token_verifier(TokenConfig::new(
        path,
        "knext:zone:shop/storefront",
        "knext:fn:shop/orders",
    ))
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("knext-fn-auth-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[tokio::test]
async fn no_jwks_mounted_rejects_every_non_health_rpc() {
    let dir = temp_dir("no-jwks");
    let verifier: Arc<dyn Verifier> = Arc::new(mounted(dir.join("jwks.json")));
    let (mut svc, reached) = checked(Some(verifier as Arc<dyn Verifier>));
    for procedure in [GET_ITEM, PUT_ITEM, HEALTH_WATCH, "/no.such.Service/Method"] {
        for authorization in [None, Some("Bearer forged.jwt.token")] {
            let code = call(
                &mut svc,
                request(procedure, "application/proto", authorization),
            )
            .await;
            assert_eq!(
                code.as_deref(),
                Some("unauthenticated"),
                "{procedure} {authorization:?}"
            );
        }
    }
    assert_eq!(
        reached.load(Ordering::SeqCst),
        0,
        "a refused call reached the service"
    );
}

#[tokio::test]
async fn health_check_is_exempt() {
    let (mut svc, reached) = checked(None);
    assert_eq!(
        call(
            &mut svc,
            request(HEALTH_CHECK_PROCEDURE, "application/proto", None)
        )
        .await,
        None
    );
    assert_eq!(reached.load(Ordering::SeqCst), 1);
    // Watch, and anything that only resembles the health check, is not.
    for procedure in [
        HEALTH_WATCH,
        "/grpc.health.v1.Health/Check/",
        "/grpc.health.v1.Health/CheckX",
        "//grpc.health.v1.Health/Check",
        "/grpc.health.v1.health/Check",
    ] {
        let code = call(&mut svc, request(procedure, "application/proto", None)).await;
        assert_eq!(code.as_deref(), Some("unauthenticated"), "{procedure}");
    }
    assert_eq!(reached.load(Ordering::SeqCst), 1);
}

/// A JWKS on disk does not open the door by itself: a token that does not
/// verify against it is refused.
#[tokio::test]
async fn mounted_jwks_refuses_a_token_that_does_not_verify() {
    let dir = temp_dir("mounted");
    let path = dir.join("jwks.json");
    fs::write(&path, br#"{"keys":[]}"#).unwrap();
    let jwks = mounted(&path);
    assert!(matches!(
        jwks.verify("header.payload.signature", GET_ITEM),
        Err(AuthError::Malformed(_))
    ));
    let (mut svc, reached) = checked(Some(Arc::new(jwks)));
    let code = call(
        &mut svc,
        request(GET_ITEM, "application/proto", Some("Bearer a.b.c")),
    )
    .await;
    assert_eq!(code.as_deref(), Some("unauthenticated"));
    assert_eq!(reached.load(Ordering::SeqCst), 0);
}

#[test]
fn no_jwks_shapes() {
    let dir = temp_dir("shapes");
    let empty = dir.join("empty.json");
    fs::write(&empty, b"").unwrap();
    let subdir = dir.join("jwks.json");
    fs::create_dir_all(&subdir).unwrap();
    for (what, path) in [
        ("missing file", dir.join("missing.json")),
        ("empty file", empty),
        ("directory", subdir),
        ("empty path", PathBuf::new()),
    ] {
        assert!(!jwks_mounted(&path), "{what} counts as mounted");
        assert_eq!(
            mounted(&path).verify("a.b.c", PUT_ITEM),
            Err(AuthError::NoJwks),
            "{what}"
        );
    }
    let file = dir.join("keys.json");
    fs::write(&file, b"{}").unwrap();
    assert!(jwks_mounted(&file));
}

#[tokio::test]
async fn missing_or_malformed_token_is_rejected_before_the_verifier() {
    let verifier = Recording::new(Ok(Caller::default()));
    let (mut svc, reached) = checked(Some(verifier.clone() as Arc<dyn Verifier>));
    for authorization in [
        None,
        Some(""),
        Some("Bearer"),
        Some("Bearer "),
        Some("Bearer    "),
        Some("bearer a.b.c"),
        Some("Basic dXNlcjpwYXNz"),
        Some("Token a.b.c"),
        Some("a.b.c"),
    ] {
        let code = call(
            &mut svc,
            request(PUT_ITEM, "application/proto", authorization),
        )
        .await;
        assert_eq!(
            code.as_deref(),
            Some("unauthenticated"),
            "{authorization:?}"
        );
    }
    assert_eq!(
        verifier.calls.load(Ordering::SeqCst),
        0,
        "the verifier saw a call without a token"
    );
    assert_eq!(reached.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn refused_token_is_rejected() {
    let verifier = Recording::new(Err(AuthError::Rejected("bad signature".into())));
    let (mut svc, reached) = checked(Some(verifier.clone() as Arc<dyn Verifier>));
    let code = call(
        &mut svc,
        request(PUT_ITEM, "application/proto", Some("Bearer a.b.c")),
    )
    .await;
    assert_eq!(code.as_deref(), Some("unauthenticated"));
    assert_eq!(verifier.calls.load(Ordering::SeqCst), 1);
    assert_eq!(reached.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn accepted_token_reaches_the_service() {
    let verifier = Recording::new(Ok(Caller::default()));
    let (mut svc, reached) = checked(Some(verifier.clone() as Arc<dyn Verifier>));
    let code = call(
        &mut svc,
        request(PUT_ITEM, "application/proto", Some("Bearer a.b.c")),
    )
    .await;
    assert_eq!(code, None);
    assert_eq!(verifier.calls.load(Ordering::SeqCst), 1);
    assert_eq!(reached.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn no_verifier_fails_closed() {
    let (mut svc, reached) = checked(None);
    let code = call(
        &mut svc,
        request(GET_ITEM, "application/proto", Some("Bearer a.b.c")),
    )
    .await;
    assert_eq!(code.as_deref(), Some("unauthenticated"));
    assert_eq!(reached.load(Ordering::SeqCst), 0);
}

/// A refusal speaks the caller's protocol: HTTP 401 on Connect, and
/// `grpc-status` 16 on gRPC and gRPC-Web.
#[tokio::test]
async fn refusal_matches_the_callers_protocol() {
    let (mut svc, _) = checked(None);
    for content_type in ["application/proto", "application/json"] {
        let resp = svc
            .ready()
            .await
            .unwrap()
            .call(request(PUT_ITEM, content_type, None))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "{content_type}");
    }
    for content_type in [
        "application/grpc",
        "application/grpc+proto",
        "application/grpc-web+proto",
    ] {
        let code = call(&mut svc, request(PUT_ITEM, content_type, None)).await;
        assert_eq!(code.as_deref(), Some("16"), "{content_type}");
    }
}

#[tokio::test]
async fn rejection_does_not_leak_the_cause() {
    let verifier = Recording::new(Err(AuthError::Rejected("kid k-secret-123 unknown".into())));
    let (mut svc, _) = checked(Some(verifier as Arc<dyn Verifier>));
    let resp = svc
        .ready()
        .await
        .unwrap()
        .call(request(PUT_ITEM, "application/json", Some("Bearer a.b.c")))
        .await
        .unwrap();
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8_lossy(&body);
    assert!(text.contains("unauthenticated"), "{text}");
    assert!(
        !text.contains("k-secret-123"),
        "the refusal leaked its cause: {text}"
    );
}

#[test]
fn bearer_token_parse() {
    assert_eq!(bearer_token("Bearer a.b.c"), Some("a.b.c"));
    assert_eq!(bearer_token("Bearer   a.b.c  "), Some("a.b.c"));
    for header in [
        "",
        "Bearer",
        "Bearer ",
        "Bearer  ",
        "bearer a.b.c",
        "Basic a.b.c",
        "a.b.c",
    ] {
        assert_eq!(bearer_token(header), None, "{header:?}");
    }
}
