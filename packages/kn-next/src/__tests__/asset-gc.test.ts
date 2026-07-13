import { describe, expect, it } from "vitest";
import {
    classifyBuilds,
    parseLiveRevisionNames,
    resolveLiveBuildIds,
    selectBuildsToDelete,
} from "../utils/asset-gc";

/**
 * Unit tests for the build-id retention GC (#93 — skew protection).
 *
 * `selectBuildsToDelete` is the SOLE build-id-pruning authority (ADR-0011). It is
 * a pure function: given the remote build-ids, their timestamps, the live set
 * (the RESOLVED build-ids of the revisions currently serving traffic — see the
 * `apps.kn-next.dev/build-id` label resolution in deploy.ts), and a retention
 * count, it returns ONLY the build-ids safe to delete. The deploy-time pruner
 * deletes exactly that set under `<app>/_next/static/<buildId>/` — never the bare
 * `<app>/` prefix (that is teardown-only, ADR-0008).
 *
 * Hard rules under test:
 *   - keep the newest `retain` build-ids (the skew window),
 *   - ALWAYS keep any build-id whose value is EXACTLY in `liveBuildIds` (a #92
 *     pinned/canary/rolled-back revision must never be reaped, even if older than
 *     the window). The match is EXACT equality, NOT substring — a build-id that
 *     merely happens to be a substring of a live token is NOT live (defect B fix:
 *     substring matching could fail to protect a real live build → over-DELETE).
 *   - never return the only/last build,
 *   - never propose deleting "nothing-scoped" (empty build-id).
 */
describe("selectBuildsToDelete", () => {
    /** Newest-last ordering helper: timestamps ascending with the id order. */
    function tsFor(ids: string[]): Record<string, number> {
        const out: Record<string, number> = {};
        ids.forEach((id, i) => {
            out[id] = 1000 + i; // A=1000, B=1001, ... → later = newer
        });
        return out;
    }

    it("keeps the newest N builds and reaps the rest (no live pins)", () => {
        const ids = ["A", "B", "C", "D"]; // D newest
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps: tsFor(ids),
            liveBuildIds: [],
            retain: 2,
        });
        // retain=2 → keep C,D (newest two); delete A,B.
        expect(new Set(del)).toEqual(new Set(["A", "B"]));
    });

    it("never reaps a live (pinned/canary/rolled-back) build even if it is older than the window", () => {
        const ids = ["A", "B", "C", "D"]; // D newest
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps: tsFor(ids),
            liveBuildIds: ["A"], // A is older than the retain window but LIVE
            retain: 2,
        });
        // Keep A (live) + C,D (window) → only B is deletable.
        expect(new Set(del)).toEqual(new Set(["B"]));
    });

    it("matches the live set by EXACT equality, not substring (defect B)", () => {
        // Realistic build-ids: deterministic deploy ids. The live set is the RESOLVED
        // build-id of the live revision (e.g. "20240101120000"). A *different* older
        // build "2024" happens to be a substring of the live token — under the old,
        // buggy substring match it would be wrongly treated as live and kept; under
        // exact matching it is correctly reaped, and the genuinely-live build is kept.
        const ids = ["2024", "b2", "b3", "20240101120000"]; // last is newest + live
        const timestamps = { "2024": 0, b2: 1, b3: 2, "20240101120000": 3 };
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps,
            liveBuildIds: ["20240101120000"], // the EXACT resolved live build-id
            retain: 1,
        });
        // Window keeps the newest (20240101120000, also live). Live set adds nothing
        // new. "2024" is NOT live (exact match), so it is reaped along with b2,b3.
        // Under the old substring logic "2024" ⊂ "20240101120000" → wrongly kept.
        expect(new Set(del)).toEqual(new Set(["2024", "b2", "b3"]));
        expect(del).toContain("2024");
    });

    it("protects an OLD live build that is outside the retain window (exact match)", () => {
        // The rollback case: an old build-id is exactly the resolved live build-id.
        const ids = ["old-live", "b2", "b3", "b4"];
        const timestamps = { "old-live": 0, b2: 1, b3: 2, b4: 3 };
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps,
            liveBuildIds: ["old-live"], // exact resolved build-id of the live revision
            retain: 2,
        });
        // Keep b3,b4 (window) + old-live (exact live) → only b2 reaped.
        expect(new Set(del)).toEqual(new Set(["b2"]));
        expect(del).not.toContain("old-live");
    });

    it("returns nothing when the remote set fits inside the retain window", () => {
        const ids = ["A", "B"];
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps: tsFor(ids),
            liveBuildIds: [],
            retain: 3,
        });
        expect(del).toEqual([]);
    });

    it("never deletes the only/last build (single remaining build is sacred)", () => {
        const del = selectBuildsToDelete({
            remoteBuildIds: ["A"],
            timestamps: tsFor(["A"]),
            liveBuildIds: [],
            retain: 0, // even with retain 0, the only build must survive
        });
        expect(del).toEqual([]);
    });

    it("clamps a zero/negative retain to keep at least the newest build", () => {
        const ids = ["A", "B", "C"];
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps: tsFor(ids),
            liveBuildIds: [],
            retain: 0,
        });
        // C (newest) is always kept; A,B reaped.
        expect(del).not.toContain("C");
        expect(new Set(del)).toEqual(new Set(["A", "B"]));
    });

    it("ignores empty / falsy build-ids — never proposes an unscoped delete", () => {
        const del = selectBuildsToDelete({
            remoteBuildIds: ["", "A", "B"],
            timestamps: { A: 1001, B: 1002 },
            liveBuildIds: [],
            retain: 1,
        });
        // "" is dropped entirely; B newest kept; only A reaped.
        expect(del).toEqual(["A"]);
        expect(del).not.toContain("");
    });

    it("orders deletes oldest-first (deterministic) and de-dupes input", () => {
        const ids = ["A", "B", "C", "D", "A"]; // duplicate A
        const del = selectBuildsToDelete({
            remoteBuildIds: ids,
            timestamps: tsFor(["A", "B", "C", "D"]),
            liveBuildIds: [],
            retain: 1,
        });
        // keep D; delete A,B,C oldest-first.
        expect(del).toEqual(["A", "B", "C"]);
    });
});

