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
 * `tsup` (reached via the `../../tsup.config` import below) is deliberately NOT
 * declared here, and the distinction is real rather than convenient: tsup is a
 * WORKSPACE-ROOT devDependency, so pnpm links it into the root `node_modules`
 * and every upward resolution — tsc's included — finds it. esbuild was only a
 * transitive of vite, present in the virtual store and reachable by chance,
 * which is exactly why the package-scoped typecheck failed on it and not on
 * tsup. If the package's own `"build": "tsup"` script is ever made
 * self-contained, declare it there and this import comes along for free.
 *
 * SCOPE — read this before quoting the guard. What is proved is that the step
 * SURVIVES BUNDLING and that the deferred init is INVOKED at all. What is NOT
 * proved is that the warning reaches a real container's stderr; that needs the
 * runtime e2e lane, not a static bundle read.
 *
 * Mutation-proved: deleting the step registration from `node-server.ts` turns
 * the registration/run-callback/tree-shake assertions RED; no-oping the `run`
 * callback turns two of them RED; removing the `ensureStarted` invocations
 * turns the last one RED. Swapping the two deferred step objects — semantically
 * inert — deliberately stays GREEN.
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
    format?: unknown;
    platform?: unknown;
    target?: unknown;
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

/**
 * Every tsup option this guard MODELS. If the shipped build grows a key that is
 * not in here — `minify`, `esbuildOptions`, `plugins`, `splitting` — the bundle
 * this test inspects stops being the bundle the project ships (a `minify: true`
 * would mangle `warnOnCompileCacheShadow` in the artifact while every string
 * assertion below stayed green on a fiction). Breaking loudly is the point:
 * model the new key here, then re-check the assertions still mean something.
 */
const MODELLED_TSUP_KEYS = new Set([
    "entry",
    "dts",
    "format",
    "platform",
    "target",
    "outDir",
    "clean",
    "sourcemap",
    "external",
]);

/**
 * Extract the `[...]` that follows `steps:`, by balanced-bracket scan.
 *
 * The scan is bracket-counting, NOT a parser, so it is worth stating both
 * failure directions rather than pretending it is exact:
 *  - an unmatched `]` inside a string literal truncates the slice early — the
 *    assertions then fail loudly, which is the safe direction;
 *  - an unmatched `[` inside a string literal means the depth never returns to
 *    zero at the real end, the scan closes on a LATER `]`, and the slice
 *    silently WIDENS — degrading "both names live in the same array" toward
 *    "somewhere in the file".
 *
 * The second direction is the dangerous one, so it is bounded rather than
 * assumed away: a slice that is implausibly large for a step list, or a bundle
 * carrying more than one `steps:` array (which would make "the" array
 * ambiguous), fails the caller instead of quietly widening. Today there is
 * exactly one match and the slice is ~1.2 KB.
 */
const MAX_PLAUSIBLE_STEPS_BYTES = 8_000;

function stepsArraySlice(source: string): string {
    const matches = [...source.matchAll(/steps:\s*\[/g)];
    // More than one candidate makes "the steps array" ambiguous — refuse
    // rather than pick the first and assert against a guess.
    if (matches.length !== 1) return "";
    const open = source.indexOf("[", matches[0].index);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        if (ch === "[") depth++;
        else if (ch === "]") {
            depth--;
            if (depth === 0) {
                const slice = source.slice(open, i + 1);
                // Bound the silent-widening direction described above.
                return slice.length > MAX_PLAUSIBLE_STEPS_BYTES ? "" : slice;
            }
        }
    }
    return "";
}

/**
 * The body of ONE step object, taken from its `name:` to the next step's
 * `name:` (or the end of the array). Deliberately order-independent: the two
 * deferred steps carry no ordering contract, so swapping them is inert and must
 * NOT turn this guard red.
 */
function stepBody(steps: string, stepName: string): string {
    const at = steps.indexOf(`name: "${stepName}"`);
    if (at === -1) return "";
    const next = steps.indexOf('name: "', at + 1);
    return next === -1 ? steps.slice(at) : steps.slice(at, next);
}

let bundle = "";
let steps = "";

