//! The harness the server tests share: a function served on a loopback
//! port, a test router with fault routes beside the example service, a
//! verifier that admits every token, and raw HTTP/1.1 and h2c requests.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use connectrpc::client::{ClientConfig, HttpClient};
use connectrpc::{
    Protocol, RequestContext, Response, Router, ServiceStream, client_streaming_handler_fn,
    handler_fn,
};
use futures_util::StreamExt;
use http::{Request, StatusCode};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::{Config, Function, Timeouts, build, example_router};
use crate::auth::{AuthError, Verifier};
use crate::connect::example::v1::ExampleServiceClient;
use crate::proto::example::v1::{PutItemRequest, PutItemResponse};

pub const GET_ITEM: &str = "/example.v1.ExampleService/GetItem";
pub const PUT_ITEM: &str = "/example.v1.ExampleService/PutItem";
pub const HEALTH_CHECK: &str = "/grpc.health.v1.Health/Check";
pub const PANIC: &str = "/test.v1.Fault/Panic";
pub const SLOW: &str = "/test.v1.Fault/Slow";
pub const SINK: &str = "/test.v1.Sink/Drain";

/// How long the slow route's handler takes, after its request has arrived.
pub const SLOW_HANDLER: Duration = Duration::from_millis(1500);

/// Admits every token. Tests only: the binary never builds one.
pub struct AdmitAll;

impl Verifier for AdmitAll {
    fn verify(&self, _token: &str, _procedure: &str) -> Result<(), AuthError> {
        Ok(())
    }
}

pub fn admit() -> Option<Arc<dyn Verifier>> {
    Some(Arc::new(AdmitAll))
}

/// The example router plus three fault routes: a handler that panics, one
/// that is slow, and a client stream that reads until its input ends.
pub fn test_router() -> Router {
    example_router()
        .route(
            "test.v1.Fault",
            "Panic",
            handler_fn(|_ctx: RequestContext, _req: PutItemRequest| async move {
                if true {
                    panic!("handler bug");
                }
                Response::ok(PutItemResponse::default())
            }),
        )
        .route(
            "test.v1.Fault",
            "Slow",
            handler_fn(|_ctx: RequestContext, _req: PutItemRequest| async move {
                tokio::time::sleep(SLOW_HANDLER).await;
                Response::ok(PutItemResponse::default())
            }),
        )
        .route_client_stream(
            "test.v1.Sink",
            "Drain",
            client_streaming_handler_fn(
                |_ctx: RequestContext, mut requests: ServiceStream<PutItemRequest>| async move {
                    while let Some(item) = requests.next().await {
                        item?;
                    }
                    Response::ok(PutItemResponse::default())
                },
            ),
        )
}

pub fn function(verifier: Option<Arc<dyn Verifier>>, timeouts: Timeouts) -> Function {
    build(
        test_router(),
        verifier,
        Config {
            timeouts,
            ..Config::default()
        },
    )
}

/// A function serving on a loopback port until [`Running::stop`].
pub struct Running {
    pub addr: SocketAddr,
    stop: Option<oneshot::Sender<()>>,
    done: JoinHandle<io::Result<()>>,
}