/**
 * `parseLiveRevisionNames` extracts the REVISION NAMES of the targets currently
 * serving traffic, from the operator's status JSON
 * (`kubectl get nextapp <n> -o jsonpath={.status.currentTraffic}`).
 *
 * Defect B fix: a revision name does NOT contain the build-id. Knative auto-names
 * revisions `<app>-<NNNNN>` and the deployed image is digest-pinned, so the
 * build-id cannot be recovered from the revision name. The revision names this
 * returns are therefore only an INTERMEDIATE — deploy.ts resolves each to its
 * real build-id via the `apps.kn-next.dev/build-id` label stamped by the
 * operator onto the revision (pod template), and THAT exact build-id is what
 * `selectBuildsToDelete` matches against. This function does not (and must not)
 * try to parse a build-id out of the name.
 */
describe("parseLiveRevisionNames", () => {
    it("extracts revisionNames from a CurrentTraffic JSON array", () => {
        const json = JSON.stringify([
            { revisionName: "shop-00007", percent: 80 },
            { revisionName: "shop-00008", percent: 20 },
        ]);
        expect(parseLiveRevisionNames(json)).toEqual([
            "shop-00007",
            "shop-00008",
        ]);
    });

    it("is nil-safe on empty / malformed input", () => {
        expect(parseLiveRevisionNames("")).toEqual([]);
        expect(parseLiveRevisionNames("not json")).toEqual([]);
        expect(parseLiveRevisionNames("null")).toEqual([]);
        expect(parseLiveRevisionNames("[]")).toEqual([]);
    });

    it("drops entries with no revisionName", () => {
        const json = JSON.stringify([
            { percent: 100, latestRevision: true },
            { revisionName: "shop-00001", percent: 0 },
        ]);
        expect(parseLiveRevisionNames(json)).toEqual(["shop-00001"]);
    });
});

/**
 * `resolveLiveBuildIds` turns live REVISION NAMES into their resolved build-ids
 * via an injected `resolve(revisionName) -> buildId | ''` reader (deploy.ts wires
 * this to `kubectl get revision <name> -o jsonpath={...build-id label}`,
 * READ-ONLY). It is FAIL-SAFE: if ANY live revision cannot be resolved to a
 * non-empty build-id, it returns `{ ok: false }` so the caller SKIPS the GC
 * entirely (over-keep, never over-delete — the defect-B safety property). Only
 * when every live revision resolves does it return `{ ok: true, buildIds }`.
 */
