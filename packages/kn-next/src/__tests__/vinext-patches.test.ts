/**
 * Bundled vinext fixes — the applier, the per-fix behaviour, and the guard
 * that a vinext bump cannot silently leave the patches stale.
 *
 * knext ships ports of open upstream vinext fixes as unified-diff patches
 * against the PUBLISHED vinext dist (templates/vinext-patches/). They are
 * applied by `knext vinext-patches`, which a scaffolded app runs from its
 * postinstall, and which `knext build` re-runs before the vinext build.
 *
 * The guard half (`manifest lockstep`) is what stops a stale patch from
 * quietly not applying: the manifest names the ONE vinext version the patches
 * were validated against plus the sha256 of every target file in that
 * tarball, and this file fails if the pinned/installed vinext disagrees with
 * either, or if any patch no longer applies cleanly to the installed copy.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    cpSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { COMMAND_GROUPS } from "../cli/help";
import { runProjectBuild } from "../cli/project-build";
import {
    applyFilePatchToText,
    applyVinextPatches,
    describeEnsureResult,
    ensureVinextPatches,
    findVinextDir,
    loadVinextPatchManifest,
    parseUnifiedPatch,
    VinextPatchConflictError,
    VinextPatchRollbackError,
    VinextPatchWriteError,
    vinextPatchesDir,
    vinextPatchesMain,
} from "../cli/vinext-patches";

const PKG_ROOT = join(import.meta.dir, "..", "..");
const PATCHES_DIR = join(PKG_ROOT, "templates", "vinext-patches");
const manifest = loadVinextPatchManifest(PATCHES_DIR);

/** The vinext the repo actually installed (a pristine, unpatched copy). */
const INSTALLED_VINEXT = (() => {
    const dir = findVinextDir(PKG_ROOT);
    if (!dir) throw new Error("vinext is not installed for @getknext/core");
    return realpathSync(dir);
})();

const sha256 = (path: string) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");

// ---------------------------------------------------------------------------
// The applier, on synthetic input.
// ---------------------------------------------------------------------------

const SIMPLE_PATCH = `header text, ignored
--- a/dist/x.js
+++ b/dist/x.js
@@ -2,3 +2,4 @@
 two
 three
+inserted
 four
`;

