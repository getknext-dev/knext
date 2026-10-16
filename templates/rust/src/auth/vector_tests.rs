//! The token check against the shared zone-identity token vectors: every
//! case, rotation, the warm-pod JWKS reload, and the fail-closed edges of the
//! JWKS and the configuration.

use std::convert::Infallible;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use connectrpc::ConnectRpcBody;
use http::{Request, Response};
use http_body_util::Full;
use tower::{Layer, Service, ServiceExt};

use super::*;
use crate::proto::knext::v1::Auth;
use crate::testvectors::{self, Case, TestClock, Vectors};

/// The refusal reason the shared vectors name for each error.
fn reason(err: &AuthError) -> &'static str {
    match err {
        AuthError::Malformed(_) => "malformed",
        AuthError::BadAlg => "bad-alg",
        AuthError::UnknownKid => "unknown-kid",
        AuthError::BadSignature => "bad-signature",
        AuthError::Lifetime => "lifetime",
        AuthError::Expired => "expired",
        AuthError::NotYetValid => "not-yet-valid",
        AuthError::WrongIssuer => "wrong-issuer",
        AuthError::WrongAudience => "wrong-audience",
        AuthError::WrongMethod => "wrong-method",
        AuthError::MissingSubject => "missing-subject",
        _ => "other",
    }
}

fn auth_of(name: &str) -> Auth {
    match name {
        "AUTH_USER" => Auth::AUTH_USER,
        "AUTH_PUBLIC" => Auth::AUTH_PUBLIC,
        other => panic!("unknown auth {other:?}"),
    }
}

/// The auth policy of a server that serves exactly one RPC.
fn only_method(procedure: &str, mode: Auth) -> MethodAuth {
    let procedure = procedure.to_owned();
    Arc::new(move |p: &str| {
        if p == procedure {
            mode
        } else {
            Auth::AUTH_UNSPECIFIED
        }
    })
}

fn config(v: &Vectors, c: &Case, jwks_path: &Path, clock: Clock) -> TokenConfig {
    TokenConfig {
        jwks_path: jwks_path.to_path_buf(),
        issuer: v.verifier.issuer.clone(),
        audience: v.verifier.audience.clone(),
        method_auth: only_method(&c.procedure, auth_of(&c.auth)),
        clock,
    }
}

/// The verifier for one case: its JWK Set mounted at a fresh path, the
/// vectors' issuer and audience, the case's clock and auth option.
fn case_verifier(v: &Vectors, c: &Case, dir: &str) -> (TokenVerifier, std::path::PathBuf) {
    let path = testvectors::temp_dir(dir).join("jwks").join("jwks.json");
    v.write_jwks(&path, &c.jwks);
    let verifier = token_verifier(config(v, c, &path, TestClock::at(c.now).clock()));
    (verifier, path)
}

fn refused_with(result: Result<Caller, AuthError>, want: &str, what: &str) {
    match result {
        Ok(caller) => panic!("{what}: accepted as {caller:?}; want {want}"),
        Err(err) => assert_eq!(reason(&err), want, "{what}: refused with {err}"),
    }
}

/// Replaces the mounted JWK Set and moves its modification time forward, as
/// a kubelet ConfigMap update does.
fn replace_jwks(v: &Vectors, path: &Path, name: &str) {
    write_later(path, &v.jwks_bytes(name));
}

fn write_later(path: &Path, data: &[u8]) {
    let before = fs::metadata(path).unwrap().modified().unwrap();
    fs::write(path, data).unwrap();
    let file = fs::File::options().write(true).open(path).unwrap();
    file.set_modified(before + Duration::from_secs(2)).unwrap();
}

#[test]
fn shared_vector_reasons_are_all_mapped() {
    let v = testvectors::load();
    let known = [
        AuthError::Malformed(String::new()),
        AuthError::BadAlg,
        AuthError::UnknownKid,
        AuthError::BadSignature,
        AuthError::Lifetime,
        AuthError::Expired,
        AuthError::NotYetValid,
        AuthError::WrongIssuer,
        AuthError::WrongAudience,
        AuthError::WrongMethod,
        AuthError::MissingSubject,
    ];
    for r in v.reasons.iter().filter(|r| r.as_str() != "no-token") {
        assert!(
            known.iter().any(|e| reason(e) == r),
            "the vectors name reason {r:?}, which no verifier error maps to"
        );
    }
}

