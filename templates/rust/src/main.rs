//! A knext zone function: a connect-rust server for the contract in
//! `proto/`, reachable only from its zone, over HTTP/2 cleartext (h2c) or
//! HTTP/1.1 on `$PORT`.
//!
//! Every RPC except the gRPC health check needs a bearer token from the
//! owning zone, verified against the zone's JWKS (mounted as a volume) and
//! the issuer and audience in `$KNEXT_TOKEN_ISSUER` and
//! `$KNEXT_TOKEN_AUDIENCE`. The check fails closed: with no JWKS mounted, or
//! either variable unset, every other RPC is refused.

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
    let config = config(|name| std::env::var(name).ok());
    if !auth::jwks_mounted(Path::new(auth::DEFAULT_JWKS_PATH)) {
        tracing::warn!(
            jwks = auth::DEFAULT_JWKS_PATH,
            "no JWKS is mounted: every RPC except the health check will be refused"
        );
    }
    if config.issuer.is_empty() || config.audience.is_empty() {
        tracing::warn!(
            issuer_env = auth::ENV_ISSUER,
            audience_env = auth::ENV_AUDIENCE,
            "the token issuer or audience is not set: every RPC except the health check will be refused"
        );
    }
    let function = rpc::new(config);
    let port = listen_port(std::env::var("PORT").ok().as_deref());
    let listener = bind(port).await?;
    tracing::info!(addr = %listener.local_addr()?, "serving");
    // Knative sends SIGTERM before it removes a pod; serve drains in-flight
    // calls before returning.
    function.serve(listener, terminated()).await
}

/// The token check's issuer and audience, from the env the operator sets on
/// the function. Unset, they stay empty and the check refuses every RPC
/// except the health check.
fn config(getenv: impl Fn(&str) -> Option<String>) -> rpc::Config {
    rpc::Config {
        issuer: getenv(auth::ENV_ISSUER).unwrap_or_default(),
        audience: getenv(auth::ENV_AUDIENCE).unwrap_or_default(),
        ..rpc::Config::default()
    }
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
    use super::{config, listen_port};

    #[test]
    fn config_reads_the_token_issuer_and_audience_from_the_env() {
        let cfg = config(|name| match name {
            "KNEXT_TOKEN_ISSUER" => Some("knext:zone:shop/storefront".into()),
            "KNEXT_TOKEN_AUDIENCE" => Some("knext:fn:shop/orders".into()),
            _ => None,
        });
        assert_eq!(cfg.issuer, "knext:zone:shop/storefront");
        assert_eq!(cfg.audience, "knext:fn:shop/orders");
        assert_eq!(
            cfg.jwks_path.to_str(),
            Some("/var/run/knext/jwks/jwks.json")
        );
        let empty = config(|_| None);
        assert!(empty.issuer.is_empty() && empty.audience.is_empty());
    }

    #[test]
    fn listen_port_is_port_or_8080() {
        assert_eq!(listen_port(Some("9090")), 9090);
        assert_eq!(listen_port(None), 8080);
        assert_eq!(listen_port(Some("")), 8080);
        assert_eq!(listen_port(Some("not-a-port")), 8080);
    }
}