describe("applier", () => {
    it("parses the header away and keeps the hunks", () => {
        const files = parseUnifiedPatch(SIMPLE_PATCH);
        expect(files).toHaveLength(1);
        expect(files[0]?.path).toBe("dist/x.js");
        expect(files[0]?.hunks[0]?.oldLines).toEqual(["two", "three", "four"]);
        expect(files[0]?.hunks[0]?.newLines).toEqual([
            "two",
            "three",
            "inserted",
            "four",
        ]);
    });

    it("applies a hunk by its context, not its line number", () => {
        const [fp] = parseUnifiedPatch(SIMPLE_PATCH);
        if (!fp) throw new Error("no file patch");
        const out = applyFilePatchToText("zero\none\ntwo\nthree\nfour\n", fp);
        expect(out.status).toBe("patch");
        expect(out.text).toBe("zero\none\ntwo\nthree\ninserted\nfour\n");
    });

    it("recognises an already-applied patch and leaves the text alone", () => {
        const [fp] = parseUnifiedPatch(SIMPLE_PATCH);
        if (!fp) throw new Error("no file patch");
        const text = "one\ntwo\nthree\ninserted\nfour\n";
        const out = applyFilePatchToText(text, fp);
        expect(out.status).toBe("present");
        expect(out.text).toBe(text);
    });

    it("refuses when the context is missing (a stale patch never half-applies)", () => {
        const [fp] = parseUnifiedPatch(SIMPLE_PATCH);
        if (!fp) throw new Error("no file patch");
        expect(() =>
            applyFilePatchToText("one\ntwo\nTHREE\nfour\n", fp),
        ).toThrow(VinextPatchConflictError);
    });

    it("refuses when the context is ambiguous", () => {
        const [fp] = parseUnifiedPatch(SIMPLE_PATCH);
        if (!fp) throw new Error("no file patch");
        expect(() =>
            applyFilePatchToText("two\nthree\nfour\ntwo\nthree\nfour\n", fp),
        ).toThrow(VinextPatchConflictError);
    });

    it("refuses a half-applied or partly-stale multi-hunk patch", () => {
        const [fp] = parseUnifiedPatch(
            "--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n+A\n b\n@@ -5,2 +6,3 @@\n x\n+X\n y\n",
        );
        if (!fp) throw new Error("no file patch");
        expect(applyFilePatchToText("a\nb\nc\nd\nx\ny\n", fp).status).toBe(
            "patch",
        );
        // First hunk already in, second not: never "finish" it silently.
        expect(() => applyFilePatchToText("a\nA\nb\nc\nd\nx\ny\n", fp)).toThrow(
            VinextPatchConflictError,
        );
        // First hunk applies, second's context is gone.
        expect(() => applyFilePatchToText("a\nb\nc\nd\nx\nY\n", fp)).toThrow(
            VinextPatchConflictError,
        );
        // First hunk applies, second's context is ambiguous: never guess.
        expect(() =>
            applyFilePatchToText("a\nb\nc\nx\ny\nd\nx\ny\n", fp),
        ).toThrow(VinextPatchConflictError);
    });

    it("rejects a malformed patch file instead of guessing", () => {
        expect(() => parseUnifiedPatch("--- a/f\nnot-plus\n")).toThrow(
            "malformed patch",
        );
        expect(() =>
            parseUnifiedPatch("--- a/f\n+++ b/f\n@@ bogus @@\n"),
        ).toThrow("malformed hunk header");
        expect(() =>
            parseUnifiedPatch("--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a"),
        ).toThrow("truncated hunk");
        expect(() =>
            parseUnifiedPatch("--- a/f\n+++ b/f\n@@ -1 +1 @@\n?x\n"),
        ).toThrow("unexpected line in hunk");
        // A missing target file is a conflict, never a silent create.
        const [fp] = parseUnifiedPatch(SIMPLE_PATCH);
        if (!fp) throw new Error("no file patch");
        expect(() => applyFilePatchToText(null, fp)).toThrow(
            VinextPatchConflictError,
        );
    });

    it("creates a new file from a /dev/null patch, and accepts it once present", () => {
        const [fp] = parseUnifiedPatch(
            "--- /dev/null\n+++ b/dist/new.js\n@@ -0,0 +1,2 @@\n+a\n+b\n",
        );
        if (!fp) throw new Error("no file patch");
        expect(fp.path).toBe("dist/new.js");
        expect(applyFilePatchToText(null, fp)).toEqual({
            status: "patch",
            text: "a\nb\n",
        });
        expect(applyFilePatchToText("a\nb\n", fp).status).toBe("present");
        expect(() => applyFilePatchToText("other\n", fp)).toThrow(
            VinextPatchConflictError,
        );
    });

    it("replaces the file instead of writing through a hardlink (bun's global cache is hardlinked on Linux)", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-vp-hardlink-"));
        try {
            const pkg = join(dir, "vinext");
            mkdirSync(join(pkg, "dist"), { recursive: true });
            const cache = join(dir, "cache-x.js");
            writeFileSync(cache, "one\ntwo\nthree\nfour\n");
            linkSync(cache, join(pkg, "dist", "x.js"));
            const patches = join(dir, "patches");
            mkdirSync(patches);
            writeFileSync(join(patches, "p.patch"), SIMPLE_PATCH);
            writeFileSync(
                join(patches, "manifest.json"),
                JSON.stringify({
                    vinext: "9.9.9",
                    patches: [{ file: "p.patch", upstream: "u", summary: "s" }],
                    pristine: {},
                }),
            );
            const results = applyVinextPatches(pkg, { patchesDir: patches });
            expect(results.map((r) => r.status)).toEqual(["applied"]);
            expect(readFileSync(join(pkg, "dist", "x.js"), "utf8")).toContain(
                "inserted",
            );
            // The shared cache copy is untouched.
            expect(readFileSync(cache, "utf8")).toBe("one\ntwo\nthree\nfour\n");
            // Second run: idempotent.
            expect(
                applyVinextPatches(pkg, { patchesDir: patches }).map(
                    (r) => r.status,
                ),
            ).toEqual(["already-applied"]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ---------------------------------------------------------------------------
// Guard: the manifest, the pins, and the installed tarball move together.
// ---------------------------------------------------------------------------

describe("manifest lockstep (a vinext bump must re-validate the patches)", () => {
    it("is the directory the CLI reads", () => {
        expect(realpathSync(vinextPatchesDir())).toBe(
            realpathSync(PATCHES_DIR),
        );
    });

    it("names the same vinext as the scaffold template pin", () => {
        const tpl = readFileSync(
            join(PKG_ROOT, "templates", "app", "package.json.vinext.hbs"),
            "utf8",
        );
        const pin = /"vinext":\s*"([^"]+)"/.exec(tpl)?.[1];
        expect(pin).toBe(manifest.vinext);
    });

    it("names the same vinext as @getknext/core's own pin and install", () => {
        const pkg = JSON.parse(
            readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
        ) as { devDependencies: Record<string, string> };
        expect(pkg.devDependencies.vinext).toBe(manifest.vinext);
        const installed = JSON.parse(
            readFileSync(join(INSTALLED_VINEXT, "package.json"), "utf8"),
        ) as { version: string };
        expect(installed.version).toBe(manifest.vinext);
    });

    it("records the pristine sha256 of every file a patch touches", () => {
        const touched = new Set<string>();
        for (const entry of manifest.patches) {
            for (const fp of parseUnifiedPatch(
                readFileSync(join(PATCHES_DIR, entry.file), "utf8"),
            )) {
                if (!fp.isNew) touched.add(fp.path);
            }
        }
        expect([...touched].sort()).toEqual(
            Object.keys(manifest.pristine).sort(),
        );
        for (const [rel, hash] of Object.entries(manifest.pristine)) {
            expect(`${rel}:${sha256(join(INSTALLED_VINEXT, rel))}`).toBe(
                `${rel}:${hash}`,
            );
        }
    });

    it("lists exactly the patch files on disk, each with an upstream link and a retirement condition", () => {
        const onDisk = readdirSync(PATCHES_DIR)
            .filter((f) => f.endsWith(".patch"))
            .sort();
        expect(manifest.patches.map((p) => p.file).sort()).toEqual(onDisk);
        expect(onDisk.length).toBeGreaterThan(0);
        for (const entry of manifest.patches) {
            const num = /^vinext-(\d+)-/.exec(entry.file)?.[1];
            expect(num).toBeDefined();
            const text = readFileSync(join(PATCHES_DIR, entry.file), "utf8");
            const header = text.slice(0, text.indexOf("\n--- "));
            expect(header).toContain(
                `https://github.com/cloudflare/vinext/pull/${num}`,
            );
            expect(header).toContain(`includes cloudflare/vinext#${num}`);
            expect(entry.upstream).toBe(
                `https://github.com/cloudflare/vinext/pull/${num}`,
            );
            expect(text.includes("\0")).toBe(false);
        }
    });
});

// ---------------------------------------------------------------------------
// The real patches, applied to a copy of the installed vinext. The copy is a
// SIBLING of the installed package so its bare imports (vite, magic-string,
// ...) resolve exactly as the real package's do.
// ---------------------------------------------------------------------------

let patched = "";

beforeAll(() => {
    patched = join(
        dirname(INSTALLED_VINEXT),
        `.knext-vinext-patch-test-${process.pid}`,
    );
    rmSync(patched, { recursive: true, force: true });
    cpSync(INSTALLED_VINEXT, patched, { recursive: true });
});

afterAll(() => {
    if (patched) rmSync(patched, { recursive: true, force: true });
});

async function importPatched<T>(rel: string): Promise<T> {
    return (await import(pathToFileURL(join(patched, rel)).href)) as T;
}

describe("the bundled patches against the published tarball", () => {
    it("every patch applies cleanly to the installed vinext, then is idempotent", () => {
        const first = applyVinextPatches(patched);
        expect(first.map((r) => `${r.file}:${r.status}`)).toEqual(
            manifest.patches.map((p) => `${p.file}:applied`),
        );
        const second = applyVinextPatches(patched);
        expect(second.map((r) => r.status)).toEqual(
            manifest.patches.map(() => "already-applied"),
        );
    });

    it("the installed (pristine) copy is NOT already patched — each fix is real work", () => {
        const results = applyVinextPatches(INSTALLED_VINEXT, { check: true });
        expect(results.map((r) => r.status)).toEqual(
            manifest.patches.map(() => "applied"),
        );
        // check mode writes nothing.
        for (const [rel, hash] of Object.entries(manifest.pristine)) {
            expect(sha256(join(INSTALLED_VINEXT, rel))).toBe(hash);
        }
    });

    it("vinext#3241: worker bundles get NEXT_DEPLOYMENT_ID inlined", async () => {
        applyVinextPatches(patched);
        const mod = await importPatched<{
            createWorkerDeploymentIdDefinePlugin?: (o: {
                deploymentId?: string;
            }) => {
                transform: {
                    handler: (
                        code: string,
                        id: string,
                    ) => { code: string } | null;
                };
            };
        }>("dist/plugins/worker-image-imports.js");
        expect(typeof mod.createWorkerDeploymentIdDefinePlugin).toBe(
            "function",
        );
        const plugin = mod.createWorkerDeploymentIdDefinePlugin?.({
            deploymentId: "dep-123",
        });
        const out = plugin?.transform.handler(
            "self.postMessage(process.env.NEXT_DEPLOYMENT_ID);",
            "/app/w.ts",
        );
        expect(out?.code).toBe('self.postMessage("dep-123");');
        const unset = mod
            .createWorkerDeploymentIdDefinePlugin?.({})
            .transform.handler(
                "self.postMessage(process.env.NEXT_DEPLOYMENT_ID);",
                "/app/w.ts",
            );
        expect(unset?.code).toBe("self.postMessage(false);");
        const index = readFileSync(join(patched, "dist", "index.js"), "utf8");
        expect(index).toContain(
            "createWorkerDeploymentIdDefinePlugin({ deploymentId: nextConfig.deploymentId })",
        );
    });

    it("vinext#3423: the require-condition resolvers are created with noExternal", async () => {
        applyVinextPatches(patched);
        const mod = await importPatched<{
            createRequireConditionResolutionPlugin: (
                createResolver: (
                    c: unknown,
                    o: Record<string, unknown>,
                ) => unknown,
                ...rest: unknown[]
            ) => { configResolved: (c: unknown) => void };
        }>("dist/plugins/require-condition-resolution.js");
        const seen: Record<string, unknown>[] = [];
        const plugin = mod.createRequireConditionResolutionPlugin(
            (_c, o) => {
                seen.push(o);
                return async () => undefined;
            },
            () => undefined,
        );
        plugin.configResolved({});
        expect(seen).toEqual([
            { isRequire: false, noExternal: true },
            { isRequire: true, noExternal: true },
        ]);
    });

    it("vinext#3436: next.config outputFileTracing* reach the resolved config, and the hook edits Nitro's trace", async () => {
        applyVinextPatches(patched);
        const cfg = await importPatched<{
            resolveNextConfig: (
                c: Record<string, unknown>,
                root?: string,
            ) => Promise<Record<string, unknown>>;
        }>("dist/config/next-config.js");
        const resolved = await cfg.resolveNextConfig(
            {
                outputFileTracingIncludes: {
                    "/*": ["node_modules/a/**"],
                    "/x": ["node_modules/a/**", "node_modules/b/x.txt"],
                },
                outputFileTracingExcludes: { "/*": ["node_modules/c/**"] },
            },
            tmpdir(),
        );
        expect(resolved.outputFileTracingIncludes).toEqual([
            "node_modules/a/**",
            "node_modules/b/x.txt",
        ]);
        expect(resolved.outputFileTracingExcludes).toEqual([
            "node_modules/c/**",
        ]);

        const traceRoot = mkdtempSync(join(tmpdir(), "knext-vp-trace-"));
        const app = realpathSync(traceRoot);
        try {
            const lib = join(app, "node_modules", "lib-a");
            mkdirSync(join(lib, "data"), { recursive: true });
            writeFileSync(
                join(lib, "package.json"),
                JSON.stringify({ name: "lib-a", version: "1.2.3" }),
            );
            writeFileSync(join(lib, "data", "keep.txt"), "k");
            writeFileSync(join(lib, "data", "drop.txt"), "d");
            const { createNitroTraceIncludesHook } = await importPatched<{
                createNitroTraceIncludesHook: (
                    root: string,
                    inc: string[],
                    exc: string[],
                ) =>
                    | ((
                          t: Record<
                              string,
                              {
                                  name: string;
                                  versions: Record<string, { files: string[] }>;
                              }
                          >,
                      ) => void)
                    | null;
            }>("dist/build/nitro-trace-includes.js");
            expect(createNitroTraceIncludesHook(app, [], [])).toBeNull();
            const hook = createNitroTraceIncludesHook(
                app,
                ["node_modules/lib-a/data/*.txt"],
                ["node_modules/lib-a/data/drop.txt"],
            );
            const traced: Record<
                string,
                { name: string; versions: Record<string, { files: string[] }> }
            > = {};
            hook?.(traced);
            expect(traced["lib-a"]?.versions["1.2.3"]?.files.sort()).toEqual([
                join(lib, "data", "keep.txt"),
            ]);
        } finally {
            rmSync(traceRoot, { recursive: true, force: true });
        }
    });

    it("vinext#3424 / #3226 / #3472: the ported hunks are present in the patched dist", () => {
        applyVinextPatches(patched);
        const index = readFileSync(join(patched, "dist", "index.js"), "utf8");
        // #3424 — the RSC environment fully bundles under Nitro.
        expect(index).toContain(
            "...hasNitroPlugin && !hasCloudflarePlugin && userSsrExternal !== true ? { resolve: { noExternal: true } } : nitroDevEnvironmentResolve,",
        );
        // #3226 — the nitro environment keeps Vite's default extensions.
        expect(index).toContain(
            'hasNitroPlugin && name === "nitro" ? null : nextConfig.serverResolveExtensions',
        );
        // #3472 — data requests carry the pre-normalization URL.
        const stage = readFileSync(
            join(patched, "dist", "server", "pages-request-stage-entry.js"),
            "utf8",
        );
        expect(stage).toContain(
            "const originalRenderUrl = pathname + new URL(request.url).search;",
        );
        expect(stage).toContain("originalUrl: originalRenderUrl");
    });
});

// ---------------------------------------------------------------------------
// Delivery: the scaffold's postinstall, `knext build`, and the CLI verb.
// ---------------------------------------------------------------------------

/** A throwaway app whose node_modules/vinext is a pristine copy of the tarball's target files. */
function fakeApp(version: string): string {
    const app = mkdtempSync(join(tmpdir(), "knext-vp-app-"));
    writeFileSync(
        join(app, "package.json"),
        JSON.stringify({ name: "a", type: "module" }),
    );
    const vinext = join(app, "node_modules", "vinext");
    mkdirSync(vinext, { recursive: true });
    writeFileSync(
        join(vinext, "package.json"),
        JSON.stringify({ name: "vinext", version }),
    );
    for (const rel of Object.keys(manifest.pristine)) {
        mkdirSync(dirname(join(vinext, rel)), { recursive: true });
        cpSync(join(INSTALLED_VINEXT, rel), join(vinext, rel));
    }
    return app;
}

describe("delivery", () => {
    it("the vinext scaffold runs the applier from postinstall", () => {
        const tpl = JSON.parse(
            readFileSync(
                join(PKG_ROOT, "templates", "app", "package.json.vinext.hbs"),
                "utf8",
            ).replace(/\{\{[^}]+\}\}/g, "x"),
        ) as { scripts: Record<string, string> };
        expect(tpl.scripts.postinstall).toMatch(/^node -e "[^"]+"$/);
        expect(tpl.scripts.postinstall).toContain("'vinext-patches'");
    });

    /** Run the scaffold's real postinstall guard script in `cwd`. */
    function runPostinstall(cwd: string) {
        const tpl = JSON.parse(
            readFileSync(
                join(PKG_ROOT, "templates", "app", "package.json.vinext.hbs"),
                "utf8",
            ).replace(/\{\{[^}]+\}\}/g, "x"),
        ) as { scripts: Record<string, string> };
        const script = /^node -e "([^"]+)"$/.exec(
            tpl.scripts.postinstall ?? "",
        )?.[1];
        if (!script) throw new Error("postinstall is not a node -e guard");
        return spawnSync("node", ["-e", script], { cwd, encoding: "utf8" });
    }

    /** An app whose node_modules/@getknext/core CLI just exits with `code`. */
    function appWithFakeCore(code: number): string {
        const app = mkdtempSync(join(tmpdir(), "knext-vp-postinstall-"));
        const cli = join(
            app,
            "node_modules",
            "@getknext",
            "core",
            "dist",
            "cli",
        );
        mkdirSync(cli, { recursive: true });
        writeFileSync(
            join(cli, "kn-next.js"),
            `process.stdout.write("argv:" + process.argv.slice(2).join(" ")); process.exit(${code});`,
        );
        return app;
    }

    it("postinstall is a silent no-op when @getknext/core is absent (production install)", () => {
        const app = mkdtempSync(join(tmpdir(), "knext-vp-prodinstall-"));
        try {
            const r = runPostinstall(app);
            expect(r.status).toBe(0);
            expect(r.stdout).toContain("bundled vinext fixes were skipped");
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("postinstall runs `knext vinext-patches` and propagates a real failure", () => {
        const app = appWithFakeCore(3);
        try {
            const r = runPostinstall(app);
            expect(r.stdout).toBe("argv:vinext-patches");
            expect(r.status).toBe(3);
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("postinstall finds a hoisted @getknext/core above the app and passes success through", () => {
        const app = appWithFakeCore(0);
        try {
            const nested = join(app, "apps", "web");
            mkdirSync(nested, { recursive: true });
            const r = runPostinstall(nested);
            expect(r.stdout).toBe("argv:vinext-patches");
            expect(r.status).toBe(0);
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("KNEXT_VINEXT_PATCHES=0 skips the fixes in postinstall AND in `knext build`, and says so", () => {
        const app = fakeApp(manifest.vinext);
        const before = process.env.KNEXT_VINEXT_PATCHES;
        try {
            const off = ensureVinextPatches(app, {
                env: { KNEXT_VINEXT_PATCHES: "0" },
            });
            expect(off.kind).toBe("disabled");
            expect(describeEnsureResult(off)[0]).toContain(
                "KNEXT_VINEXT_PATCHES=0 is set",
            );
            process.env.KNEXT_VINEXT_PATCHES = "0";
            runProjectBuild({ requireEsm: true, cwd: app, run: () => {} });
            for (const [rel, hash] of Object.entries(manifest.pristine)) {
                expect(sha256(join(app, "node_modules", "vinext", rel))).toBe(
                    hash,
                );
            }
            // Any other value leaves them on.
            expect(
                ensureVinextPatches(app, { env: { KNEXT_VINEXT_PATCHES: "1" } })
                    .kind,
            ).toBe("patched");
        } finally {
            if (before === undefined) delete process.env.KNEXT_VINEXT_PATCHES;
            else process.env.KNEXT_VINEXT_PATCHES = before;
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("a failed install of a multi-file patch rolls back: no file is half-patched, no temp left", () => {
        const app = fakeApp(manifest.vinext);
        try {
            const vinext = join(app, "node_modules", "vinext");
            const snapshot = () =>
                Object.keys(manifest.pristine).map((rel) =>
                    sha256(join(vinext, rel)),
                );
            const pristine = snapshot();
            // vinext-3436 touches three files (one new); fail its 3rd rename.
            let renames = 0;
            const fs = {
                writeFile: (path: string, text: string) => {
                    mkdirSync(dirname(path), { recursive: true });
                    writeFileSync(path, text);
                },
                rename: (from: string, to: string) => {
                    if (
                        to.endsWith("index.js") &&
                        from.includes("knext-patch")
                    ) {
                        renames++;
                        // index.js is renamed by 3226/3424/3241 first; fail 3436's.
                        if (renames === 4) throw new Error("EIO: simulated");
                    }
                    renameSync(from, to);
                },
                remove: (path: string) => rmSync(path, { force: true }),
            };
            let thrown: unknown;
            try {
                applyVinextPatches(vinext, { fs });
            } catch (err) {
                thrown = err;
            }
            expect(thrown).toBeInstanceOf(VinextPatchWriteError);
            expect(String((thrown as Error).message)).toContain(
                "vinext-3436-nitro-output-file-tracing.patch",
            );
            expect(String((thrown as Error).message)).toContain(
                "KNEXT_VINEXT_PATCHES=0",
            );
            // 3436's files are exactly as the earlier patches left them.
            expect(
                existsSync(
                    join(vinext, "dist", "build", "nitro-trace-includes.js"),
                ),
            ).toBe(false);
            expect(
                readFileSync(
                    join(vinext, "dist", "config", "next-config.js"),
                    "utf8",
                ),
            ).not.toContain(
                "outputFileTracingIncludes: readOutputFileTracingGlobs",
            );
            expect(
                readFileSync(join(vinext, "dist", "index.js"), "utf8"),
            ).not.toContain("createNitroTraceIncludesHook");
            const leftovers = readdirSync(vinext, { recursive: true }).filter(
                (f) => String(f).includes(".knext-patch-"),
            );
            expect(leftovers).toEqual([]);
            // A re-run on the real filesystem then completes everything.
            expect(
                applyVinextPatches(vinext)
                    .map((r) => r.status)
                    .includes("applied"),
            ).toBe(true);
            expect(snapshot()).not.toEqual(pristine);
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("a double fault (install AND restore fail) never claims a rollback, and names the files", () => {
        const app = fakeApp(manifest.vinext);
        try {
            const vinext = join(app, "node_modules", "vinext");
            let indexRenames = 0;
            let restoring = false;
            const fs = {
                writeFile: (path: string, text: string) => {
                    // Fail the restore of next-config.js (written after the forward failure).
                    if (restoring && path.includes("next-config.js")) {
                        throw new Error("EIO: restore failed");
                    }
                    mkdirSync(dirname(path), { recursive: true });
                    writeFileSync(path, text);
                },
                rename: (from: string, to: string) => {
                    if (
                        to.endsWith("index.js") &&
                        from.includes("knext-patch")
                    ) {
                        indexRenames++;
                        // 3436 is the 4th patch to rename index.js (its last file).
                        if (indexRenames === 4) {
                            restoring = true;
                            throw new Error("EIO: simulated");
                        }
                    }
                    renameSync(from, to);
                },
                remove: (path: string) => rmSync(path, { force: true }),
            };
            let thrown: unknown;
            try {
                applyVinextPatches(vinext, { fs });
            } catch (err) {
                thrown = err;
            }
            expect(thrown).toBeInstanceOf(VinextPatchRollbackError);
            const msg = String((thrown as Error).message);
            expect(msg).not.toContain("rolled back");
            expect(msg).toContain(
                join(vinext, "dist", "config", "next-config.js"),
            );
            expect(msg).toContain("rm -rf node_modules/vinext");
            expect(msg).toContain("KNEXT_VINEXT_PATCHES=0");
            // The file whose restore succeeded (the new one) is gone again.
            expect(
                existsSync(
                    join(vinext, "dist", "build", "nitro-trace-includes.js"),
                ),
            ).toBe(false);
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("an EACCES while staging a multi-file patch changes nothing and leaves no temp (always on, even as root)", () => {
        const app = fakeApp(manifest.vinext);
        try {
            const vinext = join(app, "node_modules", "vinext");
            const fs = {
                writeFile: (path: string, text: string) => {
                    if (path.includes(join("dist", "config"))) {
                        throw Object.assign(
                            new Error("EACCES: permission denied"),
                            {
                                code: "EACCES",
                            },
                        );
                    }
                    mkdirSync(dirname(path), { recursive: true });
                    writeFileSync(path, text);
                },
                rename: renameSync,
                remove: (path: string) => rmSync(path, { force: true }),
            };
            expect(() => applyVinextPatches(vinext, { fs })).toThrow(
                VinextPatchWriteError,
            );
            expect(
                existsSync(
                    join(vinext, "dist", "build", "nitro-trace-includes.js"),
                ),
            ).toBe(false);
            expect(
                sha256(join(vinext, "dist", "config", "next-config.js")),
            ).toBe(manifest.pristine["dist/config/next-config.js"] ?? "");
            expect(
                readFileSync(join(vinext, "dist", "index.js"), "utf8"),
            ).not.toContain("createNitroTraceIncludesHook");
            const leftovers = readdirSync(vinext, { recursive: true }).filter(
                (f) => String(f).includes(".knext-patch-"),
            );
            expect(leftovers).toEqual([]);
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it.skipIf(process.getuid?.() === 0)(
        "a read-only directory fails the patch cleanly: nothing in it is half-written",
        () => {
            const app = fakeApp(manifest.vinext);
            const configDir = join(
                app,
                "node_modules",
                "vinext",
                "dist",
                "config",
            );
            try {
                chmodSync(configDir, 0o555);
                const vinext = join(app, "node_modules", "vinext");
                expect(() => applyVinextPatches(vinext)).toThrow(
                    VinextPatchWriteError,
                );
                // 3436 (the only patch touching dist/config) left NO file changed.
                expect(
                    existsSync(
                        join(
                            vinext,
                            "dist",
                            "build",
                            "nitro-trace-includes.js",
                        ),
                    ),
                ).toBe(false);
                expect(
                    sha256(join(vinext, "dist", "config", "next-config.js")),
                ).toBe(manifest.pristine["dist/config/next-config.js"] ?? "");
                expect(
                    readFileSync(join(vinext, "dist", "index.js"), "utf8"),
                ).not.toContain("createNitroTraceIncludesHook");
                const leftovers = readdirSync(vinext, {
                    recursive: true,
                }).filter((f) => String(f).includes(".knext-patch-"));
                expect(leftovers).toEqual([]);
            } finally {
                chmodSync(configDir, 0o755);
                rmSync(app, { recursive: true, force: true });
            }
        },
    );

    it("`vinext-patches` is a dispatchable CLI verb", () => {
        const verbs = COMMAND_GROUPS.flatMap((g) =>
            g.commands.map((c) => c.verb),
        );
        expect(verbs).toContain("vinext-patches");
    });

    it("ensureVinextPatches patches a matching vinext under the app", () => {
        const app = fakeApp(manifest.vinext);
        try {
            const res = ensureVinextPatches(app);
            expect(res.kind).toBe("patched");
            const stage = readFileSync(
                join(
                    app,
                    "node_modules",
                    "vinext",
                    "dist",
                    "server",
                    "pages-request-stage-entry.js",
                ),
                "utf8",
            );
            expect(stage).toContain("originalUrl: originalRenderUrl");
            expect(
                existsSync(
                    join(
                        app,
                        "node_modules",
                        "vinext",
                        "dist",
                        "build",
                        "nitro-trace-includes.js",
                    ),
                ),
            ).toBe(true);
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("check mode reports missing fixes as not applied, never as applied", () => {
        const res = {
            kind: "patched" as const,
            dir: "/x",
            results: [
                { file: "a", upstream: "u", status: "applied" as const },
                {
                    file: "b",
                    upstream: "u",
                    status: "already-applied" as const,
                },
            ],
        };
        expect(describeEnsureResult(res, { check: true })).toEqual([
            "knext: 1 of 2 bundled vinext fix(es) are not applied yet.",
        ]);
        expect(describeEnsureResult(res)).toEqual([
            "knext: applied 1 bundled vinext fix(es) (2 total).",
        ]);
    });

    it("`knext vinext-patches`: --check is red before, apply patches, --check is green after", async () => {
        const app = fakeApp(manifest.vinext);
        try {
            const out: string[] = [];
            const io = { cwd: app, stdout: (t: string) => out.push(t) };
            expect(await vinextPatchesMain(["--check"], io)).toBe(1);
            expect(out.join("")).toContain("not applied");
            // --check wrote nothing.
            for (const [rel, hash] of Object.entries(manifest.pristine)) {
                expect(sha256(join(app, "node_modules", "vinext", rel))).toBe(
                    hash,
                );
            }
            expect(await vinextPatchesMain([], io)).toBe(0);
            expect(await vinextPatchesMain(["--check"], io)).toBe(0);
            expect(out.join("")).toContain("already applied");
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("`knext vinext-patches`: --help, a bad flag, and a conflicting vinext", async () => {
        const out: string[] = [];
        const err: string[] = [];
        const io = {
            stdout: (t: string) => out.push(t),
            stderr: (t: string) => err.push(t),
        };
        expect(await vinextPatchesMain(["--help"], io)).toBe(0);
        expect(out.join("")).toContain("Usage: knext vinext-patches");
        expect(await vinextPatchesMain(["--bogus"], io)).toBe(1);
        expect(err.join("")).toContain("Usage: knext vinext-patches");

        const app = fakeApp(manifest.vinext);
        try {
            // vinext's files modified some other way: refuse, exit 1.
            const target = join(
                app,
                "node_modules",
                "vinext",
                "dist",
                "plugins",
                "require-condition-resolution.js",
            );
            writeFileSync(target, "// replaced\n");
            const conflictErr: string[] = [];
            expect(
                await vinextPatchesMain([], {
                    cwd: app,
                    stdout: () => {},
                    stderr: (t: string) => conflictErr.push(t),
                }),
            ).toBe(1);
            expect(conflictErr.join("")).toContain("reinstall dependencies");
            // The opt-out is named, not just "reinstall".
            expect(conflictErr.join("")).toContain(
                "set KNEXT_VINEXT_PATCHES=0",
            );
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("`knext vinext-patches` with another vinext version says so and exits 0", async () => {
        const app = fakeApp("1.0.2");
        try {
            const out: string[] = [];
            expect(
                await vinextPatchesMain([], {
                    cwd: app,
                    stdout: (t: string) => out.push(t),
                }),
            ).toBe(0);
            expect(out.join("")).toContain("vinext 1.0.2 is installed");
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("ensureVinextPatches leaves a different vinext version alone", () => {
        const app = fakeApp("1.0.2");
        try {
            const res = ensureVinextPatches(app);
            expect(res.kind).toBe("version-mismatch");
            for (const [rel, hash] of Object.entries(manifest.pristine)) {
                expect(sha256(join(app, "node_modules", "vinext", rel))).toBe(
                    hash,
                );
            }
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("ensureVinextPatches is a no-op without vinext", () => {
        const app = mkdtempSync(join(tmpdir(), "knext-vp-novinext-"));
        try {
            expect(ensureVinextPatches(app).kind).toBe("no-vinext");
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("`knext build` (runProjectBuild on the vinext target) applies the patches before building", () => {
        const app = fakeApp(manifest.vinext);
        try {
            let sawPatchedAtBuild = false;
            runProjectBuild({
                requireEsm: true,
                cwd: app,
                run: () => {
                    sawPatchedAtBuild = readFileSync(
                        join(
                            app,
                            "node_modules",
                            "vinext",
                            "dist",
                            "plugins",
                            "require-condition-resolution.js",
                        ),
                        "utf8",
                    ).includes("noExternal: true");
                },
            });
            expect(sawPatchedAtBuild).toBe(true);
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });

    it("the official-adapter target (requireEsm false) does not touch vinext", () => {
        const app = fakeApp(manifest.vinext);
        try {
            runProjectBuild({ requireEsm: false, cwd: app, run: () => {} });
            for (const [rel, hash] of Object.entries(manifest.pristine)) {
                expect(sha256(join(app, "node_modules", "vinext", rel))).toBe(
                    hash,
                );
            }
        } finally {
            rmSync(app, { recursive: true, force: true });
        }
    });
});
