//! The assembled server, called over a loopback socket: the protocol matrix,
//! the fail-closed wiring of the production constructor, tracing, panic
//! recovery and the message limit. The request-read bounds and the drain are
//! in `limits_tests`.

use std::time::Duration;

use bytes::Bytes;
use connectrpc::ErrorCode;
use connectrpc_health::wire::{HealthCheckRequest, ServingStatus};
use http::Request;
use http_body_util::Full;
use opentelemetry::global::BoxedTracer;
use opentelemetry::trace::{SpanId, TraceId, TracerProvider as _};
use opentelemetry_sdk::trace::{InMemorySpanExporter, SdkTracerProvider};

use super::testkit::*;
use super::*;
use crate::proto::example::v1::{GetItemRequest, PutItemRequest};

// Tested against the knext repository's shared token vectors, which a copy of
// this template made by `knext add function` does not have: that copy has no
// `shared-vectors` feature and none of this.
#[cfg(feature = "shared-vectors")]
mod vector_wiring;

fn get(id: &str) -> GetItemRequest {
    GetItemRequest {
        id: id.into(),
        ..Default::default()
    }
}

fn put(id: &str, value: &str) -> PutItemRequest {
    PutItemRequest {
        id: id.into(),
        value: value.into(),
        ..Default::default()
    }
}

/// The production constructor with nothing mounted at the JWKS path.
fn production() -> Function {
    new(Config {
        jwks_path: std::env::temp_dir().join("knext-fn-no-such-dir/jwks.json"),
        ..Config::default()
    })
}

/// Every protocol the function speaks, over HTTP/1.1 and h2c: the health
/// check is served without a token, the example RPCs are refused without a
/// verifier that admits them and served with one.
#[tokio::test]
async fn protocol_matrix() {
    let closed = start(production()).await;
    let open = start(function(admit(), Timeouts::default())).await;
    for wire in MATRIX {
        let check = health(&closed, wire)
            .check(HealthCheckRequest::default())
            .await
            .unwrap_or_else(|e| panic!("{}: health Check: {e:?}", wire.name))
            .into_owned();
        assert_eq!(check.status, ServingStatus::SERVING, "{}", wire.name);

        for token in [None, Some("forged.jwt.token")] {
            let client = example(&closed, wire, token);
            let err = client.get_item(get("a")).await.unwrap_err();
            assert_eq!(
                err.code,
                ErrorCode::Unauthenticated,
                "{} GetItem {token:?}",
                wire.name
            );
            let err = client.put_item(put("a", "b")).await.unwrap_err();
            assert_eq!(
                err.code,
                ErrorCode::Unauthenticated,
                "{} PutItem {token:?}",
                wire.name
            );
        }

        let client = example(&open, wire, Some("a.b.c"));
        let id = format!("item-{}", wire.name);
        client
            .put_item(put(&id, "value"))
            .await
            .unwrap_or_else(|e| panic!("{}: PutItem {e:?}", wire.name));
        let item = client.get_item(get(&id)).await.unwrap().into_owned();
        assert_eq!(item.value, "value", "{}", wire.name);
        let err = client.get_item(get("missing")).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{}", wire.name);
    }
    closed.stop().await.unwrap();
    open.stop().await.unwrap();
}

/// Connect GET (the cacheable form of a NO_SIDE_EFFECTS read) is refused
/// without a token and served with one.
#[tokio::test]
async fn connect_get() {
    use base64::Engine;
    use buffa::Message;
    let closed = start(production()).await;
    let open = start(function(admit(), Timeouts::default())).await;
    example(&open, MATRIX[0], Some("a.b.c"))
        .put_item(put("g", "v"))
        .await
        .unwrap();
    let message = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(get("g").encode_to_vec());
    for transport in [Transport::Http1, Transport::H2c] {
        for (running, token, want) in [
            (&closed, None, Some("unauthenticated")),
            (&closed, Some("Bearer a.b.c"), Some("unauthenticated")),
            (&open, Some("Bearer a.b.c"), None),
        ] {
            let mut req = Request::get(format!(
                "http://{}{GET_ITEM}?connect=v1&encoding=proto&base64=1&message={message}",
                running.addr
            ));
            if let Some(token) = token {
                req = req.header("authorization", token);
            }
            let resp = raw(
                running.addr,
                transport,
                req.body(Full::new(Bytes::new())).unwrap(),
            )
            .await
            .unwrap();
            assert_eq!(
                outcome(resp).await.as_deref(),
                want,
                "{transport:?} {token:?}"
            );
        }
    }
    closed.stop().await.unwrap();
    open.stop().await.unwrap();
}

