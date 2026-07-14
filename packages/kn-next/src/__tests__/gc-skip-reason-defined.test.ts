import { describe, expect, it, vi } from "vitest";

/**
 * v3-P4b — PRODUCER-side guard for P4a's sysdesign residual.
 *
 * `renderGcReport` has a defensive `res.skipReason ?? "unresolvable-live-build-id"`
 * fallback. That fallback exists so a malformed result never crashes the render,
 * but it MUST NOT be load-bearing: every real `pruned: false` return in
 * `runAssetGC` is required to set a DEFINED `skipReason`. If a future skip path
 * (e.g. the new TOCTOU drift abort) forgets to set one, it would silently render
 * as `unresolvable-live-build-id` and mislabel operator alerts.
 *
 * This suite drives `runAssetGC` through EVERY skip path with the injected exec
 * seam and asserts each returns a `pruned: false` result WITH a defined
 * `skipReason` — so the producer is checked directly, not the renderer's
 * fallback.
 */

import { runAssetGC } from "../cli/gc";
import type { KnativeNextConfig } from "../config";

function makeConfig(name = "shop"): KnativeNextConfig {
    return {
        name,
        registry: "registry.invalid/e2e",
        storage: {
            provider: "s3",
            bucket: "b",
            publicUrl: "https://example.test/b",
            assetRetention: 1,
        },
    } as unknown as KnativeNextConfig;
}

function trafficJson(revisions: string[]): string {
    return JSON.stringify(
        revisions.map((r) => ({ revisionName: r, percent: 100 })),
    );
}

/**
 * Every distinct skip PATH in runAssetGC, each with an exec that drives it.
 * Extend this list whenever a new skip return is added — the assertion below
 * guarantees the new path sets a defined skipReason.
 */
const SKIP_PATHS: ReadonlyArray<{
    name: string;
    exec: (argv: readonly string[]) => string;
}> = [
    {
        name: "pinned-with-empty-status (empty status + a spec pin)",
        exec: (argv) => {
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return "";
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return "shop-00007";
            throw new Error("unexpected read");
        },
    },
    {
        name: "pinned-with-empty-status (empty status + a throwing pin probe)",
        exec: (argv) => {
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return "";
            throw new Error("kubectl blew up reading the spec");
        },
    },
    {
        name: "pinned-not-resolvable (throwing pin probe, non-empty status)",
        exec: (argv) => {
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00008"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                throw new Error("kubectl blew up reading the spec");
            return "bid-new";
        },
    },
    {
        name: "pinned-not-resolvable (pin build-id label absent)",
        exec: (argv) => {
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00008"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return "shop-00007";
            return argv.includes("shop-00008") ? "bid-new" : "";
        },
    },
    {
        name: "unresolvable-live-build-id (a live revision has no label)",
        exec: (argv) => {
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00001", "shop-00002"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return "";
            return argv.includes("shop-00001") ? "bid-a" : "";
        },
    },
    {
        name: "traffic-drift-during-plan (pin appears on the re-read)",
        exec: (() => {
            let pinReads = 0;
            return (argv: readonly string[]): string => {
                if (argv.some((a) => a.includes(".status.currentTraffic")))
                    return trafficJson(["shop-00008"]);
                if (
                    argv.some((a) => a.includes(".spec.traffic.revisionName"))
                ) {
                    pinReads++;
                    return pinReads === 1 ? "" : "shop-00007";
                }
                return "bid-new";
            };
        })(),
    },
];

describe("runAssetGC producer sets a DEFINED skipReason on every skip (v3-P4b)", () => {
    for (const { name, exec } of SKIP_PATHS) {
        it(`${name} ⇒ pruned:false with a defined skipReason`, () => {
            const res = runAssetGC(
                makeConfig(),
                "prod",
                "bid-d",
                exec,
                vi.fn(),
            );
            expect(res.pruned).toBe(false);
            expect(res.skipReason).toBeDefined();
            expect(typeof res.skipReason).toBe("string");
            expect(res.skipReason).not.toBe("");
        });
    }
});
