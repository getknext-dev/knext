import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Registry } from "prom-client";

import {
    createMetricsRegistry,
    DEEP_HEALTH_PROBE_TTL_MS,
    type KnextMetrics,
    makeDeepHealthScrapeHook,
} from "../adapters/metrics";

/**
 * The deep-health probe must not be amplifiable by whoever can reach :9464.
 *
 * That port is readable cross-namespace (ADR-0044), and serving the gauge there
 * made every request drive a fresh database probe plus a Redis probe, each able
 * to hold the handler for the deep-check budget. N concurrent scrapes (a second
 * Prometheus, an HA pair, or a co-resident client in a loop) meant N probes.
 *
 * So the hook is single-flight (concurrent callers share one probe) and
 * TTL-cached (a caller inside the TTL reuses the gauge the last probe set).
 * The TTL is below the scrape interval, so a normal 30 s scrape always probes.
 */

let metrics: KnextMetrics;
beforeEach(() => {
    metrics = createMetricsRegistry(new Registry(), "test-app");
});

const snapshot = {
    status: "down" as const,
    checks: { postgres: "down" as const, redis: "unconfigured" as const },
};

function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe("deep-health scrape hook: single-flight", () => {
    it("N concurrent scrapes produce ONE probe, and every caller waits for its result", async () => {
        const gate = deferred<typeof snapshot>();
        const checkDeepHealth = mock(() => gate.promise);
        const hook = makeDeepHealthScrapeHook(metrics, {
            checkDeepHealth,
            isRecentlyActive: () => true,
        });

        const callers = Array.from({ length: 25 }, () => hook());
        await Promise.resolve();
        expect(checkDeepHealth).toHaveBeenCalledTimes(1);

        let settled = 0;
        for (const c of callers) c.then(() => settled++);
        await Promise.resolve();
        expect(settled, "callers must wait for the shared probe").toBe(0);

        gate.resolve(snapshot);
        await Promise.all(callers);
        expect(settled).toBe(25);
        expect(checkDeepHealth).toHaveBeenCalledTimes(1);
    });

    it("a failing probe does not wedge the single-flight slot", async () => {
        let now = 0;
        const checkDeepHealth = mock(async () => {
            throw new Error("boom");
        });
        const hook = makeDeepHealthScrapeHook(metrics, {
            checkDeepHealth,
            isRecentlyActive: () => true,
            now: () => now,
        });
        await hook(); // fail-open: never rejects
        now += DEEP_HEALTH_PROBE_TTL_MS + 1;
        await hook();
        expect(checkDeepHealth).toHaveBeenCalledTimes(2);
    });
});

describe("deep-health scrape hook: TTL cache", () => {
    it("a scrape inside the TTL reuses the last probe; one after it probes again", async () => {
        let now = 1_000_000;
        const checkDeepHealth = mock(async () => snapshot);
        const hook = makeDeepHealthScrapeHook(metrics, {
            checkDeepHealth,
            isRecentlyActive: () => true,
            now: () => now,
        });

        await hook();
        now += DEEP_HEALTH_PROBE_TTL_MS - 1;
        await hook();
        await hook();
        expect(checkDeepHealth).toHaveBeenCalledTimes(1);

        now += 2; // past the TTL
        await hook();
        expect(checkDeepHealth).toHaveBeenCalledTimes(2);
    });

    it("the TTL sits below the 30 s scrape interval, so a normal scrape always probes", () => {
        expect(DEEP_HEALTH_PROBE_TTL_MS).toBeGreaterThan(0);
        expect(DEEP_HEALTH_PROBE_TTL_MS).toBeLessThan(30_000);
    });

    it("the activity gate still wins: idle ⇒ no probe, whatever the TTL says", async () => {
        const checkDeepHealth = mock(async () => snapshot);
        const hook = makeDeepHealthScrapeHook(metrics, {
            checkDeepHealth,
            isRecentlyActive: () => false,
        });
        await hook();
        expect(checkDeepHealth).not.toHaveBeenCalled();
    });
});