/// The binary's own constructor fails closed on the wire: every registered
/// procedure except the health check is refused, over Connect on HTTP/1.1
/// and gRPC on h2c, with no token and with a forged one.
#[tokio::test]
async fn production_wiring_fails_closed_on_the_wire() {
    let function = production();
    let procedures: Vec<String> = function.procedures().map(str::to_owned).collect();
    assert!(procedures.iter().any(|p| p == GET_ITEM), "{procedures:?}");
    assert!(procedures.iter().any(|p| p == PUT_ITEM), "{procedures:?}");
    assert!(
        procedures.iter().any(|p| p == HEALTH_CHECK),
        "{procedures:?}"
    );
    let running = start(function).await;
    let mut refused = 0;
    for procedure in procedures.iter().filter(|p| p.as_str() != HEALTH_CHECK) {
        for token in [None, Some("Bearer forged.jwt.token")] {
            let mut headers = vec![("content-type", "application/proto")];
            if let Some(token) = token {
                headers.push(("authorization", token));
            }
            let resp = raw(
                running.addr,
                Transport::Http1,
                post(running.addr, procedure, &headers, Bytes::new()),
            )
            .await
            .unwrap();
            assert_eq!(
                resp.status(),
                http::StatusCode::UNAUTHORIZED,
                "connect {procedure} {token:?}"
            );
            assert_eq!(outcome(resp).await.as_deref(), Some("unauthenticated"));

            headers[0] = ("content-type", "application/grpc");
            headers.push(("te", "trailers"));
            let req = post(running.addr, procedure, &headers, envelope(false, &[]));
            let resp = raw(running.addr, Transport::H2c, req).await.unwrap();
            let status = tokio::time::timeout(Duration::from_secs(5), outcome(resp))
                .await
                .unwrap_or_else(|_| {
                    panic!("grpc {procedure} {token:?}: still streaming, so it was served")
                });
            assert_eq!(status.as_deref(), Some("16"), "grpc {procedure} {token:?}");
            refused += 1;
        }
    }
    assert!(refused >= 6, "only {refused} refusals checked");
    running.stop().await.unwrap();
}

/// Every RPC the function serves, except the health service, states its
/// `(knext.v1.auth)` option in the contract table. Scanned from the router,
/// so an RPC registered later without an entry reds here.
#[test]
fn every_served_rpc_states_its_auth() {
    use crate::proto::knext::v1::Auth;
    let function = production();
    let mut stated = 0;
    for procedure in function
        .procedures()
        .filter(|p| !p.starts_with("/grpc.health.v1.Health/"))
    {
        let auth = crate::auth::contract_auth(procedure);
        assert!(
            matches!(auth, Auth::AUTH_USER | Auth::AUTH_PUBLIC),
            "{procedure}: (knext.v1.auth) = {auth:?}; every served RPC must state AUTH_USER or AUTH_PUBLIC"
        );
        stated += 1;
    }
    assert_eq!(stated, 2, "GetItem and PutItem");
}

