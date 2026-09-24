/**
 * #1167 — the standalone build target becomes SELECTABLE (ADR-0054 item 6).
 *
 * This is the ACTIVATOR for the standalone-image path. The runtime image
 * (#1177) and the CLI staging (#1181) were correct plumbing but unreachable:
 * the validator REJECTED `build: "turbopack"` ("retired by ADR-0048"), so no
 * config could ever reach `selectRuntimeImage`'s standalone branch. This suite
 * pins the reversal — `build: "turbopack"` + `runtime: "bun"|"node"` now
 * validates and reaches the standalone staging — and, critically, exercises the
 * WHOLE path (`loadConfig` → `validateConfig` → `selectRuntimeImage`)
 * end-to-end, which nothing did before (cr-1181 noted the unreachability stayed
 * invisible precisely because no test crossed the seam).
 *
 * The default FLIPPED in #1183 (ADR-0058, founder decision 2026-09-24):
 * `DEFAULT_BUILDER_ID` is now `"turbopack"` (the standalone / bun-standalone
 * family), pinned by the guard test below. vinext stays selectable (and
 * remains the v1.x-credentialed builder per ADR-0058), but an absent
 * `config.build` now resolves to the standalone shape.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    AVAILABLE_BUILDERS,
    DEFAULT_BUILDER_ID,
    turbopackBuilder,
    vinextBuilder,
} from "../adapters/artifact-contract";
import { selectRuntimeImage } from "../cli/runtime-image";
import { validateConfig } from "../cli/validate";
import type { KnativeNextConfig } from "../config";
import { loadConfig } from "../loader";

const _tmpDirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-selectable-"));
    _tmpDirs.push(dir);
    return dir;
}
// D9 (#880): every mkdtemp gets a paired removal.
afterAll(() => {
    for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function cfg(overrides: Partial<KnativeNextConfig> = {}): KnativeNextConfig {
    return {
        name: "sel-app",
        registry: "example.io/team",
        ...overrides,
    } as KnativeNextConfig;
}

describe("#1167 the standalone target is selectable", () => {
    it("marks turbopack, vinext, AND webpack available in the contract", () => {
        // All halves: the whole point is that they are selectable together,
        // not that one replaced another (founder-directed: vinext stays;
        // webpack joins turbopack as a second standalone-shape spelling, #1219).
        expect(turbopackBuilder.available).toBe(true);
        expect(vinextBuilder.available).toBe(true);
        const ids = AVAILABLE_BUILDERS.map((b) => b.id).sort();
        expect(ids).toEqual(["turbopack", "vinext", "webpack"]);
    });

    it("pins turbopack as the default builder (#1183, ADR-0058) — an accidental revert reds here", () => {
        // Post-flip guard: DEFAULT_BUILDER_ID must stay "turbopack" now that
        // the bun-standalone family is the credentialed v1.0 default. If
        // someone reverts this to "vinext" (or anything else) this reds,
        // which is the point — the default is deliberate, not incidental.
        expect(DEFAULT_BUILDER_ID).toBe("turbopack");
    });

    it("ACCEPTS build=turbopack + runtime=bun (was rejected as retired)", () => {
        expect(() =>
            validateConfig(cfg({ build: "turbopack", runtime: "bun" })),
        ).not.toThrow();
    });

    it("ACCEPTS build=turbopack + runtime=node — node CAN run the standalone shape", () => {
        // turbopack emits `next-standalone`, which node accepts (measured — it
        // is the very shape the 778/0 node credential was earned on). So the
        // pairing must pass, unlike vinext+node.
        expect(() =>
            validateConfig(cfg({ build: "turbopack", runtime: "node" })),
        ).not.toThrow();
    });

    it("ACCEPTS bare build=turbopack (runtime absent, defaults to node)", () => {
        expect(() => validateConfig(cfg({ build: "turbopack" }))).not.toThrow();
    });

    it("ACCEPTS vinext+bun and vinext+node — each builds the preset its runtime runs (#1260)", () => {
        // vinext+node was refused while the only vinext artifact was the
        // bun-preset nitro output (it crashes under node). #1260 builds the
        // node-server preset for runtime: node, so both pairings validate.
        expect(() =>
            validateConfig(cfg({ build: "vinext", runtime: "bun" })),
        ).not.toThrow();
        expect(() =>
            validateConfig(cfg({ build: "vinext", runtime: "node" })),
        ).not.toThrow();
    });

    it("no error message mentions the ADR-0048 retirement for turbopack any more", () => {
        // Mutation-shaped: if the retired-by-ADR-0048 branch is left firing for
        // turbopack, this catches it directly rather than only via not.toThrow.
        let msg = "";
        try {
            validateConfig(cfg({ build: "turbopack", runtime: "bun" }));
        } catch (e) {
            msg = (e as Error).message;
        }
        expect(msg).toBe("");
    });
});

describe("#1167 end-to-end reachability: loadConfig -> validateConfig -> selectRuntimeImage", () => {
    /**
     * The seam cr-1181 said nothing crossed. Writing a real config file,
     * loading it through the shipped loader, validating it, and driving
     * `selectRuntimeImage` off the SAME object is what proves the standalone
     * image path is genuinely user-reachable — not just that each unit passes
     * in isolation.
     */
    async function loadFixture(source: string): Promise<KnativeNextConfig> {
        const dir = tmp();
        const path = join(dir, "kn-next.config.ts");
        writeFileSync(path, source, "utf8");
        return loadConfig(path);
    }

    it("a turbopack+bun config loads, validates, and stages the STANDALONE Dockerfile", async () => {
        const config = await loadFixture(
            `const config = {
                name: "e2e-standalone",
                registry: "example.io/team",
                build: "turbopack",
                runtime: "bun",
            };
            export default config;`,
        );
        // Loaded shape is what the user wrote.
        expect(config.build).toBe("turbopack");
        expect(config.runtime).toBe("bun");
        // Validator no longer rejects it.
        expect(() => validateConfig(config)).not.toThrow();
        // And the selection reaches the standalone recipe with the bun stage.
        const sel = selectRuntimeImage(config, "/app");
        expect(sel.kind).toBe("standalone");
        expect(sel.target).toBe("standalone-bun");
        expect(sel.dockerfile).toBe(join("/app", "Dockerfile.standalone"));
    });

    it("a turbopack+node config resolves to the standalone-node stage end-to-end", async () => {
        const config = await loadFixture(
            `export default {
                name: "e2e-node",
                registry: "example.io/team",
                build: "turbopack",
                runtime: "node",
            };`,
        );
        expect(() => validateConfig(config)).not.toThrow();
        const sel = selectRuntimeImage(config, "/app");
        expect(sel.kind).toBe("standalone");
        expect(sel.target).toBe("standalone-node");
    });

    it("the default (bare) config now routes to the standalone Dockerfile end-to-end (#1183)", async () => {
        // Post-flip: an absent build/runtime resolves to DEFAULT_BUILDER_ID
        // ("turbopack") and the config.ts-documented default runtime ("node"),
        // so a bare config reaches the standalone-node stage, not the vinext
        // single-stage Dockerfile.
        const config = await loadFixture(
            `export default {
                name: "e2e-default",
                registry: "example.io/team",
            };`,
        );
        expect(() => validateConfig(config)).not.toThrow();
        const sel = selectRuntimeImage(config, "/app");
        expect(sel.kind).toBe("standalone");
        expect(sel.target).toBe("standalone-node");
        expect(sel.dockerfile).toBe(join("/app", "Dockerfile.standalone"));
    });

    it("an explicit build='vinext' config still routes to the app Dockerfile end-to-end", async () => {
        // vinext stays selectable (ADR-0058): naming it explicitly still
        // reaches its single-stage Dockerfile, unchanged by the default flip.
        const config = await loadFixture(
            `export default {
                name: "e2e-vinext",
                registry: "example.io/team",
                build: "vinext",
            };`,
        );
        expect(() => validateConfig(config)).not.toThrow();
        const sel = selectRuntimeImage(config, "/app");
        expect(sel.kind).toBe("app-dockerfile");
        expect(sel.target).toBeUndefined();
        expect(sel.dockerfile).toBe(join("/app", "Dockerfile"));
    });

    it("a vinext+node config loads, validates, and routes to the vinext-node Dockerfile (#1260)", async () => {
        const config = await loadFixture(
            `export default {
                name: "e2e-vinext-node",
                registry: "example.io/team",
                build: "vinext",
                runtime: "node",
            };`,
        );
        expect(() => validateConfig(config)).not.toThrow();
        const sel = selectRuntimeImage(config, "/app");
        // Both halves: NOT the bun single-exec Dockerfile (its CMD is a
        // compiled binary this cell never builds), and NOT the standalone
        // recipe (there is no `.next/standalone`).
        expect(sel.kind).toBe("app-dockerfile");
        expect(sel.dockerfile).toBe(join("/app", "Dockerfile.vinext-node"));
        expect(sel.target).toBeUndefined();
    });
});