impl Running {
    /// Triggers the shutdown and returns what `serve` returned.
    pub async fn stop(mut self) -> io::Result<()> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.done.await.expect("serve panicked")
    }

    /// Triggers the shutdown without waiting for `serve` to return.
    pub fn begin_stop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }

    pub async fn join(self) -> io::Result<()> {
        self.done.await.expect("serve panicked")
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

pub async fn start(function: Function) -> Running {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (stop, stopped) = oneshot::channel::<()>();
    let done = tokio::spawn(function.serve(listener, async move {
        let _ = stopped.await;
    }));
    Running {
        addr,
        stop: Some(stop),
        done,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transport {
    Http1,
    H2c,
}

/// One row of the protocol matrix.
#[derive(Debug, Clone, Copy)]
pub struct Wire {
    pub name: &'static str,
    pub protocol: Protocol,
    pub json: bool,
    pub transport: Transport,
}

pub const MATRIX: [Wire; 6] = [
    Wire {
        name: "connect proto, HTTP/1.1",
        protocol: Protocol::Connect,
        json: false,
        transport: Transport::Http1,
    },
    Wire {
        name: "connect proto, h2c",
        protocol: Protocol::Connect,
        json: false,
        transport: Transport::H2c,
    },
    Wire {
        name: "connect JSON, HTTP/1.1",
        protocol: Protocol::Connect,
        json: true,
        transport: Transport::Http1,
    },
    Wire {
        name: "grpc, h2c",
        protocol: Protocol::Grpc,
        json: false,
        transport: Transport::H2c,
    },
    Wire {
        name: "grpc-web, HTTP/1.1",
        protocol: Protocol::GrpcWeb,
        json: false,
        transport: Transport::Http1,
    },
    Wire {
        name: "grpc-web, h2c",
        protocol: Protocol::GrpcWeb,
        json: false,
        transport: Transport::H2c,
    },
];

pub fn config(running: &Running, wire: Wire, token: Option<&str>) -> ClientConfig {
    let mut config = ClientConfig::new(running.url().parse().unwrap()).with_protocol(wire.protocol);
    if wire.json {
        config = config.json();
    }
    if let Some(token) = token {
        config = config.with_default_header("authorization", format!("Bearer {token}"));
    }
    config.with_default_timeout(Duration::from_secs(10))
}

pub fn http(wire: Wire) -> HttpClient {
    match wire.transport {
        Transport::Http1 => HttpClient::plaintext(),
        Transport::H2c => HttpClient::plaintext_http2_only(),
    }
}

pub fn example(
    running: &Running,
    wire: Wire,
    token: Option<&str>,
) -> ExampleServiceClient<HttpClient> {
    ExampleServiceClient::new(http(wire), config(running, wire, token))
}

pub fn health(running: &Running, wire: Wire) -> connectrpc_health::HealthClient<HttpClient> {
    connectrpc_health::HealthClient::new(http(wire), config(running, wire, None))
}

/// Sends one raw request on a new connection.
pub async fn raw<B>(
    addr: SocketAddr,
    transport: Transport,
    req: Request<B>,
) -> hyper::Result<http::Response<Incoming>>
where
    B: hyper::body::Body<Data = Bytes> + Send + Unpin + 'static,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let stream = TcpStream::connect(addr).await.unwrap();
    match transport {
        Transport::Http1 => {
            let (mut send, conn) =
                hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
            tokio::spawn(conn);
            send.send_request(req).await
        }
        Transport::H2c => {
            let (mut send, conn) =
                hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(stream))
                    .await?;
            tokio::spawn(conn);
            send.send_request(req).await
        }
    }
}

/// A POST of `body` to `procedure` with the given headers.
pub fn post(
    addr: SocketAddr,
    procedure: &str,
    headers: &[(&str, &str)],
    body: Bytes,
) -> Request<Full<Bytes>> {
    let mut builder = Request::post(format!("http://{addr}{procedure}"));
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    builder.body(Full::new(body)).unwrap()
}

/// A gRPC length-prefixed message.
pub fn envelope(compressed: bool, message: &[u8]) -> Bytes {
    let mut out = Vec::with_capacity(5 + message.len());
    out.push(u8::from(compressed));
    out.extend_from_slice(&u32::try_from(message.len()).unwrap().to_be_bytes());
    out.extend_from_slice(message);
    Bytes::from(out)
}

/// The outcome of a raw call: the Connect error `code`, the gRPC status
/// (header, trailer or gRPC-Web trailer frame), or `None` when it was served.
pub async fn outcome(resp: http::Response<Incoming>) -> Option<String> {
    let status = resp.status();
    let header_status = resp
        .headers()
        .get("grpc-status")
        .map(|v| v.to_str().unwrap().to_owned());
    let collected = resp.into_body().collect().await.ok()?;
    let trailer_status = collected
        .trailers()
        .and_then(|t| t.get("grpc-status"))
        .map(|v| v.to_str().unwrap().to_owned());
    let body = collected.to_bytes();
    if status != StatusCode::OK {
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
        return Some(
            json["code"]
                .as_str()
                .unwrap_or("non-200 without a code")
                .to_owned(),
        );
    }
    let web = crate::testutil::grpc_web_trailer(&body, "grpc-status");
    match header_status.or(trailer_status).or(web) {
        Some(code) if code != "0" => Some(code),
        _ => None,
    }
}
