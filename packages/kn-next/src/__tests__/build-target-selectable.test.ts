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
 * The default is DELIBERATELY UNCHANGED: vinext stays `DEFAULT_BUILDER_ID`.
 * ADR-0054 makes bun-standalone the v1.0 default, but its 778/0 is
 * verified-once, not credentialed (#1147 lane has not banked), and the compiled
 * bytecode-exec of bun-standalone (#1166) is new and not yet credentialed — so
 * the SELECTABLE target here is the bun/node-standalone. The default-flip is a
 * follow-up gated on credentialing, not this issue.
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

    it("keeps vinext as the default builder — the flip to bun-standalone is credential-gated, not this issue", () => {
        // Un-credentialed default guard: DEFAULT_BUILDER_ID must NOT flip until
        // the #1147 lane banks. If someone flips it here this reds, which is the
        // point — the default change is a separate, gated decision.
        expect(DEFAULT_BUILDER_ID).toBe("vinext");
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

    it("the default (vinext) config still routes to the app Dockerfile end-to-end", async () => {
        // The other half of reachability: activating standalone must not
        // reroute the default vinext app away from its single-stage Dockerfile.
        const config = await loadFixture(
            `export default {
                name: "e2e-vinext",
                registry: "example.io/team",
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
