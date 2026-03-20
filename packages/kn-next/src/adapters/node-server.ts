import http from "node:http";
import {
	initBytecodeCacheMetrics,
	metricsRegistry,
	recordServerReady,
} from "./bytecode-metrics.ts";
import { installStructuredLogging } from "./logger.ts";
import { initOtel } from "./otel.ts";
import { withRequestContext } from "./request-context.ts";

async function main() {
	// ── Step 1: Initialize OpenTelemetry (must be first for patching) ──
	const otelEnabled = await initOtel();

	// ── Step 2: Install structured JSON logging ──
	// Only when OTel is active or KN_STRUCTURED_LOGS=true is set
	if (otelEnabled || process.env.KN_STRUCTURED_LOGS === "true") {
		installStructuredLogging();
	}

	// ── Step 3: Initialize bytecode cache metrics (prom-client) ──
	initBytecodeCacheMetrics();

	// ── Step 4: Intercept HTTP server creation ──
	const originalCreateServer = http.createServer;

	// @ts-expect-error - dynamic override
	http.createServer = (requestListener?: http.RequestListener) =>
		originalCreateServer((req, res) => {
			// Serve Prometheus metrics endpoint
			if (req.url === "/metrics" && req.method === "GET") {
				res.setHeader("Content-Type", metricsRegistry.contentType);
				metricsRegistry.metrics().then((metrics) => {
					res.end(metrics);
				});
				return;
			}

			// Wrap every request in a context with request ID
			withRequestContext(req, () => {
				// Set x-request-id response header for tracing across services
				const { getRequestId } = require("./request-context.ts");
				const requestId = getRequestId();
				res.setHeader("x-request-id", requestId);

				if (requestListener) {
					return requestListener(req, res);
				}
			});
		});

	// ── Step 5: Import and start Nitro server ──
	await import("../server/index.mjs");

	recordServerReady();
	console.info(`[kn-next] Nitro server listening`);
	console.info(`[kn-next] Prometheus metrics at /metrics`);
	if (otelEnabled) {
		console.info(
			`[kn-next] OpenTelemetry traces → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "otel-collector.monitoring:4317"}`,
		);
	}

	// Handle graceful shutdown
	const shutdown = () => {
		console.info("[kn-next] Shutting down gracefully...");
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((err) => {
	console.error("[kn-next] Server startup failed:", err);
	process.exit(1);
});
