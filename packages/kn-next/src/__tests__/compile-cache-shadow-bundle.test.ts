/**
 * #451 item 2 — BUILD-ARTIFACT guard: the `compile-cache-shadow-check` deferred
 * step must survive bundling into the shipped supervisor artifact.
 *
 * `node-server.ts` registers the #440 shadow diagnostic as a deferred step, but
 * nothing asserted that the registration survives the bundler. That matters
 * because the runtime the image actually runs is NOT this source file — it is
 * `dist/adapters/node-server.js`, the tsup/esbuild bundle copied into the
 * runner stage (see `apps/file-manager/sigterm-drain-e2e.test.ts`, which boots
 * exactly that file). A source-level guard cannot see a bundling regression:
 * `warnOnCompileCacheShadow` is a side-effect-free module, so the moment the
 * registration goes away the bundler TREE-SHAKES the whole diagnostic out and
 * the shipped image loses the warning silently.
 *
 * So this guard bundles the real entry with the real bundler (esbuild, which is
 * what tsup drives) using the REAL `tsup.config.ts` options, and asserts against
 * the emitted bundle. It never skips: the bundle is produced by the test itself,
 * so there is no "build not present" branch that could go green by skipping
 * (the anti-pattern #408 exists to remove).
 *
 * `esbuild` is declared in this package's OWN devDependencies (matching the
 * `^0.28.0` specifier already used in the workspace) rather than leaned on via
 * hoisting: the package-scoped `tsc --noEmit` job installs only this package's
 * declared deps, and an undeclared import fails there even when it resolves in
 * a hoisted local tree. devDependencies are not installed by consumers, so the
 * published surface is unchanged.
 *
 * Mutation-proved: deleting the step registration from `node-server.ts` turns
 * every assertion below RED.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type OutputFile } from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import tsupConfig from "../../tsup.config";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY_KEY = "adapters/node-server";

/**
 * The library-surface tsup pass (the one that ships the node-server entry),
 * reduced to the two fields this guard mirrors. Read from the REAL config so a
 * change to the shipped entry map or externals is reflected here rather than
 * drifting silently.
 */
interface TsupPass {
    entry?: unknown;
    external?: unknown;
}

// tsup's exported type allows a pass to be a FUNCTION as well as an options
// object, so widen through `unknown` and narrow back rather than asserting a
// shape the type does not guarantee.
const passes: TsupPass[] = (
    Array.isArray(tsupConfig) ? tsupConfig : [tsupConfig]
).map((opts) => (typeof opts === "object" && opts !== null ? opts : {}));

const libraryPass = passes.find((opts) => {
    const entry = opts.entry;
    return (
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        ENTRY_KEY in (entry as Record<string, unknown>)
    );
});

let bundle = "";

beforeAll(async () => {
    // The published artifact is only meaningful if the entry is still declared.
    expect(
        libraryPass,
        `tsup.config.ts no longer ships ${ENTRY_KEY}`,
    ).toBeDefined();
    const entry = libraryPass?.entry as Record<string, string>;
    const result = await build({
        absWorkingDir: PKG_ROOT,
        entryPoints: [resolve(PKG_ROOT, entry[ENTRY_KEY])],
        bundle: true,
        write: false,
        format: "esm",
        platform: "node",
        target: "node20",
        // Same externals as the shipped build — they resolve from the published
        // package's own dependencies at install time.
        external: (libraryPass?.external as string[]) ?? [],
    });
    bundle = result.outputFiles.map((file: OutputFile) => file.text).join("\n");
    expect(bundle.length).toBeGreaterThan(0);
}, 60_000);

describe("#451 shipped supervisor bundle: compile-cache-shadow-check stays wired", () => {
    it("registers the step in the deferred-init step list", () => {
        expect(bundle).toMatch(/name:\s*"compile-cache-shadow-check"/);
        const factoryAt = bundle.indexOf("createDeferredSupervisorInit");
        const stepAt = bundle.search(/name:\s*"compile-cache-shadow-check"/);
        const metricsAt = bundle.search(/name:\s*"metrics-collector"/);
        expect(factoryAt).toBeGreaterThan(-1);
        expect(metricsAt).toBeGreaterThan(-1);
        // The step sits inside the SAME steps array as the metrics step, after
        // the factory call — i.e. it is registered, not merely mentioned.
        expect(stepAt).toBeGreaterThan(factoryAt);
        expect(stepAt).toBeLessThan(metricsAt);
    });

    it("keeps the diagnostic's call site in the bundle", () => {
        expect(bundle).toContain("warnOnCompileCacheShadow(");
        expect(bundle).toContain("bakedDefaultPath");
    });

    it("keeps the shadow module BODY in the bundle (not tree-shaken away)", () => {
        // The warning text and the fail-open detection helpers only survive
        // bundling if something reachable actually calls them. This is the
        // assertion that a dropped registration cannot fake.
        expect(bundle).toContain("shadows the image-baked compile cache");
        expect(bundle).toContain("isCompileCacheShadowed");
        // #451 item 1: the realpath canonicalisation ships too.
        expect(bundle).toContain("realpathSync");
    });
});