/// Every case in the shared vectors: each valid token is accepted with its
/// subject, and each negative case is refused for exactly the reason the
/// vectors name (so dropping one check reds that check's case).
#[tokio::test]
async fn shared_vectors() {
    let v = testvectors::load();
    let (mut accepted, mut refused) = (0, 0);
    for (i, c) in v.cases.iter().enumerate() {
        let (verifier, _) = case_verifier(&v, c, &format!("case-{i}"));
        let Some(token) = c.token() else {
            // No token at all: the layer refuses it before the verifier is asked.
            let (mut svc, reached) = stand_in(Arc::new(verifier));
            let resp = svc
                .ready()
                .await
                .unwrap()
                .call(post(&c.procedure, None, b""))
                .await
                .unwrap();
            assert_eq!(resp.status(), http::StatusCode::UNAUTHORIZED, "{}", c.name);
            assert!(reached.lock().unwrap().is_empty(), "{}", c.name);
            refused += 1;
            continue;
        };
        let result = verifier.verify(&token, &c.procedure);
        match c.expect.as_str() {
            "accept" => {
                let caller =
                    result.unwrap_or_else(|e| panic!("{}: refused a valid token: {e}", c.name));
                assert_eq!(
                    caller,
                    Caller {
                        subject: c.sub.clone(),
                        zone: v.verifier.issuer.clone()
                    },
                    "{}",
                    c.name
                );
                accepted += 1;
            }
            "reject" => {
                refused_with(result, &c.reason, &c.name);
                refused += 1;
            }
            other => panic!("{}: unknown expectation {other:?}", c.name),
        }
    }
    // A run that saw fewer cases proves nothing about the ones it missed.
    assert!(
        accepted >= 7 && refused >= 36,
        "ran {accepted} accepted and {refused} refused cases; want at least 7 and 36"
    );
}

type Reached = Arc<Mutex<Vec<Option<Caller>>>>;

/// The token layer in front of a stand-in for the connect service that
/// records the caller each call that reaches it carries.
fn stand_in(
    verifier: Arc<dyn Verifier>,
) -> (
    impl Service<Request<Full<Bytes>>, Response = Response<ConnectRpcBody>, Error = Infallible>,
    Reached,
) {
    let reached: Reached = Arc::default();
    let record = Arc::clone(&reached);
    let inner = tower::service_fn(move |req: Request<Full<Bytes>>| {
        record
            .lock()
            .unwrap()
            .push(req.extensions().get::<Caller>().cloned());
        async {
            Ok::<_, Infallible>(Response::new(ConnectRpcBody::Full(Full::new(
                Bytes::from_static(b"{}"),
            ))))
        }
    });
    (AuthLayer::new(Some(verifier)).layer(inner), reached)
}

fn post(procedure: &str, token: Option<&str>, body: &'static [u8]) -> Request<Full<Bytes>> {
    let mut builder = Request::post(procedure).header("content-type", "application/json");
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    builder.body(Full::new(Bytes::from_static(body))).unwrap()
}

/// A refusal reaches no service, and says only "unauthenticated".
#[tokio::test]
async fn vector_refusals_reach_no_service() {
    let v = testvectors::load();
    for name in [
        "wrong-method",
        "user-empty-sub",
        "expired",
        "cross-zone",
        "alg-none",
    ] {
        let c = v.case(name);
        let (verifier, _) = case_verifier(&v, c, &format!("refusal-{name}"));
        let (mut svc, reached) = stand_in(Arc::new(verifier));
        let resp = svc
            .ready()
            .await
            .unwrap()
            .call(post(&c.procedure, Some(&v.token(name)), b"{}"))
            .await
            .unwrap();
        assert_eq!(resp.status(), http::StatusCode::UNAUTHORIZED, "{name}");
        let body = http_body_util::BodyExt::collect(resp.into_body())
            .await
            .unwrap()
            .to_bytes();
        let text = String::from_utf8_lossy(&body);
        assert!(
            !text.contains(&c.reason),
            "{name}: the refusal names its reason: {text}"
        );
        assert!(
            reached.lock().unwrap().is_empty(),
            "{name} reached the service"
        );
    }
}

