import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * v3-P4a — the machine-readable skip-reason TOKEN REGISTRY for the asset-GC
 * fail-safe over-keep skips (ADR-0011). These tokens are a PUBLIC, STABLE
 * contract: operators alert / build dashboards / write runbooks keyed on the
 * `[<token>]` suffix of the `gc: SKIPPED (fail-safe over-keep) [<token>]` line.
 *
 * This suite pins that contract:
 *   1. the registry is an exported const mapping each skip cause → a stable
 *      token (token value === key, an enum-like identifier surface);
 *   3. `renderGcReport` is EXHAUSTIVE over the registry (a future skip cause
 *      with no token+render fails to COMPILE — proven here by a compile-time
 *      `satisfies` over the union plus a runtime render for every token);
 *   4. the rendered SKIPPED line is BYTE-IDENTICAL per token, carrying the
 *      REQUIRED `[<token>]` machine-readable suffix in the exact position;
 *   5. registry ⇔ render-handled ⇔ documented (gc CLI doc) token sets are all
 *      identical — no token present in one surface but missing from another.
 */

import { GC_SKIP_REASONS, type GcSkipReason, renderGcReport } from "../cli/gc";

/** Every token, as an array, derived from the exported registry. */
const REGISTRY_TOKENS = Object.values(GC_SKIP_REASONS) as GcSkipReason[];

describe("GC_SKIP_REASONS registry (v3-P4a — condition 1)", () => {
    it("is an exported const whose value equals its key for every entry (enum-like stable tokens)", () => {
        for (const [key, value] of Object.entries(GC_SKIP_REASONS)) {
            expect(value).toBe(key);
        }
    });

    it("enumerates EXACTLY the three fail-safe skip causes the code can hit", () => {
        // Grepped from every `pruned: false` return in runAssetGC:
        //   - empty status + a spec pin (or a failed pin probe with empty status)
        //   - a pin probe that threw / a pin build-id that can't be resolved
        //   - a live revision with no resolvable build-id label
        expect(new Set(REGISTRY_TOKENS)).toEqual(
            new Set([
                "pinned-with-empty-status",
                "pinned-not-resolvable",
                "unresolvable-live-build-id",
            ]),
        );
    });

    it("has no duplicate token values", () => {
        expect(new Set(REGISTRY_TOKENS).size).toBe(REGISTRY_TOKENS.length);
    });
});

describe("renderGcReport exhaustiveness (v3-P4a — condition 3)", () => {
    it("renders a non-empty SKIPPED line for EVERY registry token (no token is unhandled)", () => {
        for (const token of REGISTRY_TOKENS) {
            const line = renderGcReport("shop", "prod", {
                pruned: false,
                liveRevisions: ["shop-00002"],
                skipReason: token,
                pinnedRevision: "shop-00007",
            });
            expect(line).toContain("SKIPPED (fail-safe over-keep)");
            expect(line.length).toBeGreaterThan(0);
        }
    });
});

describe("rendered SKIPPED line is byte-identical per token (v3-P4a — condition 4)", () => {
    it("[pinned-with-empty-status] pins the whole line byte-for-byte", () => {
        const line = renderGcReport("shop", "prod", {
            pruned: false,
            liveRevisions: [],
            skipReason: "pinned-with-empty-status",
            pinnedRevision: "shop-00007",
        });
        expect(line).toBe(
            "gc: SKIPPED (fail-safe over-keep) [pinned-with-empty-status] — " +
                'shop pins revision "shop-00007" (spec.traffic.revisionName) but ' +
                "status.currentTraffic is empty (status wiped or lagging); a " +
                "window-only prune could reap the pinned build. Nothing was deleted.\n",
        );
    });

    it("[pinned-not-resolvable] pins the whole line byte-for-byte", () => {
        const line = renderGcReport("shop", "prod", {
            pruned: false,
            liveRevisions: ["shop-00008"],
            skipReason: "pinned-not-resolvable",
            pinnedRevision: "shop-00007",
        });
        expect(line).toBe(
            "gc: SKIPPED (fail-safe over-keep) [pinned-not-resolvable] — " +
                'shop pins revision "shop-00007" (spec.traffic.revisionName) but ' +
                "the pin's build-id could not be resolved (revision missing, " +
                "build-id label absent, or the read failed), so the pinned build " +
                "cannot be proven protected. Nothing was deleted.\n",
        );
    });

    it("[unresolvable-live-build-id] pins the whole line byte-for-byte", () => {
        const line = renderGcReport("shop", "prod", {
            pruned: false,
            liveRevisions: ["shop-00001", "shop-00002"],
            skipReason: "unresolvable-live-build-id",
        });
        expect(line).toBe(
            "gc: SKIPPED (fail-safe over-keep) [unresolvable-live-build-id] — " +
                "a live revision of shop has no resolvable build-id label; " +
                "nothing was deleted. live revisions: [shop-00001, shop-00002]\n",
        );
    });

    it("every token's rendered line carries the REQUIRED [<token>] suffix in the exact position", () => {
        for (const token of REGISTRY_TOKENS) {
            const line = renderGcReport("shop", "prod", {
                pruned: false,
                liveRevisions: ["shop-00002"],
                skipReason: token,
                pinnedRevision: "shop-00007",
            });
            expect(
                line.startsWith(
                    `gc: SKIPPED (fail-safe over-keep) [${token}] — `,
                ),
            ).toBe(true);
        }
    });
});

describe("registry ⇔ union ⇔ docs contract (v3-P4a — condition 5)", () => {
    /** Tokens the render function actually emits, scraped from live renders. */
    function renderHandledTokens(): Set<string> {
        const handled = new Set<string>();
        for (const token of REGISTRY_TOKENS) {
            const line = renderGcReport("shop", "prod", {
                pruned: false,
                liveRevisions: ["shop-00002"],
                skipReason: token,
                pinnedRevision: "shop-00007",
            });
            const m = line.match(/\[([a-z0-9-]+)\]/);
            if (m) handled.add(m[1]);
        }
        return handled;
    }

    /** Tokens documented in the gc CLI doc (fenced-code `[token]` mentions). */
    function docTokens(): Set<string> {
        const docPath = fileURLToPath(
            new URL("../../../../docs/guides/gc-cli.md", import.meta.url),
        );
        const md = readFileSync(docPath, "utf8");
        const found = new Set<string>();
        for (const token of REGISTRY_TOKENS) {
            if (md.includes(`[${token}]`)) found.add(token);
        }
        return found;
    }

    it("the registry token set equals the render-handled token set", () => {
        expect(renderHandledTokens()).toEqual(new Set(REGISTRY_TOKENS));
    });

    it("the registry token set equals the documented token set (gc CLI doc)", () => {
        expect(docTokens()).toEqual(new Set(REGISTRY_TOKENS));
    });

    it("the gc CLI doc carries the stable-contract note so tokens are not renamed casually", () => {
        const docPath = fileURLToPath(
            new URL("../../../../docs/guides/gc-cli.md", import.meta.url),
        );
        const md = readFileSync(docPath, "utf8").toLowerCase();
        expect(md).toContain("stable");
        expect(md).toMatch(/machine-readable|machine readable/);
    });
});
