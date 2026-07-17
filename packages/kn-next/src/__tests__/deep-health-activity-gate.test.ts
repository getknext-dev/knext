import { Registry } from "prom-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    createMetricsRegistry,
    DEEP_HEALTH_STATE_METRIC,
    type KnextMetrics,
    makeDeepHealthScrapeHook,
} from "../adapters/metrics";

/**
 * #348 (gate fix) — the scrape hook must ACTIVITY-GATE the Postgres dial so an
 * idle app's scale-to-zero DB is never woken by the :9091 scrape. This is the
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
        const checkDeepHealth = vi.fn(async () => ({
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
        const checkDeepHealth = vi.fn(async () => ({
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

    it("an idle pool leaves the gauge at its LAST-KNOWN value (does not zero it out)", async () => {
        let active = true;
        const hook = makeDeepHealthScrapeHook(metrics, {
            checkDeepHealth: async () => ({
                status: "waking" as const,
                checks: {
                    postgres: "waking" as const,
                    redis: "unconfigured" as const,
                },
            }),
            isRecentlyActive: () => active,
        });

        // First scrape while active: gauge records waking.
        await hook();
        // App goes idle; a later scrape must NOT re-dial and must NOT clear the
        // last-known state (so a genuinely-stuck-then-idle app keeps its reading).
        active = false;
        await hook();

        const out = await scrape();
        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="waking"[^}]*\\} 1`,
            ),
        );
    });
});