/// The user a function acts for comes from the verified token and nowhere
/// else: a user id forged into the body or a header is never the caller, and
/// it never stands in for a missing or user-less token.
#[tokio::test]
async fn body_forged_user_id_is_never_the_caller() {
    let v = testvectors::load();
    let c = v.case("valid-user");
    let forged: &'static [u8] =
        br#"{"id":"user_id=admin","value":"{\"sub\":\"admin\"}","sub":"admin","userId":"admin"}"#;

    let (verifier, _) = case_verifier(&v, c, "forged-valid");
    let (mut svc, reached) = stand_in(Arc::new(verifier));
    let mut req = post(&c.procedure, Some(&v.token("valid-user")), forged);
    req.headers_mut()
        .insert("x-user-id", "admin".parse().unwrap());
    req.headers_mut()
        .insert("x-knext-sub", "admin".parse().unwrap());
    // A caller planted in the request's extensions by anything in front of
    // the layer is replaced, never trusted.
    req.extensions_mut().insert(Caller {
        subject: "admin".into(),
        zone: v.verifier.issuer.clone(),
    });
    let resp = svc.ready().await.unwrap().call(req).await.unwrap();
    assert_eq!(resp.status(), http::StatusCode::OK);
    assert_eq!(
        reached.lock().unwrap().as_slice(),
        &[Some(Caller {
            subject: c.sub.clone(),
            zone: v.verifier.issuer.clone()
        })],
        "the service must see the token's subject, not the forged one"
    );

    let resp = svc
        .ready()
        .await
        .unwrap()
        .call(post(&c.procedure, None, forged))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        http::StatusCode::UNAUTHORIZED,
        "forged id, no token"
    );

    let empty = v.case("user-empty-sub");
    let (verifier, _) = case_verifier(&v, empty, "forged-empty");
    let (mut svc2, reached2) = stand_in(Arc::new(verifier));
    let resp = svc2
        .ready()
        .await
        .unwrap()
        .call(post(
            &empty.procedure,
            Some(&v.token("user-empty-sub")),
            forged,
        ))
        .await
        .unwrap();
    assert_eq!(
        resp.status(),
        http::StatusCode::UNAUTHORIZED,
        "forged id, user-less token"
    );
    assert!(reached2.lock().unwrap().is_empty());
    assert_eq!(reached.lock().unwrap().len(), 1);
}

/// Rotation: a previous-key token verifies while the JWKS still holds the
/// previous key (the overlap), and is refused once the key leaves the JWKS,
/// in the same warm verifier.
#[test]
fn rotation_overlap_then_retire() {
    let v = testvectors::load();
    let c = v.case("rotation-previous-during-overlap");
    let (verifier, path) = case_verifier(&v, c, "rotation");
    let previous = v.token("rotation-previous-during-overlap");
    let current = v.token("valid-user");
    for (name, token) in [("previous", &previous), ("current", &current)] {
        verifier.verify(token, &c.procedure).unwrap_or_else(|e| {
            panic!("during the overlap, the {name}-key token was refused: {e}")
        });
    }
    replace_jwks(&v, &path, "zone-a-current-only");
    refused_with(
        verifier.verify(&previous, &c.procedure),
        "unknown-kid",
        "a previous-key token after the overlap",
    );
    verifier
        .verify(&current, &c.procedure)
        .expect("after the overlap, the current-key token");
}

/// Warm-pod rotation: switching signing to a new key BEFORE the JWKS
/// carrying it reaches the pod fails, and once it lands, the same running
/// verifier accepts the new key's tokens without a restart.
#[test]
fn warm_pod_picks_up_a_new_key_without_restart() {
    let v = testvectors::load();
    let before = v.case("rotation-next-before-propagation");
    let (verifier, path) = case_verifier(&v, before, "warm");
    let next = v.token("rotation-next-before-propagation");
    assert_eq!(
        next,
        v.token("rotation-next-after-propagation"),
        "the before- and after-propagation vectors must be the same new-key token"
    );
    refused_with(
        verifier.verify(&next, &before.procedure),
        "unknown-kid",
        "a new-key token before the JWKS propagated",
    );
    replace_jwks(&v, &path, "zone-a-rotating");
    verifier
        .verify(&next, &before.procedure)
        .expect("the warm verifier must accept a new-key token after the JWKS propagated");
}

