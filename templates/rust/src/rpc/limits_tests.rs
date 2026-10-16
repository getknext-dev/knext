//! The request-read bounds and the connection lifecycle, on a loopback
//! socket: decompression stops at the message limit, a request body is cut
//! off at the body cap and at the read timeout (which bounds the body, not
//! the call), silent and idle connections are closed, and SIGTERM drains
//! in-flight calls within the grace.

use std::io::Write as _;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use bytes::Bytes;
use flate2::Compression;
use flate2::write::GzEncoder;
use futures_util::stream;
use http::Request;
use http_body_util::StreamBody;
use hyper::body::Frame;
use hyper_util::rt::{TokioExecutor, TokioIo};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::time::timeout;

use super::testkit::*;
use super::*;
use crate::proto::example::v1::PutItemRequest;
use buffa::Message;

/// 256 MiB of zeros, gzipped to about 256 KiB: a decompression bomb.
fn bomb() -> &'static Bytes {
    static BOMB: OnceLock<Bytes> = OnceLock::new();
    BOMB.get_or_init(|| {
        let mut gz = GzEncoder::new(Vec::new(), Compression::best());
        let chunk = vec![0u8; 1 << 20];
        for _ in 0..256 {
            gz.write_all(&chunk).unwrap();
        }
        Bytes::from(gz.finish().unwrap())
    })
}

const BOUND: Duration = Duration::from_secs(5);

async fn bounded<F: Future>(what: &str, f: F) -> F::Output {
    let started = Instant::now();
    let out = timeout(BOUND, f)
        .await
        .unwrap_or_else(|_| panic!("{what}: not refused within {BOUND:?}"));
    assert!(started.elapsed() < BOUND, "{what}");
    out
}

/// The health check takes a body with no token, so a small compressed body
/// sent to it must not cost the server gigabytes of inflating.
#[tokio::test]
async fn gzip_bomb_to_the_health_check_is_refused_in_bounded_time() {
    let running = start(function(None, Timeouts::default())).await;
    let connect = post(
        running.addr,
        HEALTH_CHECK,
        &[
            ("content-type", "application/proto"),
            ("content-encoding", "gzip"),
        ],
        bomb().clone(),
    );
    let resp = bounded("connect", raw(running.addr, Transport::Http1, connect))
        .await
        .unwrap();
    assert_eq!(
        bounded("connect", outcome(resp)).await.as_deref(),
        Some("resource_exhausted")
    );

    let grpc = post(
        running.addr,
        HEALTH_CHECK,
        &[
            ("content-type", "application/grpc"),
            ("grpc-encoding", "gzip"),
            ("te", "trailers"),
        ],
        envelope(true, bomb()),
    );
    let resp = bounded("grpc", raw(running.addr, Transport::H2c, grpc))
        .await
        .unwrap();
    assert_eq!(bounded("grpc", outcome(resp)).await.as_deref(), Some("8"));
    running.stop().await.unwrap();
}

/// Past the token, every message is inflated only up to MAX_REQUEST_BYTES.
#[tokio::test]
async fn gzip_bomb_to_an_rpc_stops_at_the_message_limit() {
    let running = start(function(admit(), Timeouts::default())).await;
    let headers = [
        ("content-type", "application/proto"),
        ("content-encoding", "gzip"),
        ("authorization", "Bearer a.b.c"),
    ];
    let req = post(running.addr, PUT_ITEM, &headers, bomb().clone());
    let resp = bounded("PutItem", raw(running.addr, Transport::H2c, req))
        .await
        .unwrap();
    assert_eq!(
        bounded("PutItem", outcome(resp)).await.as_deref(),
        Some("resource_exhausted")
    );
    running.stop().await.unwrap();
}

/// Only gzip is accepted: a zstd body is refused as `unimplemented`, on the
/// health check (the one route that reads a body without a token) and on an
/// RPC past the token, over Connect and gRPC.
#[tokio::test]
async fn a_zstd_request_is_refused() {
    let running = start(function(admit(), Timeouts::default())).await;
    let message = PutItemRequest {
        id: "z".into(),
        value: "zstd".into(),
        ..Default::default()
    }
    .encode_to_vec();
    let compressed = Bytes::from(zstd::encode_all(&message[..], 3).unwrap());
    for procedure in [HEALTH_CHECK, PUT_ITEM] {
        let connect = post(
            running.addr,
            procedure,
            &[
                ("content-type", "application/proto"),
                ("content-encoding", "zstd"),
                ("authorization", "Bearer a.b.c"),
            ],
            compressed.clone(),
        );
        let resp = raw(running.addr, Transport::Http1, connect).await.unwrap();
        assert_eq!(
            outcome(resp).await.as_deref(),
            Some("unimplemented"),
            "connect {procedure}"
        );

        let grpc = post(
            running.addr,
            procedure,
            &[
                ("content-type", "application/grpc"),
                ("grpc-encoding", "zstd"),
                ("te", "trailers"),
                ("authorization", "Bearer a.b.c"),
            ],
            envelope(true, &compressed),
        );
        let resp = raw(running.addr, Transport::H2c, grpc).await.unwrap();
        assert_eq!(
            outcome(resp).await.as_deref(),
            Some("12"),
            "grpc {procedure}"
        );
    }
    running.stop().await.unwrap();
}

