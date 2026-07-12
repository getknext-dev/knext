import { describe, expect, it, vi } from "vitest";

/**
 * `kn-next gc` — the standalone entry point for the deploy-time asset
 * retention GC (#93, ADR-0011), extracted from deploy.ts so the e2e_gc suite
 * (and operators after a rollback) can drive the EXACT wiring deploy runs:
 *
 *   status.currentTraffic (read-only)
 *     → parseLiveRevisionNames
 *       → resolve each revision's `apps.kn-next.dev/build-id` label (read-only)
 *         → resolveLiveBuildIds (FAIL-SAFE: any unresolvable live revision
 *           ⇒ skip the GC entirely — over-keep, never over-delete)
 *           → pruneOldBuilds(config, liveBuildIds, newBuildId)
 *
 * These tests pin the argv contract of the two READ-ONLY kubectl reads
 * (ADR-0001: the CLI never mutates the cluster here) and the fail-safe skip.
 * The prune itself is covered by asset-prune.test.ts; the pure selector by
 * asset-gc.test.ts; the live end-to-end proof by the e2e_gc kind suite.
 */

import { parseGcArgs, runAssetGC } from "../cli/gc";
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

/** currentTraffic JSON as the operator writes it (#92). */
function trafficJson(revisions: string[]): string {
    return JSON.stringify(
        revisions.map((r) => ({ revisionName: r, percent: 100 })),
    );
}

describe("runAssetGC", () => {
    it("reads status.currentTraffic then each live revision's build-id label — READ-ONLY argv, exact shape", () => {
        const calls: string[][] = [];
        const exec = (argv: readonly string[]): string => {
            calls.push([...argv]);
            if (argv.includes("nextapp")) return trafficJson(["shop-00002"]);
            return "bid-a";
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(true);
        // First read: the NextApp's observed traffic (the operator's status).
        expect(calls[0]).toEqual([
            "kubectl",
            "get",
            "nextapp",
            "shop",
            "-n",
            "prod",
            "-o",
            "jsonpath={.status.currentTraffic}",
        ]);
        // Second read: the revision's operator-stamped build-id label. The
        // dotted/slashed key is escaped as ONE jsonpath token.
        expect(calls[1]).toEqual([
            "kubectl",
            "get",
            "revision",
            "shop-00002",
            "-n",
            "prod",
            "-o",
            "jsonpath={.metadata.labels.apps\\.kn-next\\.dev/build-id}",
        ]);
        // NOTHING else was exec'd through the kubectl boundary (no writes).
        expect(calls).toHaveLength(2);
        expect(prune).toHaveBeenCalledWith(
            expect.anything(),
            ["bid-a"],
            "bid-d",
        );
    });

    it("FAIL-SAFE: a live revision without the build-id label ⇒ NO prune at all (over-keep)", () => {
        const exec = (argv: readonly string[]): string => {
            if (argv.includes("nextapp"))
                return trafficJson(["shop-00001", "shop-00002"]);
            // shop-00001 resolves; shop-00002 has NO label (predates #93).
            return argv.includes("shop-00001") ? "bid-a" : "";
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.liveRevisions).toEqual(["shop-00001", "shop-00002"]);
        expect(prune).not.toHaveBeenCalled();
    });

    it("FAIL-SAFE: a throwing label read ⇒ NO prune (over-keep), no throw", () => {
        const exec = (argv: readonly string[]): string => {
            if (argv.includes("nextapp")) return trafficJson(["shop-00002"]);
            throw new Error("kubectl blew up");
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(prune).not.toHaveBeenCalled();
    });

    it("propagates a failed status read (callers decide: deploy warns, `kn-next gc` exits non-zero)", () => {
        const exec = (): string => {
            throw new Error("no such nextapp");
        };
        expect(() =>
            runAssetGC(makeConfig(), "prod", "bid-d", exec, vi.fn()),
        ).toThrow(/no such nextapp/);
    });

    it("empty currentTraffic ⇒ window-only GC (prune with an empty live set)", () => {
        const exec = (argv: readonly string[]): string => {
            if (argv.includes("nextapp")) return "";
            throw new Error("unexpected revision read");
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(true);
        expect(prune).toHaveBeenCalledWith(expect.anything(), [], "bid-d");
    });
});

describe("parseGcArgs", () => {
    it("parses --build-id and -n/--namespace", () => {
        expect(parseGcArgs(["--build-id", "bid-d", "-n", "prod"])).toEqual({
            namespace: "prod",
            buildId: "bid-d",
        });
        expect(parseGcArgs(["--namespace", "prod"])).toEqual({
            namespace: "prod",
            buildId: "",
        });
    });

    it("defaults: namespace=default, empty build-id (window falls back to listing order)", () => {
        expect(parseGcArgs([])).toEqual({ namespace: "default", buildId: "" });
    });

    it("is STRICT: unknown flags / dangling values are hard errors (gc DELETES objects)", () => {
        expect(() => parseGcArgs(["--buildid", "x"])).toThrow(/unknown flag/);
        expect(() => parseGcArgs(["--build-id"])).toThrow(/requires a value/);
        expect(() => parseGcArgs(["stray"])).toThrow(/unexpected positional/);
    });
});
