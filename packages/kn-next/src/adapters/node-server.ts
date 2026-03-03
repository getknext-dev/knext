import { createServer } from "node:http";
import { join } from "node:path";
import { startProdServer } from "vinext/server/prod-server";
import {
    initBytecodeCacheMetrics,
    metricsRegistry,
    recordServerReady,
} from "./bytecode-metrics.ts";

const PORT = Number.parseInt(process.env.PORT || "8080", 10);

async function main() {
    initBytecodeCacheMetrics();

    // Vinext startProdServer creates an HTTP server and binds to the given port
    const server = await startProdServer({ port: PORT, outDir: join(process.cwd(), "dist") });

    // Intercept requests for /metrics before they reach Vinext handler
    const originalEmit = server.emit.bind(server);
    // @ts-ignore - dynamic override
    server.emit = function (event, ...args) {
        if (event === "request") {
            const [req, res] = args;
            if (req.url === "/metrics" && req.method === "GET") {
                res.setHeader("Content-Type", metricsRegistry.contentType);
                metricsRegistry.metrics().then((metrics) => {
                    res.end(metrics);
                });
                return true;
            }
        }
        return originalEmit(event, ...args);
    };

    recordServerReady();
    console.info(`[kn-next] Vinext server listening on port ${PORT}`);
    console.info(
        `[kn-next] Prometheus metrics at http://localhost:${PORT}/metrics`,
    );

    // Handle graceful shutdown
    const shutdown = () => {
        console.info("[kn-next] Shutting down gracefully...");
        server.close(() => {
            process.exit(0);
        });
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
}

main().catch((err) => {
    console.error("[kn-next] Server startup failed:", err);
    process.exit(1);
});
