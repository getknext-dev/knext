import http from "node:http";
import {
	initBytecodeCacheMetrics,
	metricsRegistry,
	recordServerReady,
} from "./bytecode-metrics.ts";

const METRICS_PORT = 9091;

async function main() {
	initBytecodeCacheMetrics();

	// Start a dedicated metrics server on port 9091.
	// Clean separation: Nitro owns :3000, metrics owns :9091.
	// No monkey-patching of http.createServer.
	const metricsServer = http.createServer(async (req, res) => {
		if (req.url === "/metrics" && req.method === "GET") {
			res.setHeader("Content-Type", metricsRegistry.contentType);
			const metrics = await metricsRegistry.metrics();
			res.end(metrics);
			return;
		}
		res.writeHead(404);
		res.end("Not Found");
	});

	metricsServer.listen(METRICS_PORT, () => {
		console.info(`[kn-next] Prometheus metrics server on :${METRICS_PORT}/metrics`);
	});

	// Import Nitro server — it self-starts on :3000
	await import("../server/index.mjs");

	recordServerReady();
	console.info("[kn-next] Nitro server listening on :3000");

	// Handle graceful shutdown
	const shutdown = () => {
		console.info("[kn-next] Shutting down gracefully...");
		metricsServer.close();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((err) => {
	console.error("[kn-next] Server startup failed:", err);
	process.exit(1);
});
