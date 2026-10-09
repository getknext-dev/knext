// Z2 spike: a trivial Connect function (connect-rust 0.9) on the Knative $PORT.
// The built-in hyper server auto-detects HTTP/1.1 vs h2c on one listener;
// Knative picks which one queue-proxy speaks from the port NAME.
use std::sync::Arc;
use std::time::Instant;

use connectrpc::{RequestContext, Response, Router, Server, ServiceRequest, ServiceResult};

pub mod proto {
    connectrpc::include_generated!();
}

use proto::zonefn::v1::{PingRequest, PingResponse, PingService};

static STARTED: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

struct Ping;

impl PingService for Ping {
    async fn ping(
        &self,
        _ctx: RequestContext,
        request: ServiceRequest<'_, PingRequest>,
    ) -> ServiceResult<PingResponse> {
        Response::ok(PingResponse {
            msg: request.msg.to_string(),
            lang: "rust".to_string(),
            uptime_ms: STARTED.get().map(|t| t.elapsed().as_millis() as i64).unwrap_or(-1),
            // connect-rust does not surface the HTTP version to handlers; the
            // Go function shows what Knative delivers for each port name.
            proto: String::new(),
            ..Default::default()
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let started = *STARTED.get_or_init(Instant::now);
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".to_string());
    let router = Router::new().add_service(Arc::new(Ping));
    let addr = format!("0.0.0.0:{port}").parse()?;
    eprintln!("fn-rust listening on {addr} after {:?}", started.elapsed());
    Server::new(router).serve(addr).await?;
    Ok(())
}
