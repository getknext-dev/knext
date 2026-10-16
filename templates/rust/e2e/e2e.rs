//! Calls the function deployed on a kind cluster with Knative, the way its
//! zone does: through the cluster-local gateway, over h2c, by the function's
//! cluster-local host name. `kind-e2e.sh` deploys it and runs this with
//! `--features e2e`; it is never part of `cargo test`.

use std::time::Duration;

use bytes::Bytes;
use connectrpc::client::{ClientConfig, Http2Connection, SharedHttp2Connection};
use connectrpc::{ErrorCode, Protocol};
use connectrpc_health::HealthClient;
use connectrpc_health::wire::{HealthCheckRequest, ServingStatus};
use function::connect::example::v1::ExampleServiceClient;
use function::proto::example::v1::{GetItemRequest, PutItemRequest};
use http::{Request, Uri};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::net::TcpStream;

fn env(name: &str) -> String {
    std::env::var(name)
        .unwrap_or_else(|_| panic!("{name} is not set; run this through kind-e2e.sh"))
}

/// The gateway's port-forwarded address, as host:port.
fn gateway(var: &str) -> String {
    env(var).trim_start_matches("http://").to_owned()
}

/// An h2c connection to the cluster-local gateway whose `:authority` is the
/// function's cluster-local host name, which is what Knative routes on.
fn h2c() -> SharedHttp2Connection {
    let addr = gateway("KNEXT_E2E_INTERNAL_URL");
    let connector = tower::service_fn(move |_uri: Uri| {
        let addr = addr.clone();
        async move { Ok::<_, std::io::Error>(TokioIo::new(TcpStream::connect(addr).await?)) }
    });
    let authority: Uri = format!("http://{}", env("KNEXT_E2E_HOST")).parse().unwrap();
    Http2Connection::lazy_with_connector(connector, authority).shared(8)
}

const PROTOCOLS: [(&str, Protocol); 3] = [
    ("connect", Protocol::Connect),
    ("grpc", Protocol::Grpc),
    ("grpc-web", Protocol::GrpcWeb),
];

fn config(protocol: Protocol, authorization: Option<&str>) -> ClientConfig {
    let base: Uri = format!("http://{}", env("KNEXT_E2E_HOST")).parse().unwrap();
    let mut config = ClientConfig::new(base)
        .with_protocol(protocol)
        // A cold start through the activator is part of the call.
        .with_default_timeout(Duration::from_secs(60));
    if let Some(value) = authorization {
        config = config.with_default_header("authorization", value.to_owned());
    }
    config
}

#[tokio::test]
async fn health_check_is_served_without_a_token() {
    for (name, protocol) in PROTOCOLS {
        let res = HealthClient::new(h2c(), config(protocol, None))
            .check(HealthCheckRequest::default())
            .await
            .unwrap_or_else(|e| panic!("{name}: health Check: {e:?}"))
            .into_owned();
        assert_eq!(res.status, ServingStatus::SERVING, "{name}");
        println!("{name}: health Check SERVING");
    }
}

#[tokio::test]
async fn every_other_rpc_is_refused() {
    for (name, protocol) in PROTOCOLS {
        for authorization in [None, Some("Bearer forged.jwt.token")] {
            let client = ExampleServiceClient::new(h2c(), config(protocol, authorization));
            let err = client
                .get_item(GetItemRequest {
                    id: "a".into(),
                    ..Default::default()
                })
                .await
                .unwrap_err();
            assert_eq!(
                err.code,
                ErrorCode::Unauthenticated,
                "{name} GetItem {authorization:?}: {err:?}"
            );
            let err = client
                .put_item(PutItemRequest {
                    id: "a".into(),
                    value: "b".into(),
                    ..Default::default()
                })
                .await
                .unwrap_err();
            assert_eq!(
                err.code,
                ErrorCode::Unauthenticated,
                "{name} PutItem {authorization:?}: {err:?}"
            );
        }
        println!("{name}: GetItem and PutItem refused with unauthenticated");
    }
}

/// One raw request over a new h2c connection to `addr`, or HTTP/1.1.
async fn raw(
    addr: &str,
    h2: bool,
    req: Request<Full<Bytes>>,
) -> http::Response<hyper::body::Incoming> {
    let stream = TcpStream::connect(addr).await.unwrap();
    if h2 {
        let (mut send, conn) =
            hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(stream))
                .await
                .unwrap();
        tokio::spawn(conn);
        send.send_request(req).await.unwrap()
    } else {
        let (mut send, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .unwrap();
        tokio::spawn(conn);
        send.send_request(req).await.unwrap()
    }
}

/// The gRPC status of a refusal survives Kourier, the activator and the
/// queue-proxy: a raw gRPC request gets grpc-status 16 over HTTP/2.
#[tokio::test]
async fn raw_grpc_status_survives_the_gateway() {
    let req = Request::post(format!(
        "http://{}/example.v1.ExampleService/PutItem",
        env("KNEXT_E2E_HOST")
    ))
    .header("content-type", "application/grpc+proto")
    .header("te", "trailers")
    .body(Full::new(Bytes::from_static(&[0, 0, 0, 0, 0])))
    .unwrap();
    let resp = raw(&gateway("KNEXT_E2E_INTERNAL_URL"), true, req).await;
    let version = resp.version();
    let status = resp.status();
    let header = resp.headers().get("grpc-status").cloned();
    let collected = resp.into_body().collect().await.unwrap();
    let grpc_status = collected
        .trailers()
        .and_then(|t| t.get("grpc-status").cloned())
        .or(header)
        .map(|v| v.to_str().unwrap().to_owned());
    assert_eq!(
        (version, status.as_u16(), grpc_status.as_deref()),
        (http::Version::HTTP_2, 200, Some("16")),
        "raw gRPC PutItem; want HTTP/2 200 grpc-status 16"
    );
    println!("raw gRPC PutItem: HTTP/2 200 grpc-status 16");
}

/// Connect GET, the cacheable form of a read, is refused like a POST.
#[tokio::test]
async fn connect_get_is_refused() {
    // An empty GetItemRequest.
    let url = format!(
        "http://{}/example.v1.ExampleService/GetItem?connect=v1&encoding=proto&message=",
        env("KNEXT_E2E_HOST")
    );
    let resp = raw(
        &gateway("KNEXT_E2E_INTERNAL_URL"),
        true,
        Request::get(url).body(Full::new(Bytes::new())).unwrap(),
    )
    .await;
    assert_eq!(
        resp.status(),
        http::StatusCode::UNAUTHORIZED,
        "Connect GET GetItem"
    );
    println!("connect GET GetItem: 401");
}

/// The function has no public route: the public gateway does not serve it,
/// by its cluster-local name or by the name a public route would have.
#[tokio::test]
async fn no_public_route() {
    for host in [env("KNEXT_E2E_HOST"), env("KNEXT_E2E_PUBLIC_HOST")] {
        let req = Request::post("/grpc.health.v1.Health/Check")
            .header("host", &host)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from_static(b"{}")))
            .unwrap();
        let resp = raw(&gateway("KNEXT_E2E_PUBLIC_URL"), false, req).await;
        assert_eq!(
            resp.status(),
            http::StatusCode::NOT_FOUND,
            "public gateway, Host {host}: want 404"
        );
        println!("public gateway, Host {host}: 404");
    }
}