#[test]
fn server_settings() {
    assert_eq!(MAX_REQUEST_BYTES, 4 << 20);
    assert_eq!(MAX_REQUEST_BODY_BYTES, MAX_REQUEST_BYTES + (64 << 10));
    assert_eq!(
        Timeouts::default(),
        Timeouts {
            header_read: Duration::from_secs(10),
            read: Duration::from_secs(30),
            idle: Duration::from_secs(120),
            shutdown_grace: Duration::from_secs(25),
        }
    );
    assert_eq!(new(Config::default()).timeouts(), Timeouts::default());
    assert_eq!(
        Config::default().jwks_path,
        PathBuf::from(auth::DEFAULT_JWKS_PATH)
    );
}

/// Every call gets a span, refused calls included, continuing the caller's
/// W3C trace.
#[tokio::test]
async fn otel_continues_the_callers_trace() {
    let exporter = InMemorySpanExporter::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(exporter.clone())
        .build();
    let tracer = BoxedTracer::new(Box::new(provider.tracer("test")));
    let running = start(build(
        test_router(),
        None,
        Config {
            tracer: Some(tracer),
            ..Config::default()
        },
    ))
    .await;
    let trace_id = "4bf92f3577b34da6a3ce929d0e0e4736";
    let parent_id = "00f067aa0ba902b7";
    let headers = [
        ("content-type", "application/proto"),
        ("traceparent", &*format!("00-{trace_id}-{parent_id}-01")),
    ];
    let resp = raw(
        running.addr,
        Transport::Http1,
        post(running.addr, PUT_ITEM, &headers, Bytes::new()),
    )
    .await
    .unwrap();
    assert_eq!(outcome(resp).await.as_deref(), Some("unauthenticated"));
    running.stop().await.unwrap();
    provider.force_flush().unwrap();
    let spans = exporter.get_finished_spans().unwrap();
    let span = spans
        .iter()
        .find(|s| s.name.contains("example.v1.ExampleService/PutItem"))
        .unwrap_or_else(|| panic!("no span for PutItem in {spans:?}"));
    assert_eq!(
        span.span_context.trace_id(),
        TraceId::from_hex(trace_id).unwrap()
    );
    assert_eq!(span.parent_span_id, SpanId::from_hex(parent_id).unwrap());
}

/// A panicking handler answers `internal`, and the function keeps serving.
#[tokio::test]
async fn a_panicking_handler_answers_internal() {
    let running = start(function(admit(), Timeouts::default())).await;
    let headers = [
        ("content-type", "application/proto"),
        ("authorization", "Bearer a.b.c"),
    ];
    for _ in 0..2 {
        let resp = raw(
            running.addr,
            Transport::Http1,
            post(running.addr, PANIC, &headers, Bytes::new()),
        )
        .await
        .expect("the connection died with the handler");
        assert_eq!(outcome(resp).await.as_deref(), Some("internal"));
    }
    let check = health(&running, MATRIX[1])
        .check(HealthCheckRequest::default())
        .await;
    assert!(check.is_ok(), "{check:?}");
    running.stop().await.unwrap();
}

/// A message larger than MAX_REQUEST_BYTES is refused before the handler.
#[tokio::test]
async fn read_limit() {
    use buffa::Message;
    let running = start(function(admit(), Timeouts::default())).await;
    let big = put("big", &"x".repeat(MAX_REQUEST_BYTES + 1)).encode_to_vec();
    let headers = [
        ("content-type", "application/proto"),
        ("authorization", "Bearer a.b.c"),
    ];
    let resp = raw(
        running.addr,
        Transport::H2c,
        post(running.addr, PUT_ITEM, &headers, Bytes::from(big)),
    )
    .await
    .unwrap();
    assert_eq!(outcome(resp).await.as_deref(), Some("resource_exhausted"));
    let fits = put("fits", &"x".repeat(MAX_REQUEST_BYTES - 64)).encode_to_vec();
    let resp = raw(
        running.addr,
        Transport::H2c,
        post(running.addr, PUT_ITEM, &headers, Bytes::from(fits)),
    )
    .await
    .unwrap();
    assert_eq!(outcome(resp).await, None);
    running.stop().await.unwrap();
}