/// A body that never ends: frames of `chunk` bytes, sent as fast as the
/// server takes them, until the receiver is dropped.
fn endless(
    chunk: Bytes,
) -> StreamBody<impl futures_util::Stream<Item = Result<Frame<Bytes>, std::io::Error>>> {
    StreamBody::new(stream::repeat_with(move || Ok(Frame::data(chunk.clone()))))
}

/// A request body longer than MAX_REQUEST_BODY_BYTES is cut off there, even
/// on a client stream whose messages are each small.
#[tokio::test]
async fn an_endless_body_is_cut_off() {
    let running = start(function(admit(), Timeouts::default())).await;
    // Valid messages, so the stream is not ended by a decode error.
    let message = envelope(
        false,
        &PutItemRequest {
            id: "x".into(),
            value: "y".repeat(16 << 10),
            ..Default::default()
        }
        .encode_to_vec(),
    );
    let req = Request::post(format!("http://{}{SINK}", running.addr))
        .header("content-type", "application/grpc")
        .header("te", "trailers")
        .header("authorization", "Bearer a.b.c")
        .body(endless(message))
        .unwrap();
    let resp = timeout(
        Duration::from_secs(20),
        raw(running.addr, Transport::H2c, req),
    )
    .await
    .expect("the server read an endless client stream for 20s")
    .unwrap();
    let status = timeout(Duration::from_secs(20), outcome(resp))
        .await
        .expect("the server read an endless client stream for 20s");
    assert!(status.is_some(), "an endless body was served");
    running.stop().await.unwrap();
}

/// A request body that stops arriving is cut off at the read timeout, over
/// HTTP/1.1 and h2c, on the one route that takes a body without a token.
#[tokio::test]
async fn a_stalled_body_is_cut_off() {
    let timeouts = Timeouts {
        read: Duration::from_millis(500),
        ..Timeouts::default()
    };
    let running = start(function(None, timeouts)).await;
    for transport in [Transport::Http1, Transport::H2c] {
        let (tx, rx) = mpsc::channel::<Result<Frame<Bytes>, std::io::Error>>(1);
        tx.send(Ok(Frame::data(Bytes::from_static(&[0x0a]))))
            .await
            .unwrap();
        let body = StreamBody::new(tokio_stream_from(rx));
        let req = Request::post(format!("http://{}{HEALTH_CHECK}", running.addr))
            .header("content-type", "application/proto")
            .body(body)
            .unwrap();
        let resp = timeout(Duration::from_secs(5), raw(running.addr, transport, req))
            .await
            .unwrap_or_else(|_| panic!("{transport:?}: a stalled body held the call open"));
        if let Ok(resp) = resp {
            let status = timeout(Duration::from_secs(5), outcome(resp))
                .await
                .unwrap_or_else(|_| panic!("{transport:?}: a stalled body held the call open"));
            assert!(status.is_some(), "{transport:?}: a stalled body was served");
        }
        drop(tx);
    }
    running.stop().await.unwrap();
}

fn tokio_stream_from<T: Send + 'static>(
    mut rx: mpsc::Receiver<T>,
) -> impl futures_util::Stream<Item = T> {
    stream::poll_fn(move |cx| rx.poll_recv(cx))
}

/// The read timeout bounds the request body, not the call: a handler may run
/// longer once the body has arrived.
#[tokio::test]
async fn the_read_timeout_bounds_the_body_not_the_call() {
    let timeouts = Timeouts {
        read: Duration::from_millis(300),
        ..Timeouts::default()
    };
    assert!(SLOW_HANDLER > timeouts.read * 3);
    let running = start(function(admit(), timeouts)).await;
    let headers = [
        ("content-type", "application/proto"),
        ("authorization", "Bearer a.b.c"),
    ];
    for transport in [Transport::Http1, Transport::H2c] {
        let resp = raw(
            running.addr,
            transport,
            post(running.addr, SLOW, &headers, Bytes::new()),
        )
        .await
        .unwrap();
        assert_eq!(outcome(resp).await, None, "{transport:?}");
    }
    running.stop().await.unwrap();
}