/// The JWKS is re-read at least every JWKS_REREAD_INTERVAL even when the
/// file's modification time and size do not change.
#[test]
fn jwks_is_reread_at_least_every_interval() {
    let v = testvectors::load();
    let c = v.case("rotation-next-before-propagation");
    let path = testvectors::temp_dir("reread").join("jwks.json");
    v.write_jwks(&path, "zone-a-overlap");
    assert_eq!(
        v.jwks_bytes("zone-a-overlap").len(),
        v.jwks_bytes("zone-a-rotating").len(),
        "the two JWK Sets must be the same size for this test to hold the size still"
    );
    let clock = TestClock::at(c.now);
    let verifier = token_verifier(config(&v, c, &path, clock.clock()));
    let next = v.token("rotation-next-before-propagation");
    refused_with(
        verifier.verify(&next, &c.procedure),
        "unknown-kid",
        "before the JWKS changed",
    );

    let mtime = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, v.jwks_bytes("zone-a-rotating")).unwrap();
    fs::File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_modified(mtime)
        .unwrap();
    clock.advance(JWKS_REREAD_INTERVAL - Duration::from_secs(1));
    refused_with(
        verifier.verify(&next, &c.procedure),
        "unknown-kid",
        "inside the reread interval, with mtime and size unchanged",
    );
    clock.advance(Duration::from_secs(1));
    verifier
        .verify(&next, &c.procedure)
        .expect("the JWKS must be re-read once the interval has passed");
    assert!(JWKS_REREAD_INTERVAL <= Duration::from_secs(10));
}

/// A JWKS that disappears after it was loaded fails closed.
#[test]
fn jwks_removed_after_load_fails_closed() {
    let v = testvectors::load();
    let c = v.case("valid-user");
    let (verifier, path) = case_verifier(&v, c, "removed");
    let token = v.token("valid-user");
    verifier.verify(&token, &c.procedure).expect("valid token");
    fs::remove_file(&path).unwrap();
    assert_eq!(
        verifier.verify(&token, &c.procedure),
        Err(AuthError::NoJwks)
    );
}

/// A JWKS that stops parsing fails closed: the last good keys are dropped.
#[test]
fn unparseable_jwks_fails_closed() {
    let v = testvectors::load();
    let c = v.case("valid-user");
    let (verifier, path) = case_verifier(&v, c, "unparseable");
    let token = v.token("valid-user");
    verifier.verify(&token, &c.procedure).expect("valid token");
    for body in [&br#"{"keys":["#[..], br#"{"kty":"OKP"}"#, br#"{"keys":{}}"#] {
        write_later(&path, body);
        assert_eq!(
            verifier.verify(&token, &c.procedure),
            Err(AuthError::BadJwks),
            "{}",
            String::from_utf8_lossy(body)
        );
    }
}

/// A JWKS larger than MAX_JWKS_BYTES is refused rather than read.
#[test]
fn oversized_jwks_is_refused() {
    let v = testvectors::load();
    let c = v.case("valid-user");
    let (verifier, path) = case_verifier(&v, c, "oversized");
    let mut padded = vec![b' '; usize::try_from(MAX_JWKS_BYTES).unwrap()];
    padded.extend(v.jwks_bytes(&c.jwks));
    write_later(&path, &padded);
    assert_eq!(
        verifier.verify(&v.token("valid-user"), &c.procedure),
        Err(AuthError::BadJwks)
    );
}

/// Without the issuer and audience it checks tokens against, the verifier
/// refuses every token: an unconfigured function is closed, not open.
#[test]
fn unconfigured_issuer_or_audience_refuses_every_token() {
    let v = testvectors::load();
    let c = v.case("valid-user");
    let path = testvectors::temp_dir("unconfigured").join("jwks.json");
    v.write_jwks(&path, &c.jwks);
    for (issuer, audience) in [
        ("", v.verifier.audience.as_str()),
        (v.verifier.issuer.as_str(), ""),
        ("", ""),
    ] {
        let mut cfg = config(&v, c, &path, TestClock::at(c.now).clock());
        cfg.issuer = issuer.into();
        cfg.audience = audience.into();
        assert_eq!(
            token_verifier(cfg).verify(&v.token("valid-user"), &c.procedure),
            Err(AuthError::NotConfigured),
            "issuer {issuer:?} audience {audience:?}"
        );
    }
}

