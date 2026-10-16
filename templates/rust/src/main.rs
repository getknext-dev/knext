//! A knext zone function: a connect-rust server for the contract in
//! `proto/`, reachable only from its zone, over HTTP/2 cleartext (h2c) or
//! HTTP/1.1 on `$PORT`.
//!
//! Every RPC except the gRPC health check needs a bearer token from the
//! owning zone. The check fails closed: with no JWKS mounted, every other
//! RPC is refused.

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::Path;
use std::process::ExitCode;

use function::{auth, rpc};
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .json()
        .with_current_span(false)
        .init();
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(err) => {
            tracing::error!(error = %err, "function stopped");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> std::io::Result<()> {
    let function = rpc::new(rpc::Config::default());
    if !auth::jwks_mounted(Path::new(auth::DEFAULT_JWKS_PATH)) {
        tracing::warn!(
            jwks = auth::DEFAULT_JWKS_PATH,
            "no JWKS is mounted: every RPC except the health check will be refused"
        );
    }
    let port = listen_port(std::env::var("PORT").ok().as_deref());
    let listener = bind(port).await?;
    tracing::info!(addr = %listener.local_addr()?, "serving");
    // Knative sends SIGTERM before it removes a pod; serve drains in-flight
    // calls before returning.
    function.serve(listener, terminated()).await
}

/// `$PORT`, or 8080 when it is unset or not a port (Knative sets it).
fn listen_port(port: Option<&str>) -> u16 {
    port.and_then(|p| p.parse().ok()).unwrap_or(8080)
}

/// Every address on `port`: IPv6 and IPv4 where the node has IPv6, IPv4
/// alone where it does not.
async fn bind(port: u16) -> std::io::Result<TcpListener> {
    match TcpListener::bind(SocketAddr::from((Ipv6Addr::UNSPECIFIED, port))).await {
        Ok(listener) => Ok(listener),
        Err(_) => TcpListener::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, port))).await,
    }
}

async fn terminated() {
    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
    tokio::select! {
        _ = term.recv() => {}
        _ = tokio::signal::ctrl_c() => {}
    }
}

#[cfg(test)]
mod tests {
    use super::listen_port;

    #[test]
    fn listen_port_is_port_or_8080() {
        assert_eq!(listen_port(Some("9090")), 9090);
        assert_eq!(listen_port(None), 8080);
        assert_eq!(listen_port(Some("")), 8080);
        assert_eq!(listen_port(Some("not-a-port")), 8080);
    }
}