/// A connection that sends nothing is closed after the header read timeout.
#[tokio::test]
async fn a_silent_connection_is_closed() {
    let timeouts = Timeouts {
        header_read: Duration::from_millis(300),
        ..Timeouts::default()
    };
    let running = start(function(None, timeouts)).await;
    for opening in [
        &b""[..],
        b"PRI * HTTP/2.0\r\n",
        b"POST /grpc.health.v1.Health/Check HTTP/1.1\r\n",
    ] {
        let mut socket = TcpStream::connect(running.addr).await.unwrap();
        socket.write_all(opening).await.unwrap();
        let mut buf = [0u8; 1024];
        let read = timeout(Duration::from_secs(3), async {
            loop {
                match socket.read(&mut buf).await {
                    Ok(0) | Err(_) => return,
                    Ok(_) => {}
                }
            }
        })
        .await;
        assert!(
            read.is_ok(),
            "a connection that sent {opening:?} was kept open"
        );
    }
    running.stop().await.unwrap();
}

/// An h2c connection with no call in flight is closed after the idle timeout.
#[tokio::test]
async fn an_idle_connection_is_closed() {
    let timeouts = Timeouts {
        idle: Duration::from_millis(500),
        ..Timeouts::default()
    };
    let running = start(function(None, timeouts)).await;
    let stream = TcpStream::connect(running.addr).await.unwrap();
    let (mut send, conn) =
        hyper::client::conn::http2::handshake(TokioExecutor::new(), TokioIo::new(stream))
            .await
            .unwrap();
    let conn = tokio::spawn(conn);
    let req = post(
        running.addr,
        HEALTH_CHECK,
        &[("content-type", "application/proto")],
        Bytes::new(),
    );
    let resp = send.send_request(req).await.unwrap();
    assert_eq!(outcome(resp).await, None);
    let closed = timeout(Duration::from_secs(5), conn).await;
    assert!(
        closed.is_ok(),
        "an idle connection was kept open past the idle timeout"
    );
    running.stop().await.unwrap();
}

/// SIGTERM stops accepting, lets an in-flight call finish, then returns.
#[tokio::test]
async fn an_in_flight_call_survives_shutdown() {
    let mut running = start(function(admit(), Timeouts::default())).await;
    let addr = running.addr;
    let headers = [
        ("content-type", "application/proto"),
        ("authorization", "Bearer a.b.c"),
    ];
    let call = tokio::spawn(async move {
        let resp = raw(
            addr,
            Transport::H2c,
            post(addr, SLOW, &headers, Bytes::new()),
        )
        .await?;
        Ok::<_, hyper::Error>(outcome(resp).await)
    });
    let started = Instant::now();
    tokio::time::sleep(Duration::from_millis(300)).await;
    running.begin_stop();
    let stopped = timeout(Duration::from_secs(10), running.join())
        .await
        .unwrap();
    // serve returns only once the call is done: not before its handler ran.
    assert!(
        started.elapsed() >= SLOW_HANDLER - Duration::from_millis(100),
        "serve returned after {:?}, with the call still in flight",
        started.elapsed()
    );
    assert!(stopped.is_ok(), "{stopped:?}");
    let served = timeout(Duration::from_secs(10), call)
        .await
        .expect("the in-flight call did not finish")
        .unwrap();
    assert!(
        matches!(served, Ok(None)),
        "the in-flight call was cut: {served:?}"
    );
    assert!(
        TcpStream::connect(addr).await.is_err(),
        "still accepting after shutdown"
    );
}

/// A call that outlives the grace makes `serve` return an error, so the
/// process exits non-zero rather than claim a clean drain.
#[tokio::test]
async fn a_call_past_the_grace_is_an_error() {
    let timeouts = Timeouts {
        shutdown_grace: Duration::from_millis(200),
        ..Timeouts::default()
    };
    let mut running = start(function(admit(), timeouts)).await;
    let addr = running.addr;
    let headers = [
        ("content-type", "application/proto"),
        ("authorization", "Bearer a.b.c"),
    ];
    let _call = tokio::spawn(async move {
        raw(
            addr,
            Transport::H2c,
            post(addr, SLOW, &headers, Bytes::new()),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    running.begin_stop();
    let stopped = timeout(Duration::from_secs(5), running.join())
        .await
        .unwrap();
    assert!(
        stopped.is_err(),
        "serve claimed a clean drain with a call in flight"
    );
}
