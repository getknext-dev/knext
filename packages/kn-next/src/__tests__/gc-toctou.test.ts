import { describe, expect, it, vi } from "vitest";

/**
 * v3-P4b — the TOCTOU narrowing for the asset retention GC (ADR-0011 §TOCTOU).
 *
 * `runAssetGC` reads status.currentTraffic + the spec pin (the PLAN phase),
 * computes the protected build-id set, then deletes unprotected prefixes (the
 * DELETE phase). Between plan and the first delete there is a window: a
 * rollback / traffic shift can change the pin or the live set. P4b RE-READS
 * the pin + status.currentTraffic ONCE immediately before the first delete and
 * ABORTS (fail-safe over-keep — deletes nothing) on ANY drift:
 *
 *   drift = (pin₂ ≠ pin₁) OR (currentTraffic₂ revision SET ≠ currentTraffic₁ set)
 *
 * The set comparison is order-insensitive. A read FAILURE during the re-read
 * is itself treated as drift (over-keep, never over-delete). On drift the run
 * skips with the NEW registered token `[traffic-drift-during-plan]`.
 *
 * NB: the re-read is injected through the SAME `exec` seam the plan reads use,
 * so these tests drive drift by returning different values on the SECOND
 * observation of each read (tracked per-read via a call counter).
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
 * Build an exec that answers the currentTraffic read and the spec-pin read
 * with a FIRST observation and a (possibly different) SECOND observation, and
 * resolves every revision's build-id label from `labels`. This models the
 * re-read: the plan phase sees obs #1, the pre-delete re-read sees obs #2.
 */
function driftingExec(opts: {
    traffic1: string[];
    traffic2: string[];
    pin1: string;
    pin2: string;
    labels: Record<string, string>;
    /** if set, the Nth currentTraffic OR pin read throws (1-indexed over each). */
    trafficThrowsOn?: number;
    pinThrowsOn?: number;
}): (argv: readonly string[]) => string {
    let trafficReads = 0;
    let pinReads = 0;
    return (argv: readonly string[]): string => {
        if (argv.some((a) => a.includes(".status.currentTraffic"))) {
            trafficReads++;
            if (opts.trafficThrowsOn === trafficReads) {
                throw new Error("kubectl blew up re-reading currentTraffic");
            }
            return trafficJson(
                trafficReads === 1 ? opts.traffic1 : opts.traffic2,
            );
        }
        if (argv.some((a) => a.includes(".spec.traffic.revisionName"))) {
            pinReads++;
            if (opts.pinThrowsOn === pinReads) {
                throw new Error("kubectl blew up re-reading the pin");
            }
            return pinReads === 1 ? opts.pin1 : opts.pin2;
        }
        // revision build-id label read
        const rev = argv[argv.indexOf("revision") + 1];
        return opts.labels[rev] ?? "";
    };
}

describe("runAssetGC — TOCTOU re-read (v3-P4b)", () => {
    it("NO drift (pin + currentTraffic identical on re-read) ⇒ deletes proceed exactly as the single-read plan would have", () => {
        const exec = driftingExec({
            traffic1: ["shop-00008"],
            traffic2: ["shop-00008"],
            pin1: "",
            pin2: "",
            labels: { "shop-00008": "bid-new" },
        });
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(true);
        // Byte-identical delete set: the same liveBuildIds the single-read plan produced.
        expect(prune).toHaveBeenCalledWith(
            expect.anything(),
            ["bid-new"],
            "bid-d",
            { dryRun: false },
        );
    });

    it("DRIFT in the PIN (pin appears in the re-read) ⇒ ABORT, [traffic-drift-during-plan], NOTHING deleted", () => {
        const exec = driftingExec({
            traffic1: ["shop-00008"],
            traffic2: ["shop-00008"],
            pin1: "", // no pin at plan time
            pin2: "shop-00007", // a rollback pinned mid-run
            labels: { "shop-00008": "bid-new", "shop-00007": "bid-old" },
        });
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("traffic-drift-during-plan");
        expect(prune).not.toHaveBeenCalled();
    });

    it("DRIFT: a revision was ADDED to currentTraffic between plan and delete ⇒ ABORT (over-keep)", () => {
        const exec = driftingExec({
            traffic1: ["shop-00008"],
            traffic2: ["shop-00008", "shop-00009"], // canary cut mid-run
            pin1: "",
            pin2: "",
            labels: { "shop-00008": "bid-new", "shop-00009": "bid-canary" },
        });
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("traffic-drift-during-plan");
        expect(prune).not.toHaveBeenCalled();
    });

    it("DRIFT: a revision was REMOVED from currentTraffic between plan and delete ⇒ ABORT (over-keep)", () => {
        const exec = driftingExec({
            traffic1: ["shop-00008", "shop-00009"],
            traffic2: ["shop-00008"], // traffic shifted fully off the canary
            pin1: "",
            pin2: "",
            labels: { "shop-00008": "bid-new", "shop-00009": "bid-canary" },
        });
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("traffic-drift-during-plan");
        expect(prune).not.toHaveBeenCalled();
    });

    it("NO drift when the SAME revision set is observed in a DIFFERENT ORDER (set comparison is order-insensitive)", () => {
        const exec = driftingExec({
            traffic1: ["shop-00008", "shop-00009"],
            traffic2: ["shop-00009", "shop-00008"], // reordered, same set
            pin1: "",
            pin2: "",
            labels: { "shop-00008": "bid-new", "shop-00009": "bid-b" },
        });
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(true);
        expect(prune).toHaveBeenCalled();
    });

    it("FAIL-SAFE: the currentTraffic RE-READ throws ⇒ treated as DRIFT, ABORT, NOTHING deleted (never 'no drift')", () => {
        const exec = driftingExec({
            traffic1: ["shop-00008"],
            traffic2: ["shop-00008"],
            pin1: "",
            pin2: "",
            labels: { "shop-00008": "bid-new" },
            trafficThrowsOn: 2, // the SECOND (re-read) currentTraffic read throws
        });
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("traffic-drift-during-plan");
        expect(prune).not.toHaveBeenCalled();
    });

    it("FAIL-SAFE: the PIN RE-READ throws ⇒ treated as DRIFT, ABORT, NOTHING deleted", () => {
        const exec = driftingExec({
            traffic1: ["shop-00008"],
            traffic2: ["shop-00008"],
            pin1: "",
            pin2: "",
            labels: { "shop-00008": "bid-new" },
            pinThrowsOn: 2, // the SECOND (re-read) pin probe throws
        });
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("traffic-drift-during-plan");
        expect(prune).not.toHaveBeenCalled();
    });

    it("no re-read is done when the plan already SKIPPED (a skip's token is never overwritten by the drift check)", () => {
        // Plan-phase skip: empty status + a pin ⇒ [pinned-with-empty-status].
        // The pre-delete re-read must not fire (there is no delete to guard),
        // and the original token must survive.
        const exec = driftingExec({
            traffic1: [],
            traffic2: ["shop-00008"], // would-be drift, must be ignored
            pin1: "shop-00007",
            pin2: "shop-00007",
            labels: { "shop-00008": "bid-new" },
        });
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("pinned-with-empty-status");
        expect(prune).not.toHaveBeenCalled();
    });
});
