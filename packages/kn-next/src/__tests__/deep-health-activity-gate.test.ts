import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Registry } from "prom-client";

import {
    createMetricsRegistry,
    DEEP_HEALTH_STATE_METRIC,
    type KnextMetrics,
    makeDeepHealthScrapeHook,
} from "../adapters/metrics";

/**
 * #348 (gate fix) — the scrape hook must ACTIVITY-GATE the Postgres dial so an
 * idle app's scale-to-zero DB is never woken by the :9464 scrape. This is the
 * acceptance for the fix: when the pool has been idle past the budget, the hook
 * must NOT run the deep check (no `SELECT 1`, no DB wake); when the pool was used
 * recently, the hook DOES run and the gauge reflects the state.
 */

let metrics: KnextMetrics;

beforeEach(() => {
    metrics = createMetricsRegistry(new Registry(), "test-app");
});

async function scrape(): Promise<string> {
    return metrics.registry.metrics();
}

describe("#348 gate: makeDeepHealthScrapeHook activity-gates the DB dial", () => {
    it("IDLE pool ⇒ hook does NOT run checkDeepHealth (DB not woken)", async () => {
        const checkDeepHealth = mock(async () => ({
            status: "waking" as const,
            checks: {
                postgres: "waking" as const,
                redis: "unconfigured" as const,
            },
        }));
        const hook = makeDeepHealthScrapeHook(metrics, {
            checkDeepHealth,
            isRecentlyActive: () => false, // pool idle past the budget
        });

        await hook();

        // The whole point: no deep check → no `SELECT 1` → the DB can sleep.
        expect(checkDeepHealth).not.toHaveBeenCalled();
    });

    it("RECENTLY-ACTIVE pool ⇒ hook runs checkDeepHealth and the gauge reflects the state", async () => {
        const checkDeepHealth = mock(async () => ({
            status: "waking" as const,
            checks: {
                postgres: "waking" as const,
                redis: "unconfigured" as const,
            },
        }));
        const hook = makeDeepHealthScrapeHook(metrics, {
            checkDeepHealth,
            isRecentlyActive: () => true, // pool used within the budget
        });

        await hook();

        expect(checkDeepHealth).toHaveBeenCalledTimes(1);
        const out = await scrape();
        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="waking"[^}]*\\} 1`,
            ),
        );
    });

    it("is fail-open: a throwing checkDeepHealth never rejects the scrape", async () => {
        const hook = makeDeepHealthScrapeHook(metrics, {
            checkDeepHealth: async () => {
                throw new Error("deep check blew up");
            },
            isRecentlyActive: () => true,
        });
        await expect(hook()).resolves.toBeUndefined();
    });

    it("an idle pool DROPS the series: no stale 'waking' or 'down' is left claiming a state nothing probed", async () => {
        let active = true;
        const checkDeepHealth = mock(async () => ({
            status: "waking" as const,
            checks: {
                postgres: "waking" as const,
                redis: "unconfigured" as const,
            },
        }));
        const hook = makeDeepHealthScrapeHook(metrics, {
            checkDeepHealth,
            isRecentlyActive: () => active,
        });

        // First scrape while active: gauge records waking.
        await hook();
        expect(await scrape()).toContain(`${DEEP_HEALTH_STATE_METRIC}{`);

        // The app goes idle. The next scrape must NOT re-dial, and it must not
        // keep claiming the last reading either: nothing was probed, so the
        // exposition carries no claim (Prometheus then marks the series stale
        // and a `for:` clause resets).
        active = false;
        await hook();

        expect(checkDeepHealth).toHaveBeenCalledTimes(1);
        const out = await scrape();
        expect(out).not.toMatch(
            new RegExp(`^${DEEP_HEALTH_STATE_METRIC}\\{`, "m"),
        );
    });

    it("the series comes back when the app is used again (reset is not a latch)", async () => {
        let active = true;
        let now = 0;
        const hook = makeDeepHealthScrapeHook(metrics, {
            checkDeepHealth: async () => ({
                status: "down" as const,
                checks: {
                    postgres: "down" as const,
                    redis: "unconfigured" as const,
                },
            }),
            isRecentlyActive: () => active,
            now: () => now,
        });
        await hook();
        active = false;
        await hook();
        active = true;
        now += 1_000; // inside the probe TTL of the first probe
        await hook();
        expect(await scrape()).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="down"[^}]*\\} 1`,
            ),
        );
    });
});