describe("resolveLiveBuildIds", () => {
    it("resolves every live revision to its build-id label", () => {
        const resolve = (rev: string) =>
            ({ "shop-00007": "b-new", "shop-00006": "b-old" })[rev] ?? "";
        const res = resolveLiveBuildIds(["shop-00007", "shop-00006"], resolve);
        expect(res.ok).toBe(true);
        expect(res.ok && new Set(res.buildIds)).toEqual(
            new Set(["b-new", "b-old"]),
        );
    });

    it("FAILS SAFE (ok=false) if any revision has no build-id label", () => {
        // One live revision predates the build-id label (or the label read failed) →
        // we cannot prove its build is safe → skip GC entirely rather than risk
        // reaping a live build (defect B: over-keep, never over-delete).
        const resolve = (rev: string) => (rev === "shop-00007" ? "b-new" : "");
        const res = resolveLiveBuildIds(["shop-00007", "shop-00006"], resolve);
        expect(res.ok).toBe(false);
    });

    it("FAILS SAFE if the resolver throws for any revision", () => {
        const resolve = (rev: string) => {
            if (rev === "shop-00006") throw new Error("kubectl error");
            return "b-new";
        };
        const res = resolveLiveBuildIds(["shop-00007", "shop-00006"], resolve);
        expect(res.ok).toBe(false);
    });

    it("an empty live set resolves ok with no build-ids (window-only GC)", () => {
        // No revision is serving (e.g. fully scaled to zero with no traffic status)
        // → nothing extra to protect; GC proceeds on the retain window alone.
        const res = resolveLiveBuildIds([], () => "");
        expect(res.ok).toBe(true);
        expect(res.ok && res.buildIds).toEqual([]);
    });
});

/**
 * #264 part 2 — `classifyBuilds` is the single source of truth behind BOTH
 * `selectBuildsToDelete` (the reap set) and the `--dry-run` plan's keep
 * buckets. Every candidate lands in EXACTLY one bucket; the reap set can never
 * drift from the printed plan because the selector delegates to it.
 */
describe("classifyBuilds (#264 part 2 — dry-run keep buckets)", () => {
    it("partitions every candidate into exactly one bucket: reap / keptWindow / keptLive", () => {
        const res = classifyBuilds({
            remoteBuildIds: ["a", "b", "c", "d"],
            timestamps: { a: 1, b: 2, c: 3, d: 4 },
            liveBuildIds: ["a"],
            retain: 1,
        });
        expect(res.keptWindow).toEqual(["d"]);
        expect(res.keptLive).toEqual(["a"]);
        expect(res.reap).toEqual(["b", "c"]); // oldest-first
        // Total + disjoint: the three buckets are a partition of the input.
        const all = [...res.reap, ...res.keptWindow, ...res.keptLive].sort();
        expect(all).toEqual(["a", "b", "c", "d"]);
    });

    it("a live id INSIDE the window is window-kept, never double-counted as live-kept", () => {
        const res = classifyBuilds({
            remoteBuildIds: ["a", "b", "c"],
            timestamps: { a: 1, b: 2, c: 3 },
            liveBuildIds: ["c"],
            retain: 2,
        });
        expect(res.keptWindow).toEqual(["c", "b"]); // newest-first
        expect(res.keptLive).toEqual([]);
        expect(res.reap).toEqual(["a"]);
    });

    it("selectBuildsToDelete IS classifyBuilds().reap (no parallel selector to drift)", () => {
        const input = {
            remoteBuildIds: ["a", "b", "c", "d", "e"],
            timestamps: { a: 1, b: 2, c: 3, d: 4, e: 5 },
            liveBuildIds: ["b"],
            retain: 2,
        };
        expect(selectBuildsToDelete(input)).toEqual(classifyBuilds(input).reap);
    });

    it("the only/last build is window-kept, never reaped", () => {
        const res = classifyBuilds({
            remoteBuildIds: ["solo"],
            timestamps: { solo: 1 },
            liveBuildIds: [],
            retain: 1,
        });
        expect(res.reap).toEqual([]);
        expect(res.keptWindow).toEqual(["solo"]);
        expect(res.keptLive).toEqual([]);
    });
});
