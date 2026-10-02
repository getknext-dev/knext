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
import { createHash } from "node:crypto";
import {
    cpSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
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
    ensureVinextPatches,
    findVinextDir,
    loadVinextPatchManifest,
    parseUnifiedPatch,
    VinextPatchConflictError,
    vinextPatchesDir,
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

function tmp(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
}

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
        const dir = tmp("knext-vp-hardlink-");
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

        const app = realpathSync(tmp("knext-vp-trace-"));
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
            rmSync(app, { recursive: true, force: true });
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
    const app = tmp("knext-vp-app-");
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
        expect(tpl.scripts.postinstall).toBe("knext vinext-patches");
    });

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
        const app = tmp("knext-vp-novinext-");
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