/// An RPC whose `(knext.v1.auth)` option is unstated, or that is in no
/// contract the function serves, is refused even with a valid token.
#[test]
fn rpc_without_an_auth_option_is_refused() {
    let v = testvectors::load();
    let c = v.case("valid-user");
    let path = testvectors::temp_dir("no-option").join("jwks.json");
    v.write_jwks(&path, &c.jwks);
    for policy in [
        only_method(&c.procedure, Auth::AUTH_UNSPECIFIED),
        only_method("/other.v1.Other/Call", Auth::AUTH_USER),
    ] {
        let mut cfg = config(&v, c, &path, TestClock::at(c.now).clock());
        cfg.method_auth = policy;
        assert_eq!(
            token_verifier(cfg).verify(&v.token("valid-user"), &c.procedure),
            Err(AuthError::NoAuthOption)
        );
    }
    // The binary's policy is the contract table: PutItem is AUTH_USER there.
    let mut cfg = config(&v, c, &path, TestClock::at(c.now).clock());
    cfg.method_auth = Arc::new(contract_auth);
    token_verifier(cfg)
        .verify(&v.token("valid-user"), &c.procedure)
        .expect("the contract table serves PutItem");
}

/// AUTH_PUBLIC: a public read needs a valid zone token, but no user.
#[test]
fn public_method_needs_a_zone_token_but_no_user() {
    let v = testvectors::load();
    let c = v.case("valid-public");
    let (verifier, _) = case_verifier(&v, c, "public");
    let caller = verifier
        .verify(&v.token("valid-public"), &c.procedure)
        .expect("a public read with a zone token and no user");
    assert_eq!(caller.subject, "");
    assert_eq!(caller.zone, v.verifier.issuer);
    // The zone check is not skipped for a public read.
    assert!(
        verifier
            .verify(&v.token("unknown-kid"), &c.procedure)
            .is_err()
    );
}

/// The contract table holds exactly the `(knext.v1.auth)` option every RPC
/// in `proto/` states. Parsed from the proto source, so an RPC added there
/// without an entry here (or with a different option) reds this test.
#[test]
fn contract_auth_matches_the_proto_source() {
    let proto_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("proto");
    let mut stated = Vec::new();
    for entry in walk(&proto_dir) {
        if entry.starts_with(proto_dir.join("knext")) {
            continue;
        }
        stated.extend(rpcs_in(&fs::read_to_string(&entry).unwrap()));
    }
    assert!(stated.len() >= 2, "found {} RPCs in proto/", stated.len());
    for (procedure, option) in &stated {
        let want = match option.as_deref() {
            Some("AUTH_USER") => Auth::AUTH_USER,
            Some("AUTH_PUBLIC") => Auth::AUTH_PUBLIC,
            _ => Auth::AUTH_UNSPECIFIED,
        };
        assert_eq!(contract_auth(procedure), want, "{procedure}");
    }
    for unknown in [
        "",
        "/",
        "/example.v1.ExampleService/NoSuchMethod",
        "/example.v1.ExampleService/GetItem/",
        "/grpc.health.v1.Health/Check",
    ] {
        assert_eq!(
            contract_auth(unknown),
            Auth::AUTH_UNSPECIFIED,
            "{unknown:?}"
        );
    }
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else if path.extension().is_some_and(|e| e == "proto") {
            out.push(path);
        }
    }
    out
}

/// `(/package.Service/Method, auth option)` for every rpc in a proto file.
fn rpcs_in(source: &str) -> Vec<(String, Option<String>)> {
    let text: String = source
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let package = text
        .split("package ")
        .nth(1)
        .and_then(|rest| rest.split(';').next())
        .expect("a package statement")
        .trim()
        .to_owned();
    let mut out = Vec::new();
    for service_block in text.split("service ").skip(1) {
        let service = service_block.split_whitespace().next().unwrap().to_owned();
        for rpc in service_block.split("rpc ").skip(1) {
            let name = rpc.split('(').next().unwrap().trim().to_owned();
            // The rpc's own options run to the end of its body.
            let body = match (rpc.find('{'), rpc.find(';')) {
                (Some(open), Some(semi)) if open < semi => &rpc[open..rpc.find('}').unwrap()],
                _ => "",
            };
            let option = body
                .split("(knext.v1.auth)")
                .nth(1)
                .and_then(|rest| rest.split(';').next())
                .map(|v| v.trim_start_matches([' ', '=']).trim().to_owned());
            out.push((format!("/{package}.{service}/{name}"), option));
        }
    }
    out
}
