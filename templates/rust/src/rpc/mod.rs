//! The function's server: the connect-rust service for the contract, the
//! gRPC health service, the layers in front of them (OpenTelemetry, panic
//! recovery, the request-body bounds, the token check), and an accept loop
//! that speaks HTTP/2 cleartext (h2c) and HTTP/1.1 on one port.
//!
//! The layers run in this order, the first outermost: every call is traced
//! (refusals included), a panic is contained, the request body is bounded,
//! and the token is checked before any of the body is read.

mod body;
mod layers;

use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use connectrpc::{
    CompressionRegistry, ConnectRpcBody, ConnectRpcService, GzipProvider, Limits, Router,
};
use http::{Request, Response};
use hyper::body::Incoming;
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use hyper_util::server::conn::auto::Builder as ConnBuilder;
use opentelemetry::global::{self, BoxedTracer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tower::util::BoxCloneService;
use tower::{ServiceBuilder, ServiceExt};

use crate::auth::{self, AuthLayer, Verifier};
use crate::connect::example::v1::{EXAMPLE_SERVICE_SERVICE_NAME, ExampleServiceExt};
use crate::items;

pub use body::{BodyError, BoundedBody};

/// Bounds one request message, both as sent and after it is decompressed.
pub const MAX_REQUEST_BYTES: usize = 4 << 20;

/// Bounds a whole request body as read off the wire: one message at
/// [`MAX_REQUEST_BYTES`] plus its framing. Reading stops there, on every
/// RPC, streaming ones included, instead of draining the rest.
pub const MAX_REQUEST_BODY_BYTES: usize = MAX_REQUEST_BYTES + (64 << 10);

/// How long a new connection may take to start a request, and an HTTP/1.1
/// request to send its headers.
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a request body may take to arrive, from the moment its headers
/// have. It bounds only the body, over h2c and HTTP/1.1 alike: once the body
/// is read, a call may run longer.
pub const READ_TIMEOUT: Duration = Duration::from_secs(30);

/// How long a connection with no call in flight is kept open.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// How long in-flight calls get to finish after `SIGTERM`.
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(25);

/// The server's timeouts. The default is the constants above; tests shorten
/// them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Timeouts {
    pub header_read: Duration,
    pub read: Duration,
    pub idle: Duration,
    pub shutdown_grace: Duration,
}

impl Default for Timeouts {
    fn default() -> Self {
        Self {
            header_read: HEADER_READ_TIMEOUT,
            read: READ_TIMEOUT,
            idle: IDLE_TIMEOUT,
            shutdown_grace: SHUTDOWN_GRACE,
        }
    }
}

/// The function's runtime configuration.
pub struct Config {
    /// The mounted JWKS file the token check reads.
    pub jwks_path: PathBuf,
    pub timeouts: Timeouts,
    /// Defaults to a tracer from the global OpenTelemetry provider, which is
    /// a no-op until the binary installs one.
    pub tracer: Option<BoxedTracer>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            jwks_path: PathBuf::from(auth::DEFAULT_JWKS_PATH),
            timeouts: Timeouts::default(),
            tracer: None,
        }
    }
}

type Stack = BoxCloneService<Request<Incoming>, Response<ConnectRpcBody>, Infallible>;

/// The assembled server.
pub struct Function {
    service: Stack,
    procedures: Vec<String>,
    timeouts: Timeouts,
}

/// Assembles the function with the token check reading the JWKS mounted at
/// `cfg.jwks_path`. This is the only constructor the binary uses.
pub fn new(cfg: Config) -> Function {
    let verifier: Arc<dyn Verifier> = Arc::new(auth::mounted_jwks(cfg.jwks_path.clone()));
    build(example_router(), Some(verifier), cfg)
}

/// The example service and the gRPC health service. Register your own
/// service here in place of the example one.
fn example_router() -> Router {
    let router = Arc::new(items::Service::new()).register(Router::new());
    // The health routes take at most 16 KiB per message (connectrpc-health's
    // own per-route limits), since the health check is served without a token.
    connectrpc_health::install_static(router, [EXAMPLE_SERVICE_SERVICE_NAME]).0
}

fn build(router: Router, verifier: Option<Arc<dyn Verifier>>, cfg: Config) -> Function {
    let procedures = router.methods().map(|m| format!("/{m}")).collect();
    let tracer = cfg
        .tracer
        .unwrap_or_else(|| global::tracer("knext-function"));
    let connect = ConnectRpcService::new(router)
        .with_limits(
            Limits::default()
                .with_max_message_size(MAX_REQUEST_BYTES)
                .with_max_request_body_size(MAX_REQUEST_BODY_BYTES),
        )
        // gzip only. Decompression stops at the message limit.
        .with_compression(CompressionRegistry::new().register(GzipProvider::new()));
    let stack = ServiceBuilder::new()
        .layer(layers::TraceLayer::new(tracer))
        .layer(layers::RecoverLayer)
        .layer(body::BoundedBodyLayer::new(
            MAX_REQUEST_BODY_BYTES,
            cfg.timeouts.read,
        ))
        .layer(AuthLayer::new(verifier))
        .service(connect);
    Function {
        service: BoxCloneService::new(stack),
        procedures,
        timeouts: cfg.timeouts,
    }
}

