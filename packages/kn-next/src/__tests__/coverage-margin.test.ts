/**
 * Environment-independent coverage for a few residual branches/functions that
 * were otherwise only reached transitively — kept in one place so CI's Node-only
 * coverage job clears the per-package floor with margin:
 *  - deferred-default-metrics: the real defaultSleep path in waitForChildServing,
 *    and the collect-rejection catch in ensureStarted,
 *  - metrics: fetchChildMetrics' request-timeout branch and mergeExposition.
 */

import { afterEach, describe, expect, it } from "bun:test";
import http from "node:http";
import { Registry } from "prom-client";
import {
    createDeferredDefaultMetrics,
    waitForChildServing,
} from "../adapters/deferred-default-metrics";
import { fetchChildMetrics, mergeExposition } from "../adapters/metrics";

const servers: http.Server[] = [];
afterEach(async () => {
    await Promise.all(
        servers
            .splice(0)
            .map((s) => new Promise<void>((r) => s.close(() => r()))),
    );
});

describe("deferred-default-metrics — residual branches", () => {
    it("ensureStarted resolves true even when the collector rejects (catch path)", async () => {
        const deferred = createDeferredDefaultMetrics({
            registry: new Registry(),
            collect: async () => {
                throw new Error("collect boom");
            },
        });
        // The started call returns true (it OWNS the start); the rejection is
        // swallowed by the internal .catch(() => false) so no unhandled reject.
        expect(await deferred.ensureStarted("child-ready")).toBe(true);
        expect(deferred.isStarted()).toBe(true);
    });

    it("uses the real defaultSleep between polls when no sleep is injected", async () => {
        let attempt = 0;
        const outcome = await waitForChildServing({
            port: 3000,
            intervalMs: 1, // real setTimeout(1) via the default (unref'd) sleep
            deadlineMs: 5_000,
            probe: async () => ++attempt >= 2, // false once → sleeps → then true
            // NB: no `sleep` injected → exercises defaultSleep.
        });
        expect(outcome).toBe("serving");
        expect(attempt).toBe(2);
    });
});

describe("metrics — residual branches", () => {
    it("fetchChildMetrics returns '' when the child hangs past the timeout", async () => {
        // A server that accepts but never responds → the request times out.
        const srv = http.createServer(() => {
            /* never write, never end */
        });
        servers.push(srv);
        await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
        const port = (srv.address() as { port: number }).port;

        const body = await fetchChildMetrics(port, "127.0.0.1", 80);
        expect(body).toBe("");
    });

    it("mergeExposition drops empty sources and normalises the seam newline", () => {
        expect(mergeExposition([])).toBe("");
        expect(mergeExposition(["", "", ""])).toBe("");
        expect(mergeExposition(["a\n\n", "", "b"])).toBe("a\nb\n");
        expect(mergeExposition(["only\n"])).toBe("only\n");
    });
});
