import http from "node:http";
import { collectDefaultMetrics, Registry } from "prom-client";
import { createLogger } from "../utils/logger";

const log = createLogger({ module: "server" });
const METRICS_PORT = 9091;

// Prometheus registry — collects default Node.js process metrics
const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

// Start a dedicated metrics server on port 9091.
// Clean separation: Nitro owns :3000, metrics owns :9091.
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
    log.info({ port: METRICS_PORT }, "Prometheus metrics server started");
});

try {
    // Import Nitro server — it self-starts on :3000
    // @ts-expect-error — Nitro server entry exists at runtime in .output/server/index.mjs
    await import("../server/index.mjs");
    log.info("Nitro server listening on :3000");
} catch (err) {
    log.fatal({ err }, "Server startup failed");
    process.exit(1);
}

// Handle graceful shutdown
const shutdown = () => {
    log.info("Shutting down gracefully...");
    metricsServer.close();
    process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
