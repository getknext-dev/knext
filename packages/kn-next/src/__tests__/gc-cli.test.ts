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

import { parseGcArgs, renderGcReport, runAssetGC } from "../cli/gc";
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
    it("reads status.currentTraffic, the spec pin, then each live revision's build-id label — READ-ONLY argv, exact shape", () => {
        const calls: string[][] = [];
        const exec = (argv: readonly string[]): string => {
            calls.push([...argv]);
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00002"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return ""; // no pin
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
        // Second read: the spec pin, UNCONDITIONALLY (#272 residual — a
        // populated status can lag a fresh rollback pin).
        expect(calls[1]).toEqual([
            "kubectl",
            "get",
            "nextapp",
            "shop",
            "-n",
            "prod",
            "-o",
            "jsonpath={.spec.traffic.revisionName}",
        ]);
        // Third read: the revision's operator-stamped build-id label. The
        // dotted/slashed key is escaped as ONE jsonpath token.
        expect(calls[2]).toEqual([
            "kubectl",
            "get",
            "revision",
            "shop-00002",
            "-n",
            "prod",
            "-o",
            "jsonpath={.metadata.labels.apps\\.kn-next\\.dev/build-id}",
        ]);
        // v3-P4b TOCTOU re-read: immediately before the prune, the pin +
        // status.currentTraffic are RE-READ ONCE more (a second observation).
        // The re-read is the pin probe then the currentTraffic read — same
        // READ-ONLY argv, no new per-revision label reads.
        expect(calls[3]).toEqual([
            "kubectl",
            "get",
            "nextapp",
            "shop",
            "-n",
            "prod",
            "-o",
            "jsonpath={.spec.traffic.revisionName}",
        ]);
        expect(calls[4]).toEqual([
            "kubectl",
            "get",
            "nextapp",
            "shop",
            "-n",
            "prod",
            "-o",
            "jsonpath={.status.currentTraffic}",
        ]);
        // status + pin (plan) + ONE revision label + pin + status (re-read):
        // exactly 5 READ-ONLY reads, no writes, no extra per-revision reads.
        expect(calls).toHaveLength(5);
        expect(calls.filter((argv) => argv.includes("revision"))).toHaveLength(
            1,
        );
        expect(prune).toHaveBeenCalledWith(
            expect.anything(),
            ["bid-a"],
            "bid-d",
            { dryRun: false },
        );
    });

    it("--dry-run (#264 part 2): dryRun flows to the prune boundary; the READ-ONLY cluster reads still run", () => {
        const calls: string[][] = [];
        const exec = (argv: readonly string[]): string => {
            calls.push([...argv]);
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00002"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return ""; // no pin
            return "bid-a";
        };
        const prune = vi.fn();

        const res = runAssetGC(
            makeConfig(),
            "prod",
            "bid-d",
            exec,
            prune,
            true,
        );

        expect(res.pruned).toBe(true);
        // The read-only resolution is IDENTICAL under dry-run (same argv).
        expect(calls).toHaveLength(3);
        expect(prune).toHaveBeenCalledWith(
            expect.anything(),
            ["bid-a"],
            "bid-d",
            { dryRun: true },
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

    it("empty currentTraffic AND no spec pin ⇒ window-only GC (prune with an empty live set)", () => {
        const exec = (argv: readonly string[]): string => {
            // Both NextApp reads (status.currentTraffic, then the #264
            // spec.traffic.revisionName pin probe) come back empty.
            if (argv.includes("nextapp")) return "";
            throw new Error("unexpected revision read");
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(true);
        expect(prune).toHaveBeenCalledWith(expect.anything(), [], "bid-d", {
            dryRun: false,
        });
    });

    it("FAIL-SAFE (#264): spec.traffic.revisionName pinned but status.currentTraffic empty ⇒ NO prune (over-keep)", () => {
        // status wiped/lagging while a rollback pin is set in spec: a
        // window-only prune could reap the pinned build. Must skip loudly.
        const calls: string[][] = [];
        const exec = (argv: readonly string[]): string => {
            calls.push([...argv]);
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return "";
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return "shop-00007";
            throw new Error("unexpected read");
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("pinned-with-empty-status");
        expect(res.pinnedRevision).toBe("shop-00007");
        expect(prune).not.toHaveBeenCalled();
        // The pin probe is a READ-ONLY nextapp get with the exact jsonpath.
        expect(calls[1]).toEqual([
            "kubectl",
            "get",
            "nextapp",
            "shop",
            "-n",
            "prod",
            "-o",
            "jsonpath={.spec.traffic.revisionName}",
        ]);
    });

    it("FAIL-SAFE (#264): a THROWING spec-pin probe (with empty status) ⇒ NO prune (over-keep, no throw)", () => {
        const exec = (argv: readonly string[]): string => {
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return "";
            throw new Error("kubectl blew up reading the spec");
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("pinned-with-empty-status");
        expect(prune).not.toHaveBeenCalled();
    });

    // #272 sysdesign-gate residual (folded into #254): a populated
    // status.currentTraffic is NOT authoritative — it can LAG the spec (a
    // rollback pin applied but not yet re-observed by the operator). The pin
    // is therefore read UNCONDITIONALLY and its build-id unioned into the
    // protected set; an unresolvable pin fail-safe-skips (over-keep).
    it("PIN PROTECTION (#272 residual): spec pin with a LAGGING non-empty status ⇒ the pin's build-id is unioned into the protected set", () => {
        const calls: string[][] = [];
        const exec = (argv: readonly string[]): string => {
            calls.push([...argv]);
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00008"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return "shop-00007"; // the lagging pin — NOT in currentTraffic
            if (argv.includes("shop-00008")) return "bid-new";
            if (argv.includes("shop-00007")) return "bid-old";
            throw new Error("unexpected read");
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(true);
        // The pin's build resolves through the SAME operator-stamped label
        // read the live revisions use.
        expect(calls).toContainEqual([
            "kubectl",
            "get",
            "revision",
            "shop-00007",
            "-n",
            "prod",
            "-o",
            "jsonpath={.metadata.labels.apps\\.kn-next\\.dev/build-id}",
        ]);
        expect(prune).toHaveBeenCalledWith(
            expect.anything(),
            ["bid-new", "bid-old"],
            "bid-d",
            {
                dryRun: false,
            },
        );
    });

    it("PIN PROTECTION: a pin already in currentTraffic needs NO extra label read (already protected)", () => {
        const calls: string[][] = [];
        const exec = (argv: readonly string[]): string => {
            calls.push([...argv]);
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00007"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return "shop-00007";
            return "bid-a";
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(true);
        // status + pin probe + ONE revision-label read (the live one), then the
        // v3-P4b pre-delete re-read (pin + status again). The pin being already in
        // currentTraffic still triggers NO extra per-revision label read — exactly
        // one `kubectl get revision` across the whole run.
        expect(calls).toHaveLength(5);
        expect(calls.filter((argv) => argv.includes("revision"))).toHaveLength(
            1,
        );
        expect(prune).toHaveBeenCalledWith(
            expect.anything(),
            ["bid-a"],
            "bid-d",
            { dryRun: false },
        );
    });

    it("PIN PROTECTION: a pin resolving to an already-protected build-id is not duplicated (union, not append)", () => {
        const exec = (argv: readonly string[]): string => {
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00008"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return "shop-00007";
            return "bid-x"; // both revisions carry the same build
        };
        const prune = vi.fn();

        runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(prune).toHaveBeenCalledWith(
            expect.anything(),
            ["bid-x"],
            "bid-d",
            { dryRun: false },
        );
    });

    it("FAIL-SAFE: a pin whose build-id label is missing ⇒ NO prune, [pinned-not-resolvable]", () => {
        const exec = (argv: readonly string[]): string => {
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00008"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return "shop-00007";
            // live revision resolves; the pinned one has NO label (or is gone).
            return argv.includes("shop-00008") ? "bid-new" : "";
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("pinned-not-resolvable");
        expect(res.pinnedRevision).toBe("shop-00007");
        expect(prune).not.toHaveBeenCalled();
    });

    it("FAIL-SAFE: a THROWING pin label read ⇒ NO prune, [pinned-not-resolvable] (over-keep, no throw)", () => {
        const exec = (argv: readonly string[]): string => {
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00008"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                return "shop-00007";
            if (argv.includes("shop-00008")) return "bid-new";
            throw new Error("kubectl blew up on the pinned revision");
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("pinned-not-resolvable");
        expect(prune).not.toHaveBeenCalled();
    });

    it("FAIL-SAFE: a THROWING pin probe with NON-empty status ⇒ NO prune, [pinned-not-resolvable] (cannot prove there is no pin)", () => {
        const calls: string[][] = [];
        const exec = (argv: readonly string[]): string => {
            calls.push([...argv]);
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00008"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                throw new Error("kubectl blew up reading the spec");
            return "bid-new";
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("pinned-not-resolvable");
        expect(res.pinnedRevision).toBe("(unreadable)");
        expect(prune).not.toHaveBeenCalled();
        // The skip fires BEFORE any live-revision label resolution: a failed
        // probe already forces the fail-safe, so the N per-revision reads are
        // pointless work (#261 ride-along, from the #273 gates). Exactly the
        // status read + the pin probe — no `kubectl get revision` calls.
        expect(calls).toHaveLength(2);
        expect(calls.some((argv) => argv.includes("revision"))).toBe(false);
    });

    it("TOKEN PRECEDENCE (#274 gate): pin probe throws AND the live label would be unresolvable ⇒ [pinned-not-resolvable], never [unresolvable-live-build-id]", () => {
        // Both fail-safes are armed at once: the spec-pin probe throws AND the
        // live revision's build-id label read would come back empty. The
        // pin-probe skip is decided FIRST (before any label resolution), so
        // the machine-greppable token an operator alerts on must be
        // pinned-not-resolvable — a re-ordering of the fail-safes would
        // silently change the token and break dashboards/runbooks keyed on it.
        const exec = (argv: readonly string[]): string => {
            if (argv.some((a) => a.includes(".status.currentTraffic")))
                return trafficJson(["shop-00008"]);
            if (argv.some((a) => a.includes(".spec.traffic.revisionName")))
                throw new Error("kubectl blew up reading the spec");
            return ""; // live label unresolvable — must never be reached/win
        };
        const prune = vi.fn();

        const res = runAssetGC(makeConfig(), "prod", "bid-d", exec, prune);

        expect(res.pruned).toBe(false);
        expect(res.skipReason).toBe("pinned-not-resolvable");
        expect(res.pinnedRevision).toBe("(unreadable)");
        expect(prune).not.toHaveBeenCalled();
    });
});

describe("parseGcArgs", () => {
    it("parses --build-id and -n/--namespace", () => {
        expect(parseGcArgs(["--build-id", "bid-d", "-n", "prod"])).toEqual({
            namespace: "prod",
            buildId: "bid-d",
            dryRun: false,
        });
        expect(parseGcArgs(["--namespace", "prod"])).toEqual({
            namespace: "prod",
            buildId: "",
            dryRun: false,
        });
    });

    it("defaults: namespace=default, empty build-id (window falls back to listing order), dryRun off", () => {
        expect(parseGcArgs([])).toEqual({
            namespace: "default",
            buildId: "",
            dryRun: false,
        });
    });

    it("--dry-run (#264 part 2) composes with --build-id and -n, in any order", () => {
        expect(
            parseGcArgs(["--dry-run", "--build-id", "bid-d", "-n", "prod"]),
        ).toEqual({
            namespace: "prod",
            buildId: "bid-d",
            dryRun: true,
        });
        expect(parseGcArgs(["--build-id", "bid-d", "--dry-run"])).toEqual({
            namespace: "default",
            buildId: "bid-d",
            dryRun: true,
        });
    });

    it("is STRICT: unknown flags / dangling values are hard errors (gc DELETES objects)", () => {
        expect(() => parseGcArgs(["--buildid", "x"])).toThrow(/unknown flag/);
        expect(() => parseGcArgs(["--build-id"])).toThrow(/requires a value/);
        expect(() => parseGcArgs(["stray"])).toThrow(/unexpected positional/);
    });

    it("stays STRICT around --dry-run: near-miss spellings hard-error, never a silent wet run", () => {
        expect(() => parseGcArgs(["--dryrun"])).toThrow(/unknown flag/);
        expect(() => parseGcArgs(["--dry-run=true"])).toThrow(/unknown flag/);
        expect(() => parseGcArgs(["--dry_run"])).toThrow(/unknown flag/);
    });
});

describe("renderGcReport (#264 part 2 — the synchronous fd-1 outcome line)", () => {
    const summary = {
        reaped: ["b2", "b3"],
        keptUnmarked: ["turbo"],
        keptWindow: ["b4"],
        keptLive: ["b1"],
        reservedExcluded: ["chunks", "css"],
        dryRun: false,
    };

    it("dry-run: prints the FULL reap/keep plan (reap candidates, window-kept, live-kept, unmarked-kept, reserved-excluded) and that NOTHING was deleted", () => {
        const text = renderGcReport("shop", "prod", {
            pruned: true,
            liveRevisions: ["shop-00007"],
            summary: { ...summary, dryRun: true },
        });
        expect(text).toContain("DRY-RUN");
        expect(text).toContain("would reap");
        for (const tok of [
            "b2",
            "b3",
            "b4",
            "b1",
            "turbo",
            "chunks",
            "css",
            "shop-00007",
        ]) {
            expect(text).toContain(tok);
        }
        expect(text.toLowerCase()).toContain("nothing was deleted");
        // A dry-run must never masquerade as a completed wet prune.
        expect(text).not.toContain("gc: completed");
    });

    it("wet run: keeps the `gc: completed` contract with reaped ids + the loud unmarked-keep note", () => {
        const text = renderGcReport("shop", "prod", {
            pruned: true,
            liveRevisions: ["shop-00007"],
            summary,
        });
        expect(text).toContain("gc: completed for shop (ns prod)");
        expect(text).toContain("b2");
        expect(text).toContain("turbo");
        expect(text).not.toContain("DRY-RUN");
    });

    it("skip lines carry the machine-greppable reason token (pinned-with-empty-status / unresolvable-live-build-id)", () => {
        const pinned = renderGcReport("shop", "prod", {
            pruned: false,
            liveRevisions: [],
            skipReason: "pinned-with-empty-status",
            pinnedRevision: "shop-00007",
        });
        expect(pinned).toContain("SKIPPED (fail-safe over-keep)");
        expect(pinned).toContain("pinned-with-empty-status");
        expect(pinned).toContain("shop-00007");
        expect(pinned).toContain("Nothing was deleted");

        const unresolvable = renderGcReport("shop", "prod", {
            pruned: false,
            liveRevisions: ["shop-00002"],
            skipReason: "unresolvable-live-build-id",
        });
        expect(unresolvable).toContain("SKIPPED (fail-safe over-keep)");
        expect(unresolvable).toContain("unresolvable-live-build-id");
        expect(unresolvable).toContain("shop-00002");

        // #272 residual: the unresolvable-PIN skip has its own token.
        const pinUnresolvable = renderGcReport("shop", "prod", {
            pruned: false,
            liveRevisions: ["shop-00008"],
            skipReason: "pinned-not-resolvable",
            pinnedRevision: "shop-00007",
        });
        expect(pinUnresolvable).toContain("SKIPPED (fail-safe over-keep)");
        expect(pinUnresolvable).toContain("[pinned-not-resolvable]");
        expect(pinUnresolvable).toContain("shop-00007");
        expect(pinUnresolvable).toContain("Nothing was deleted");
    });
});
