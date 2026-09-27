/**
 * Harness for malformed-url-standalone-metrics.test.ts: boots the SECOND,
 * independently-implemented `:9464` metrics listener —
 * `startMetricsServer` in
 * `packages/kn-next/src/adapters/standalone-self-contained-supervisor.cjs`
 * (wired in only under `knext build --self-contained`; see that module's own
 * header for why it exists as a separate, dependency-free implementation
 * rather than reusing `deferred-supervisor-init.ts`).
 *
 * Plain `.cjs`, dependency-free (only `node:http`/`node:net`), so `require()`
 * works unmodified under both `node` and `bun` — no bundling step needed,
 * unlike `standalone-metrics-endpoint-harness.mjs`'s TS source.
 *
 * This harness creates a dummy "app" `http.createServer` FIRST, matching
 * production order (Next's own `server.js` calls `http.createServer` for the
 * app port). That call is what the supervisor module's `install()` side
 * effect — run at `require()` time — is watching for: it monkeypatches
 * `http.createServer` to capture the FIRST server created in the process,
 * then starts the `:9464` metrics server + drain handler around it. Calling
 * `startMetricsServer` directly, as the very first `http.createServer` call
 * in the process, would instead have the metrics server itself captured as
 * "the app", triggering a second, recursive `startMetricsServer` call that
 * tries to bind the SAME port twice. Creating the dummy app server first
 * sidesteps that landmine by reproducing the real call order rather than
 * special-casing around it.
 *
 * env:
 *   SUPERVISOR_MODULE  absolute path to standalone-self-contained-supervisor.cjs
 *   METRICS_PORT       the port the metrics listener should bind (required —
 *                       see the test file's getFreePort()/bootSelfContained()
 *                       comment for why 0/unset is not safe here)
 *
 * Prints `LISTENING:<port>` once the metrics port is confirmed accepting
 * connections.
 */
"use strict";

const http = require("node:http");
const net = require("node:net");

// Triggers this module's own require()-time `install()` side effect, which
// monkeypatches `http.createServer` (see the header comment above).
require(process.env.SUPERVISOR_MODULE);

const metricsPort = Number(process.env.METRICS_PORT);
if (!Number.isFinite(metricsPort) || metricsPort <= 0) {
    console.error(
        `standalone-self-contained-metrics-endpoint-harness.cjs: invalid METRICS_PORT ${process.env.METRICS_PORT}`,
    );
    process.exit(1);
}

// The dummy "app" server — this is the FIRST http.createServer call in the
// process, exactly like Next's own server.js, which is what the wrapper
// above is watching for.
const appServer = http.createServer((_req, res) => {
    res.writeHead(200).end("app");
});
appServer.listen(0, "127.0.0.1", () => {
    waitForMetricsPort();
});

// The metrics server is started synchronously as a side effect of the
// `http.createServer` call above (inside the wrapper), but this harness
// never gets a direct reference to it — poll the port instead of trying to
// hook a 'listening' event on a server object we don't have.
function waitForMetricsPort(remaining) {
    if (remaining === undefined) remaining = 100;
    const sock = net.connect(metricsPort, "127.0.0.1");
    sock.once("connect", () => {
        sock.end();
        console.log(`LISTENING:${metricsPort}`);
    });
    sock.once("error", () => {
        sock.destroy();
        if (remaining <= 0) {
            console.error(
                `standalone-self-contained-metrics-endpoint-harness.cjs: metrics port ${metricsPort} never opened`,
            );
            process.exit(1);
            return;
        }
        setTimeout(() => waitForMetricsPort(remaining - 1), 20);
    });
}