impl Function {
    /// Every registered procedure, as `/package.Service/Method`.
    pub fn procedures(&self) -> impl Iterator<Item = &str> {
        self.procedures.iter().map(String::as_str)
    }

    pub fn timeouts(&self) -> Timeouts {
        self.timeouts
    }

    /// Serves on `listener` until `shutdown` resolves, then stops accepting
    /// and lets in-flight calls finish for up to the shutdown grace. Returns
    /// `Ok` after a clean drain, and an error if calls were still running
    /// when the grace ran out.
    pub async fn serve<F>(self, listener: TcpListener, shutdown: F) -> io::Result<()>
    where
        F: Future<Output = ()>,
    {
        let (stop_tx, stop_rx) = watch::channel(false);
        // Every connection task holds a sender; recv() returns None once all
        // of them have ended.
        let (live_tx, mut live_rx) = mpsc::channel::<()>(1);
        let mut shutdown = pin!(shutdown);
        loop {
            tokio::select! {
                () = &mut shutdown => break,
                accepted = listener.accept() => match accepted {
                    Ok((io, _peer)) => {
                        tokio::spawn(serve_connection(
                            io,
                            self.service.clone(),
                            self.timeouts,
                            stop_rx.clone(),
                            live_tx.clone(),
                        ));
                    }
                    Err(err) => {
                        // Out of file descriptors and the like: back off
                        // rather than spin.
                        tracing::warn!(error = %err, "accept failed");
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                },
            }
        }
        drop(listener);
        let _ = stop_tx.send(true);
        drop(live_tx);
        match tokio::time::timeout(self.timeouts.shutdown_grace, live_rx.recv()).await {
            Ok(_) => Ok(()),
            Err(_) => Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "calls were still in flight when the shutdown grace ran out",
            )),
        }
    }
}

/// When the connection last had a call start or end, and how many are in
/// flight.
#[derive(Default)]
struct Activity {
    in_flight: AtomicUsize,
    started: AtomicU64,
    last: std::sync::Mutex<Option<Instant>>,
}

impl Activity {
    fn touch(&self) {
        *self.last.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }

    /// Whether the connection has had no call in flight for `idle`.
    fn idle_for(&self, idle: Duration, since: Instant) -> bool {
        if self.in_flight.load(Ordering::SeqCst) > 0 {
            return false;
        }
        let last = (*self.last.lock().unwrap_or_else(|p| p.into_inner())).unwrap_or(since);
        last.elapsed() >= idle
    }
}

/// Counts a call as in flight until its response body is dropped.
struct InFlight(Arc<Activity>);

impl InFlight {
    fn new(activity: Arc<Activity>) -> Self {
        activity.in_flight.fetch_add(1, Ordering::SeqCst);
        activity.started.fetch_add(1, Ordering::SeqCst);
        activity.touch();
        Self(activity)
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.touch();
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

async fn serve_connection(
    io: TcpStream,
    service: Stack,
    timeouts: Timeouts,
    mut stop: watch::Receiver<bool>,
    _live: mpsc::Sender<()>,
) {
    let _ = io.set_nodelay(true);
    let accepted = Instant::now();
    let activity = Arc::new(Activity::default());
    let tracked = Arc::clone(&activity);
    let svc = hyper::service::service_fn(move |req: Request<Incoming>| {
        // Counted from the request head until its response body is dropped,
        // so a call is in flight for as long as it streams.
        let guard = InFlight::new(Arc::clone(&tracked));
        let call = service.clone().oneshot(req);
        async move {
            let resp = call.await?;
            Ok::<_, Infallible>(resp.map(|body| body::Guarded::new(body, guard)))
        }
    });

    let mut builder = ConnBuilder::new(TokioExecutor::new());
    builder
        .http1()
        .timer(TokioTimer::new())
        .header_read_timeout(timeouts.header_read);
    builder.http2().timer(TokioTimer::new());
    let mut conn = pin!(builder.serve_connection(TokioIo::new(io), svc));

    let mut closing = false;
    let mut check = tokio::time::interval(check_period(timeouts));
    check.tick().await;
    loop {
        tokio::select! {
            result = conn.as_mut() => {
                if let Err(err) = result {
                    tracing::debug!(error = %err, "connection ended");
                }
                return;
            }
            changed = stop.changed(), if !closing => {
                if changed.is_err() || *stop.borrow() {
                    conn.as_mut().graceful_shutdown();
                    closing = true;
                }
            }
            _ = check.tick(), if !closing => {
                let never_started = activity.started.load(Ordering::SeqCst) == 0;
                if (never_started && accepted.elapsed() >= timeouts.header_read)
                    || activity.idle_for(timeouts.idle, accepted)
                {
                    conn.as_mut().graceful_shutdown();
                    closing = true;
                }
            }
        }
    }
}

/// How often a connection checks its idle and first-request deadlines.
fn check_period(timeouts: Timeouts) -> Duration {
    (timeouts.header_read.min(timeouts.idle) / 4).max(Duration::from_millis(10))
}

#[cfg(test)]
mod limits_tests;
#[cfg(test)]
mod testkit;
#[cfg(test)]
mod tests;