beforeAll(async () => {
    // The published artifact is only meaningful if the entry is still declared.
    expect(
        libraryPass,
        `tsup.config.ts no longer ships ${ENTRY_KEY}`,
    ).toBeDefined();
    if (libraryPass === undefined) {
        throw new Error(`tsup.config.ts no longer ships ${ENTRY_KEY}`);
    }
    const pass = libraryPass;

    // FAIL on an unmodelled build option rather than silently asserting about
    // an artifact the project does not ship.
    const unmodelled = Object.keys(pass).filter(
        (key) => !MODELLED_TSUP_KEYS.has(key),
    );
    expect(
        unmodelled,
        `tsup.config.ts grew build option(s) this guard does not model: ${unmodelled.join(", ")}. ` +
            "Model them here (and re-check the string assertions still hold) before shipping.",
    ).toEqual([]);

    const entry = pass.entry;
    if (typeof entry !== "object" || entry === null) {
        throw new Error("tsup entry is not an object map");
    }
    const entryPath: unknown = (entry as Record<string, unknown>)[ENTRY_KEY];
    if (typeof entryPath !== "string") {
        throw new Error(`tsup entry ${ENTRY_KEY} is not a path string`);
    }

    // format/platform/target come from the REAL config too (finding 3) — a
    // change there must move this bundle, not leave it asserting on literals.
    // Narrowed at runtime rather than cast: an unchecked cast here would let a
    // config change through as a silent `undefined` esbuild option.
    const format = Array.isArray(pass.format) ? pass.format[0] : pass.format;
    const { platform, target, external } = pass;
    if (format !== "esm" && format !== "cjs" && format !== "iife") {
        throw new Error(`unmodelled tsup format: ${String(format)}`);
    }
    if (
        platform !== "node" &&
        platform !== "browser" &&
        platform !== "neutral"
    ) {
        throw new Error(`unmodelled tsup platform: ${String(platform)}`);
    }
    if (typeof target !== "string") {
        throw new Error(`unmodelled tsup target shape: ${String(target)}`);
    }
    if (
        !Array.isArray(external) ||
        external.some((e) => typeof e !== "string")
    ) {
        throw new Error("tsup externals are no longer a string array");
    }

    const result = await build({
        absWorkingDir: PKG_ROOT,
        entryPoints: [resolve(PKG_ROOT, entryPath)],
        bundle: true,
        write: false,
        format,
        platform,
        target,
        // Same externals as the shipped build — they resolve from the published
        // package's own dependencies at install time.
        external: external.map(String),
    });
    bundle = result.outputFiles.map((file: OutputFile) => file.text).join("\n");
    expect(bundle.length).toBeGreaterThan(0);
    steps = stepsArraySlice(bundle);
}, 60_000);

describe("#451 shipped supervisor bundle: compile-cache-shadow-check survives bundling", () => {
    it("registers the step in the deferred-init steps array", () => {
        expect(steps, "no `steps: [...]` array found in the bundle").not.toBe(
            "",
        );
        // Both steps live in the SAME array — registered, not merely mentioned
        // somewhere in the file. Deliberately NOT an ordering assertion: the
        // two steps carry no ordering contract, so swapping them is inert.
        expect(steps).toContain('name: "compile-cache-shadow-check"');
        expect(steps).toContain('name: "metrics-collector"');
    });

    it("wires the step's own run callback to the diagnostic", () => {
        const body = stepBody(steps, "compile-cache-shadow-check");
        expect(body, "shadow step not found in the steps array").not.toBe("");
        expect(body).toContain("run:");
        expect(body).toContain("warnOnCompileCacheShadow(");
        expect(body).toContain("bakedDefaultPath");
    });

    it("keeps the shadow module BODY in the bundle (not tree-shaken away)", () => {
        // The warning text and the detection helpers only survive bundling if
        // something reachable actually calls them. This is the assertion that a
        // dropped registration cannot fake.
        expect(bundle).toContain("shadows the image-baked compile cache");
        expect(bundle).toContain("isCompileCacheShadowed");
        // #451 item 1 ships too: BOTH sameness mechanisms.
        expect(bundle).toContain("realpathSync");
        expect(bundle).toContain("isSameDirectory");
    });

    it("actually INVOKES the deferred init (registration alone is not enough)", () => {
        // Finding 4: keeping the step registered while never calling
        // `ensureStarted` silences the warning in production just as
        // effectively as deleting it, and left the other assertions green.
        // Resolve the identifier the factory result is bound to, then require
        // real call sites on it — rename-proof, not a hardcoded name.
        const bound =
            /(?:var|let|const)\s+(\w+)\s*=\s*createDeferredSupervisorInit\s*\(/.exec(
                bundle,
            );
        expect(
            bound,
            "no binding of createDeferredSupervisorInit(...) in the bundle",
        ).not.toBeNull();
        const receiver = (bound as RegExpExecArray)[1];
        const calls = [
            ...bundle.matchAll(
                new RegExp(`\\b${receiver}\\.ensureStarted\\(`, "g"),
            ),
        ];

        // EACH of the three call sites is required BY NAME, not a count of two.
        // The round-2 review deleted only the readiness path — the one that
        // fires on every normal boot with deferral enabled (the default) —
        // leaving the probe-error catch and the deferral-disabled else, and a
        // `>= 2` assertion stayed green while the deferred steps never ran on a
        // healthy boot. The reason (`child-${outcome}`) is a template literal in
        // the source, so match its prefix rather than a whole string.
        const requiredCallSites: Array<{ reason: string; why: string }> = [
            {
                reason: "`child-",
                why: "the child-readiness path — the ONLY one that fires on a normal, healthy boot with deferral enabled (the default)",
            },
            {
                reason: '"probe-error"',
                why: "the readiness-probe failure fallback",
            },
            {
                reason: '"deferral-disabled"',
                why: "the operator opt-out path (pre-#441 behaviour)",
            },
        ];
        for (const { reason, why } of requiredCallSites) {
            expect(
                bundle.includes(`${receiver}.ensureStarted(${reason}`),
                `missing ${receiver}.ensureStarted(${reason}…) — ${why}`,
            ).toBe(true);
        }
        expect(calls.length).toBeGreaterThanOrEqual(requiredCallSites.length);
    });
});
