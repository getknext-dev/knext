import { Registry } from "prom-client";
import { beforeEach, describe, expect, it } from "vitest";

import {
    createMetricsRegistry,
    DEEP_HEALTH_STATE_METRIC,
    type KnextMetrics,
    refreshDeepHealthGauge,
} from "../adapters/metrics";

/**
 * #348 — the deep-health state must be a SCRAPABLE metric so Prometheus can
 * alert on a SUSTAINED `waking` (a permanent connection-level outage that
 * `checkDeepHealth` correctly classifies `waking` forever, never `down`).
 *
 * `refreshDeepHealthGauge` maps a `HealthStatus` onto the
 * `knext_deep_health_state{app,dependency,state}` gauge: the ACTIVE state for
 * each dependency (and the overall roll-up) is 1, every other state 0. This
 * mirrors the metrics-integration style — exercise the real refresher against
 * the real registry, never hand-set the gauge in the test body.
 */

let metrics: KnextMetrics;

beforeEach(() => {
    metrics = createMetricsRegistry(new Registry(), "test-app");
});

async function scrape(): Promise<string> {
    return metrics.registry.metrics();
}

describe("#348 knext_deep_health_state gauge reflects checkDeepHealth state", () => {
    it("waking (connection-refused DB) ⇒ overall+postgres state=waking is 1, other states 0", async () => {
        refreshDeepHealthGauge(metrics, {
            status: "waking",
            timestamp: new Date().toISOString(),
            checks: { postgres: "waking", redis: "unconfigured" },
        });
        const out = await scrape();

        expect(out).toContain(DEEP_HEALTH_STATE_METRIC);
        // The active overall state carries value 1 with a `state="waking"` label.
        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*app="test-app"[^}]*dependency="overall"[^}]*state="waking"[^}]*\\} 1`,
            ),
        );
        // The postgres dependency also reports waking=1.
        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="postgres"[^}]*state="waking"[^}]*\\} 1`,
            ),
        );
        // Non-active overall states are 0 (so an alert on state="waking"==1 is unambiguous).
        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="ok"[^}]*\\} 0`,
            ),
        );
        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="down"[^}]*\\} 0`,
            ),
        );
    });

    it("ok (DB up) ⇒ overall state=ok is 1 and state=waking is 0", async () => {
        refreshDeepHealthGauge(metrics, {
            status: "ok",
            timestamp: new Date().toISOString(),
            checks: { postgres: "up", redis: "unconfigured" },
        });
        const out = await scrape();

        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="ok"[^}]*\\} 1`,
            ),
        );
        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="waking"[^}]*\\} 0`,
            ),
        );
    });

    it("down (reachable-but-erroring DB) ⇒ overall state=down is 1", async () => {
        refreshDeepHealthGauge(metrics, {
            status: "down",
            timestamp: new Date().toISOString(),
            checks: { postgres: "down", redis: "up" },
        });
        const out = await scrape();

        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="down"[^}]*\\} 1`,
            ),
        );
    });

    it("re-refresh flips the single active state (no stale waking left at 1)", async () => {
        refreshDeepHealthGauge(metrics, {
            status: "waking",
            timestamp: new Date().toISOString(),
            checks: { postgres: "waking", redis: "unconfigured" },
        });
        // DB finished waking → now up.
        refreshDeepHealthGauge(metrics, {
            status: "ok",
            timestamp: new Date().toISOString(),
            checks: { postgres: "up", redis: "unconfigured" },
        });
        const out = await scrape();

        // The prior waking must have been zeroed — otherwise the alert never clears.
        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="waking"[^}]*\\} 0`,
            ),
        );
        expect(out).toMatch(
            new RegExp(
                `${DEEP_HEALTH_STATE_METRIC}\\{[^}]*dependency="overall"[^}]*state="ok"[^}]*\\} 1`,
            ),
        );
    });
});
