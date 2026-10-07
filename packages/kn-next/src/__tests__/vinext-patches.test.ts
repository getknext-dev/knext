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
    symlinkSync,
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
const tempRoots: string[] = [];

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
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
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

    it("vinext#3241: no longer bundled — 1.0.1 already inlines NEXT_DEPLOYMENT_ID into every bundle, workers included", () => {
        // The fix landed upstream as a no-op: vinext 1.0.1's own top-level
        // `define` carries both identifiers, and Vite's worker build inherits it.
        const index = readFileSync(
            join(INSTALLED_VINEXT, "dist", "index.js"),
            "utf8",
        );
        expect(index).toContain(
            'defines["process.env.NEXT_DEPLOYMENT_ID"] = nextConfig.deploymentId ? JSON.stringify(nextConfig.deploymentId) : "false";',
        );
        expect(index).toContain(
            'defines["process.env.__VINEXT_DEPLOYMENT_ID"] = JSON.stringify(nextConfig.deploymentId ?? "");',
        );
        expect(manifest.patches.map((p) => p.file)).not.toContain(
            "vinext-3241-worker-deployment-id.patch",
        );
        expect(index).not.toContain("createWorkerDeploymentIdDefinePlugin");
    });

    it("vinext#3423: require targets are pre-resolved with a bundling resolver pair, and only packages Vite would just externalize are taken over", async () => {
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
            () => [],
        );
        plugin.configResolved({});
        // The default pair keeps Vite's externalization; the bundling pair
        // (noExternal) is what resolves the `require` target of a package
        // the environment would otherwise leave external.
        expect(seen).toEqual([
            { isRequire: true },
            { isRequire: false },
            { isRequire: true, noExternal: true },
            { isRequire: false, noExternal: true },
        ]);

        // vinext:transitive-externals marks a copy it forces into the bundle,
        // so the resolver can tell it from a user plugin's own resolution.
        const te = await importPatched<{
            TRANSITIVE_EXTERNAL_META_KEY: string;
        }>("dist/plugins/transitive-externals.js");
        expect(te.TRANSITIVE_EXTERNAL_META_KEY).toBe(
            "vinext:transitive-externals",
        );
        const index = readFileSync(join(patched, "dist", "index.js"), "utf8");
        expect(index).toContain(
            "createRequireConditionResolutionPlugin(createIdResolver, commonjsTransformFilter, () => resolvedServerExternalPackages)",
        );
    });

    it("vinext#3436: next.config outputFileTracing* reach the resolved config as route-keyed maps, and the hooks edit Nitro's trace", async () => {
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
                    "/bad": "not-an-array",
                },
                outputFileTracingExcludes: { "/*": ["node_modules/c/**"] },
            },
            tmpdir(),
        );
        expect(resolved.outputFileTracingIncludes).toEqual({
            "/*": ["node_modules/a/**"],
            "/x": ["node_modules/a/**", "node_modules/b/x.txt"],
        });
        expect(resolved.outputFileTracingExcludes).toEqual({
            "/*": ["node_modules/c/**"],
        });
        // A value under the legacy `experimental` key replaces the top-level one.
        const legacy = await cfg.resolveNextConfig(
            {
                outputFileTracingIncludes: { "/*": ["top/**"] },
                experimental: {
                    outputFileTracingIncludes: { "/y": ["old/**"] },
                },
            },
            tmpdir(),
        );
        expect(legacy.outputFileTracingIncludes).toEqual({ "/y": ["old/**"] });
        const none = await cfg.resolveNextConfig({}, tmpdir());
        expect(none.outputFileTracingIncludes).toEqual({});
        expect(none.outputFileTracingExcludes).toEqual({});

        const traceRoot = mkdtempSync(join(tmpdir(), "knext-vp-trace-"));
        tempRoots.push(traceRoot);
        const app = realpathSync(traceRoot);
        const lib = join(app, "node_modules", "lib-a");
        mkdirSync(join(lib, "data"), { recursive: true });
        writeFileSync(
            join(lib, "package.json"),
            JSON.stringify({ name: "lib-a", version: "1.2.3" }),
        );
        writeFileSync(join(lib, "data", "keep.txt"), "k");
        writeFileSync(join(lib, "data", "drop.txt"), "d");
        type Traced = Record<
            string,
            {
                name: string;
                versions: Record<string, { path: string; files: string[] }>;
            }
        >;
        const { createNitroTraceIncludes } = await importPatched<{
            createNitroTraceIncludes: (o: {
                root: string;
                routes: string[];
                includes: Record<string, string[]>;
                excludes: Record<string, string[]>;
                warn: (m: string) => void;
            }) => {
                tracedPackages: (t: Traced) => void;
                write: (serverDir: string) => void;
            } | null;
        }>("dist/build/nitro-trace-includes.js");
        const warn = () => {};
        expect(
            createNitroTraceIncludes({
                root: app,
                routes: ["/page"],
                includes: {},
                excludes: {},
                warn,
            }),
        ).toBeNull();

        // Nitro traced the package: included files are added, excluded ones removed.
        const hooks = createNitroTraceIncludes({
            root: app,
            routes: ["/page"],
            includes: { "/*": ["node_modules/lib-a/data/*.txt"] },
            excludes: { "/*": ["node_modules/lib-a/data/drop.txt"] },
            warn,
        });
        const traced: Traced = {
            "lib-a": {
                name: "lib-a",
                versions: {
                    "1.2.3": {
                        path: lib,
                        files: [join(lib, "package.json")],
                    },
                },
            },
        };
        hooks?.tracedPackages(traced);
        expect(traced["lib-a"]?.versions["1.2.3"]?.files.sort()).toEqual([
            join(lib, "data", "keep.txt"),
            join(lib, "package.json"),
        ]);

        // Nitro skipped its trace (nothing external): `write` copies the
        // included files itself, after the bundle is written.
        const outDir = mkdtempSync(join(tmpdir(), "knext-vp-trace-out-"));
        tempRoots.push(outDir);
        const writer = createNitroTraceIncludes({
            root: app,
            routes: ["/page"],
            includes: { "/*": ["node_modules/lib-a/data/*.txt"] },
            excludes: { "/*": ["node_modules/lib-a/data/drop.txt"] },
            warn,
        });
        writer?.write(outDir);
        expect(
            readFileSync(
                join(outDir, "node_modules", "lib-a", "data", "keep.txt"),
                "utf8",
            ),
        ).toBe("k");
        expect(
            existsSync(
                join(outDir, "node_modules", "lib-a", "data", "drop.txt"),
            ),
        ).toBe(false);

        // A route key that does not match this route selects nothing.
        const other = createNitroTraceIncludes({
            root: app,
            routes: ["/page"],
            includes: { "/other-route": ["node_modules/lib-a/data/*.txt"] },
            excludes: {},
            warn,
        });
        const untouched: Traced = {};
        other?.tracedPackages(untouched);
        expect(untouched).toEqual({});
    });

    it("vinext#3424 / #3226 / #3472: the ported hunks are present in the patched dist", () => {
        applyVinextPatches(patched);
        const index = readFileSync(join(patched, "dist", "index.js"), "utf8");
        // #3424 (amended, R1) — the RSC environment fully bundles under
        // Nitro, but default-external packages (Next's `serverExternalPackages`
        // list, which includes sqlite3's `bindings` helper and typescript)
        // stay external instead of being swept into the compiled executable.
        // Un-amended this read `{ resolve: { noExternal: true } }` with no
        // `external`, which is exactly the rc.1 regression (turbopack-reports,
        // twoslash): see the dedicated behavioural test below.
        expect(index).toContain(
            "...hasNitroPlugin && !hasCloudflarePlugin && userSsrExternal !== true ? { resolve: { noExternal: true, external: [...userSsrExternal] } } : nitroDevEnvironmentResolve,",
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

    it("vinext#3681: lightningCssFeatures.include('custom-media-queries') also turns on drafts.customMedia", () => {
        applyVinextPatches(patched);
        const index = readFileSync(join(patched, "dist", "index.js"), "utf8");
        expect(index).toContain(
            '...(nextConfig.lightningCssFeatures.include & ~nextConfig.lightningCssFeatures.exclude & lightningCssFeatureNamesToMask(["custom-media-queries"])) !== 0 ? { drafts: { customMedia: true } } : {}',
        );
    });

    it("vinext#3682: unmatched subresource requests get a plain-text 404", async () => {
        applyVinextPatches(patched);
        const mod = await importPatched<{
            isNonHtmlSecFetchDest: (value: unknown) => boolean;
        }>("dist/server/is-non-html-sec-fetch-dest.js");
        expect(mod.isNonHtmlSecFetchDest("image")).toBe(true);
        expect(mod.isNonHtmlSecFetchDest("font")).toBe(true);
        expect(mod.isNonHtmlSecFetchDest("document")).toBe(false);
        expect(mod.isNonHtmlSecFetchDest("empty")).toBe(false);
        expect(mod.isNonHtmlSecFetchDest(undefined)).toBe(false);
        expect(mod.isNonHtmlSecFetchDest(null)).toBe(false);
        const handler = readFileSync(
            join(patched, "dist", "server", "app-rsc-handler.js"),
            "utf8",
        );
        expect(handler).toContain(
            'isNonHtmlSecFetchDest(request.headers.get("sec-fetch-dest"))',
        );
        expect(handler).toContain(
            "return notFoundStaticAssetResponse(headers);",
        );
    });

    it("vinext#3683: no longer bundled — upstream closed it (a log line with no behavioural effect)", () => {
        expect(manifest.patches.map((p) => p.file)).not.toContain(
            "vinext-3683-edge-runtime-deprecated-warning.patch",
        );
        const seg = readFileSync(
            join(patched, "dist", "server", "app-segment-config.js"),
            "utf8",
        );
        expect(seg).not.toContain("The Edge Runtime is deprecated");
    });

    it("vinext#3684: repeated slashes and backslashes get Next.js's 308 to the collapsed path; encoded and still-open-redirect shapes keep their 404", async () => {
        applyVinextPatches(patched);
        const mod = await importPatched<{
            isOpenRedirectShaped: (rawPathname: string) => boolean;
            getRepeatedSlashRedirect: (
                rawUrl: string,
            ) => { status: 308; location: string } | { status: 404 } | null;
            repeatedSlashRedirectResponse: (rawUrl: string) => Response | null;
            sendRepeatedSlashRedirect: (
                rawUrl: string,
                res: {
                    writeHead(s: number, h?: Record<string, string>): unknown;
                    end(body: string): unknown;
                },
            ) => boolean;
        }>("dist/server/open-redirect.js");
        // A bare `//` is the index route, not a 404.
        expect(mod.getRepeatedSlashRedirect("//")).toEqual({
            status: 308,
            location: "/",
        });
        expect(mod.getRepeatedSlashRedirect("//evil.com/x?a=1")).toEqual({
            status: 308,
            location: "/evil.com/x?a=1",
        });
        expect(mod.getRepeatedSlashRedirect("/\\evil.com")).toEqual({
            status: 308,
            location: "/evil.com",
        });
        expect(mod.getRepeatedSlashRedirect("/docs//")).toEqual({
            status: 308,
            location: "/docs/",
        });
        // Nothing to collapse: left alone (and a non-origin-form target too).
        expect(mod.getRepeatedSlashRedirect("/a/b")).toBeNull();
        expect(mod.getRepeatedSlashRedirect("http://h//x")).toBeNull();
        // A collapsed path that is still protocol-relative shaped is never echoed.
        expect(mod.getRepeatedSlashRedirect("//%2Fevil.com")).toEqual({
            status: 404,
        });
        // Encoded leading delimiters are not touched by the redirect: they keep
        // falling through to the open-redirect guard.
        expect(mod.getRepeatedSlashRedirect("/%2F/evil.com")).toBeNull();
        expect(mod.isOpenRedirectShaped("/%2F/evil.com")).toBe(true);
        expect(mod.isOpenRedirectShaped("//evil.com")).toBe(true);

        const res = mod.repeatedSlashRedirectResponse("//a//b");
        expect(res?.status).toBe(308);
        expect(res?.headers.get("location")).toBe("/a/b");
        expect(res?.headers.get("refresh")).toBe("0;url=/a/b");
        expect(mod.repeatedSlashRedirectResponse("/ok")).toBeNull();

        const sent: unknown[] = [];
        const node = {
            writeHead: (s: number, h?: Record<string, string>) =>
                sent.push(["head", s, h]),
            end: (b: string) => sent.push(["end", b]),
        };
        expect(mod.sendRepeatedSlashRedirect("//x", node)).toBe(true);
        expect(sent).toEqual([
            ["head", 308, { Location: "/x", Refresh: "0;url=/x" }],
            ["end", "/x"],
        ]);
        expect(mod.sendRepeatedSlashRedirect("/fine", node)).toBe(false);

        // The shared guard redirects first, then 404s the encoded shapes.
        const pipeline = await importPatched<{
            guardProtocolRelativeUrl: (
                rawPathname: string,
                search?: string,
            ) => Response | null;
        }>("dist/server/request-pipeline.js");
        const guarded = pipeline.guardProtocolRelativeUrl(
            "//evil.com/",
            "?q=1",
        );
        expect(guarded?.status).toBe(308);
        expect(guarded?.headers.get("location")).toBe("/evil.com/?q=1");
        expect(pipeline.guardProtocolRelativeUrl("/%5Cevil.com/")?.status).toBe(
            404,
        );
        expect(pipeline.guardProtocolRelativeUrl("/fine")).toBeNull();
    });

    it("vinext#3424 (R1 amendment): the Nitro RSC noExternal:true carries an explicit external list, so default-external packages (sqlite3's `bindings` helper, typescript) are never swept into the compiled executable", () => {
        applyVinextPatches(patched);
        const index = readFileSync(join(patched, "dist", "index.js"), "utf8");
        const marker =
            "...hasNitroPlugin && !hasCloudflarePlugin && userSsrExternal !== true ? { resolve: { noExternal: true, external: [...userSsrExternal] } } : nitroDevEnvironmentResolve,";
        expect(index).toContain(marker);
        // Evaluate the EXACT ternary found in the patched dist (not a
        // hand-duplicated copy) against representative inputs, so a future
        // edit to the marker string above cannot silently diverge from what
        // actually executes. `userSsrExternal` here stands in for Next's
        // merged default server-external list — the rc.1 regression's two
        // victims (turbopack-reports' sqlite3/bindings, twoslash's
        // typescript) were both on that list.
        const exprText = marker.replace(/^\.\.\./, "").replace(/,$/, "");
        const evalExpr = new Function(
            "hasNitroPlugin",
            "hasCloudflarePlugin",
            "userSsrExternal",
            "nitroDevEnvironmentResolve",
            `return (${exprText});`,
        ) as (
            hasNitroPlugin: boolean,
            hasCloudflarePlugin: boolean,
            userSsrExternal: string[] | true,
            nitroDevEnvironmentResolve: Record<string, unknown>,
        ) => unknown;
        // Nitro build, no Cloudflare plugin, a concrete external list: the
        // regression case — must bundle (noExternal:true) but carve the
        // list back out (external:list), matching the pre-#3424 "patches
        // OFF" behaviour for exactly those packages.
        expect(
            evalExpr(true, false, ["sqlite3", "typescript"], {
                resolve: { noExternal: ["next"] },
            }),
        ).toEqual({
            resolve: { noExternal: true, external: ["sqlite3", "typescript"] },
        });
        // Cloudflare builds are untouched by this branch (falls through to
        // nitroDevEnvironmentResolve, which is `{}` outside dev-serve).
        expect(evalExpr(true, true, ["sqlite3"], {})).toEqual({});
        // userSsrExternal === true (the user opted every SSR dep external):
        // the amendment's own guard excludes this case too.
        expect(evalExpr(true, false, true, {})).toEqual({});
        // Not a Nitro build at all: untouched.
        expect(evalExpr(false, false, ["sqlite3"], {})).toEqual({});
    });

    it("vinext#3686: the image optimizer path honours trailingSlash (both branches)", async () => {
        applyVinextPatches(patched);
        // bun's module cache keys on the resolved path (a query-string
        // cache-buster does not force re-evaluation), and __trailingSlash is
        // read from process.env once at module scope — so each branch needs
        // its OWN file path, not just its own import call, or the first
        // branch's value sticks for the second import too.
        const srcPath = join(patched, "dist", "shims", "image.js");
        const truePath = join(
            patched,
            "dist",
            "shims",
            "image.trailingslash-true-probe.js",
        );
        const falsePath = join(
            patched,
            "dist",
            "shims",
            "image.trailingslash-false-probe.js",
        );
        cpSync(srcPath, truePath);
        cpSync(srcPath, falsePath);
        type ImageModule = {
            imageOptimizationUrl: (
                src: string,
                width: number,
                quality?: number,
            ) => string;
        };
        try {
            process.env.__VINEXT_TRAILING_SLASH = "true";
            const trueMod = (await import(
                pathToFileURL(truePath).href
            )) as ImageModule;
            expect(trueMod.imageOptimizationUrl("/test.jpg", 828, 75)).toBe(
                "/_next/image/?url=%2Ftest.jpg&w=828&q=75",
            );
        } finally {
            delete process.env.__VINEXT_TRAILING_SLASH;
        }
        // Unset: the pre-existing default-path behaviour, in its own fresh
        // module instance (process.env.__VINEXT_TRAILING_SLASH is already
        // deleted above, before this import).
        const falseMod = (await import(
            pathToFileURL(falsePath).href
        )) as ImageModule;
        expect(falseMod.imageOptimizationUrl("/test.jpg", 828, 75)).toBe(
            "/_next/image?url=%2Ftest.jpg&w=828&q=75",
        );
    });

    it("vinext#3686: a custom loader prop gets the built-in loader's per-breakpoint srcSet, with quality passed through unforced", async () => {
        applyVinextPatches(patched);
        const mod = await importPatched<{
            getImageProps: (props: Record<string, unknown>) => {
                props: { src: string; srcSet?: string };
            };
        }>("dist/shims/image.js");
        // Ported from Next.js: test/e2e/next-image-new/loader-config/loader-config.test.ts
        // (the "loader prop" / img2 cases — the "loaderFile" / img1 cases
        // need the upstream images.loaderFile wiring, not bundled here; see
        // the patch header).
        const loader = ({
            src,
            width,
            quality,
        }: {
            src: string;
            width: number;
            quality?: number;
        }) => `${src}?wid=${width}&qual=${quality ?? 35}`;
        const { props } = mod.getImageProps({
            alt: "img2",
            src: "/logo.png",
            width: 200,
            height: 200,
            loader,
        });
        expect(props.src).toBe("/logo.png?wid=640&qual=35");
        expect(props.srcSet).toBe(
            "/logo.png?wid=256&qual=35 1x, /logo.png?wid=640&qual=35 2x",
        );
        // Before the fix: a single call at the raw width with quality
        // forced to 75 — `/logo.png?wid=200&qual=75`, no srcSet. Guard
        // against that regression explicitly.
        expect(props.src).not.toBe("/logo.png?wid=200&qual=75");
    });

    it("vinext#3734: /_next/image success responses carry x-nextjs-cache: MISS, errors carry none", async () => {
        applyVinextPatches(patched);
        const mod = await importPatched<{
            handleImageOptimization: (
                request: Request,
                handlers: {
                    fetchAsset: (p: string, r: Request) => Promise<Response>;
                    transformImage?: (
                        body: ReadableStream,
                        o: { width: number; format: string; quality: number },
                    ) => Promise<Response>;
                },
                allowedWidths?: number[],
                imageConfig?: { dangerouslyAllowSVG?: boolean },
            ) => Promise<Response>;
        }>("dist/server/image-optimization.js");
        const url = "http://localhost/_next/image?url=%2Fimg.jpg&w=640&q=75";
        const jpeg = () =>
            new Response("img", {
                status: 200,
                headers: { "Content-Type": "image/jpeg" },
            });
        const svg = () =>
            new Response("<svg/>", {
                status: 200,
                headers: { "Content-Type": "image/svg+xml" },
            });
        const passthrough = await mod.handleImageOptimization(
            new Request(url),
            {
                fetchAsset: async () => jpeg(),
            },
        );
        expect(passthrough.headers.get("x-nextjs-cache")).toBe("MISS");
        const transformed = await mod.handleImageOptimization(
            new Request(url),
            {
                fetchAsset: async () => jpeg(),
                transformImage: async () =>
                    new Response("t", {
                        status: 200,
                        headers: {
                            "Content-Type": "image/webp",
                            "x-nextjs-cache": "HIT",
                        },
                    }),
            },
        );
        expect(transformed.headers.get("x-nextjs-cache")).toBe("MISS");
        const svgOk = await mod.handleImageOptimization(
            new Request(url),
            { fetchAsset: async () => svg() },
            undefined,
            { dangerouslyAllowSVG: true },
        );
        expect(svgOk.headers.get("x-nextjs-cache")).toBe("MISS");
        const bad = await mod.handleImageOptimization(
            new Request("http://localhost/_next/image"),
            { fetchAsset: async () => jpeg() },
        );
        expect(bad.status).toBe(400);
        expect(bad.headers.has("x-nextjs-cache")).toBe(false);
        const missing = await mod.handleImageOptimization(new Request(url), {
            fetchAsset: async () => new Response("", { status: 404 }),
        });
        expect(missing.status).toBe(404);
        expect(missing.headers.has("x-nextjs-cache")).toBe(false);
        const blocked = await mod.handleImageOptimization(new Request(url), {
            fetchAsset: async () => svg(),
        });
        expect(blocked.status).toBe(400);
        expect(blocked.headers.has("x-nextjs-cache")).toBe(false);
    });

    it("vinext#3741: the App Router handler hands /_next/image to the Nitro app instead of redirecting", () => {
        applyVinextPatches(patched);
        const handler = readFileSync(
            join(patched, "dist", "server", "app-rsc-handler.js"),
            "utf8",
        );
        expect(handler).toContain(
            "const nitroFetch = options.isDev ? void 0 : getNitroAppFetch();",
        );
        expect(handler).toContain(
            "return handleNitroImageOptimization(request, nitroFetch,",
        );
        expect(handler).toContain("globalThis.__nitro__?.default");
        // Dev (and hosts without Nitro) keep the redirect.
        expect(handler).toContain(
            "return Response.redirect(assetUrl.href, 302);",
        );
    });

    it("vinext#3741: the Nitro image path answers 200 with Next-style headers and never forwards Set-Cookie", async () => {
        applyVinextPatches(patched);
        const mod = await importPatched<{
            handleNitroImageOptimization: (
                request: Request,
                nitroFetch: (request: Request) => Promise<Response>,
                allowedWidths?: number[],
                imageConfig?: unknown,
                basePath?: string,
            ) => Promise<Response>;
        }>("dist/server/image-optimization.js");
        const seen: Request[] = [];
        const nitroFetch = (source: Response) => async (req: Request) => {
            seen.push(req);
            return source;
        };
        const imageUrl = (u: string) =>
            new Request(`http://localhost/_next/image?url=${u}&w=640&q=75`, {
                headers: { cookie: "user=1", authorization: "Bearer x" },
            });
        const jpeg = () =>
            new Response("img", {
                status: 200,
                headers: {
                    "Content-Type": "image/jpeg",
                    "Set-Cookie": "session=abc",
                    "X-Middleware": "1",
                    "Cache-Control": "public, max-age=0",
                },
            });

        const ok = await mod.handleNitroImageOptimization(
            imageUrl("%2Fimg.jpg"),
            nitroFetch(jpeg()),
        );
        expect(ok.status).toBe(200); // not a 302
        expect(ok.headers.get("location")).toBeNull();
        expect(ok.headers.get("x-nextjs-cache")).toBe("MISS");
        expect(ok.headers.get("Cache-Control")).toBe(
            "public, max-age=14400, must-revalidate",
        );
        expect(ok.headers.has("set-cookie")).toBe(false);
        expect(ok.headers.has("x-middleware")).toBe(false);
        expect(await ok.text()).toBe("img");
        expect(seen[0]?.url).toBe("http://localhost/img.jpg");
        expect(seen[0]?.headers.has("cookie")).toBe(false);
        expect(seen[0]?.headers.has("authorization")).toBe(false);

        // A route answering with a non-image is rejected, not proxied.
        const route = await mod.handleNitroImageOptimization(
            imageUrl("%2Fapi%2Fx"),
            nitroFetch(
                new Response("{}", {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                        "Set-Cookie": "s=1",
                    },
                }),
            ),
        );
        expect(route.status).toBe(400);
        expect(route.headers.has("set-cookie")).toBe(false);
        expect(route.headers.has("x-nextjs-cache")).toBe(false);

        // Hashed build media is content-addressed, so it stays immutable.
        const hashed = await mod.handleNitroImageOptimization(
            imageUrl("%2F_next%2Fstatic%2Fmedia%2Fa.abc.png"),
            nitroFetch(
                new Response("img", {
                    status: 200,
                    headers: { "Content-Type": "image/png" },
                }),
            ),
        );
        expect(hashed.headers.get("Cache-Control")).toBe(
            "public, max-age=31536000, immutable",
        );

        // A traversal out of the hashed directory is a plain public file.
        for (const traversal of [
            "%2F_next%2Fstatic%2Fmedia%2F..%2Fhero.jpg",
            "%2F_next%2Fstatic%2Fmedia%2F%2e%2e%2Fhero.jpg",
        ]) {
            const escaped = await mod.handleNitroImageOptimization(
                imageUrl(traversal),
                nitroFetch(
                    new Response("img", {
                        status: 200,
                        headers: { "Content-Type": "image/jpeg" },
                    }),
                ),
            );
            expect(escaped.headers.get("Cache-Control")).toBe(
                "public, max-age=14400, must-revalidate",
            );
        }
    });

    // Shared by all three vinext#3689 cases below: the full option surface
    // `handleServerActionRscRequest` requires. Modeled on vinext's own
    // fixture (tests/app-server-action-execution.test.ts's
    // createRscOptions), trimmed to the fields this redirect path reads.
    // `overrides` lets each test reach one of the fix's three distinct
    // call sites: the default `dispatchRedirectTargetRequest` below always
    // returns valid Flight content, which only ever reaches the THIRD site
    // (the final, unconditional wrapper status). A test that needs the
    // FIRST site (no internal redirect target at all) picks an external
    // `redirectTargetUrl` instead; a test that needs the SECOND site (an
    // internal target whose response is not usable Flight content) passes
    // its own `dispatchRedirectTargetRequest` override.
    async function callHandleServerActionRscRequest(
        redirectTargetUrl: string,
        redirectType: string,
        overrides: Record<string, unknown> = {},
    ): Promise<Response | null> {
        applyVinextPatches(patched);
        const actionMod = await importPatched<{
            handleServerActionRscRequest: (
                options: Record<string, unknown>,
            ) => Promise<Response | null>;
        }>("dist/server/app-server-action-execution.js");
        const headersMod = await importPatched<{
            setHeadersAccessPhase: (phase: string) => string;
        }>("dist/shims/headers.js");

        const dashboardRoute = {
            id: "dashboard",
            page: {},
            params: [],
            pattern: "/dashboard",
        };
        const targetRoute = {
            id: "redirect-target",
            page: {},
            params: [],
            pattern: "/redirect-target",
        };
        const matchRoute = (pathname: string) =>
            pathname === "/redirect-target"
                ? { params: {}, route: targetRoute }
                : { params: {}, route: dashboardRoute };

        const request = new Request(
            "https://example.com/dashboard?tab=activity",
            {
                body: "encoded-flight-body",
                method: "POST",
                headers: {
                    "content-type": "text/plain;charset=UTF-8",
                    host: "example.com",
                    origin: "https://example.com",
                    "x-rsc-action": "action-id",
                },
            },
        );

        return actionMod.handleServerActionRscRequest({
            actionId: "action-id",
            allowedOrigins: [],
            buildPageElement: () => "rendered-target",
            cleanPathname: "/dashboard",
            clearRequestContext() {},
            contentType: "text/plain;charset=UTF-8",
            createNotFoundElement: (routeId: string) => `not-found:${routeId}`,
            createPayloadRouteId: (pathname: string, ctx: string | null) =>
                `${pathname}:${ctx ?? "none"}`,
            createRscOnErrorHandler: () => () => undefined,
            createTemporaryReferenceSet: () => ({}),
            currentRouteMatch: matchRoute("/dashboard"),
            currentRoutePathname: "/dashboard",
            decodeReply: () => Promise.resolve([]),
            draftModeSecret: "draft-secret",
            // Default: answers an internal-looking target with a valid
            // Flight response — exercises the THIRD site (the final,
            // unconditional wrapper status). A test that overrides this
            // reaches the SECOND site instead (see the shared helper's own
            // comment above).
            async dispatchRedirectTargetRequest() {
                return new Response(
                    JSON.stringify({
                        root: "redirect-target:{}:none",
                        returnValue: { ok: true },
                    }),
                    { headers: { "content-type": "text/x-component" } },
                );
            },
            findIntercept: () => null,
            getAndClearPendingCookies: () => [],
            getDraftModeCookieHeader: () => null,
            getRouteParamNames: (route: { params: string[] }) => route.params,
            getSourceRoute: () => undefined,
            isRscRequest: true,
            loadServerAction(actionId: string) {
                const action = () => {
                    throw {
                        digest: `NEXT_REDIRECT;${redirectType};${encodeURIComponent(redirectTargetUrl)};307`,
                    };
                };
                // handleServerActionRscRequest requires a loaded action's
                // registered reference id to match the request's actionId
                // (requiresRegisteredServerReferenceMatch /
                // matchesRegisteredServerReference) whenever the id has no
                // dev-mode "#export" suffix — mirrors vinext's own
                // registerTestServerReference test helper.
                Object.defineProperty(action, "$$id", {
                    configurable: true,
                    value: actionId,
                });
                return Promise.resolve(action);
            },
            matchRoute,
            maxActionBodySize: 1024,
            maxActionBodySizeLabel: "1kb",
            middlewareHeaders: null,
            middlewareRequestHeaders: null,
            middlewareStatus: null,
            mountedSlotsHeader: null,
            readBodyWithLimit: () => Promise.resolve("encoded-flight-body"),
            readFormDataWithLimit: () => Promise.resolve(new FormData()),
            renderToReadableStream: (model: unknown) =>
                new Response(JSON.stringify(model)).body,
            reportRequestError() {},
            request,
            sanitizeErrorForClient: (error: unknown) => error,
            searchParams: new URLSearchParams("tab=activity"),
            setHeadersAccessPhase: headersMod.setHeadersAccessPhase,
            setNavigationContext() {},
            toInterceptOpts: (intercept: { slotKey: string }) => ({
                slot: intercept.slotKey,
            }),
            ...overrides,
        });
    }

    it("vinext#3689 (site 3, the final unconditional wrapper): a fetch action's redirect to an ordinary (non-forwarded, non-ancestor, same-runtime) route answers 200, not 303", async () => {
        // Ported from Next.js: test/e2e/app-dir/actions/app-action.test.ts —
        // the same fixture cloudflare/vinext#3689's own regression test
        // ports. Before the fix, exactly this case (a plain redirect to an
        // unrelated route, not already forwarded, not an ancestor or stale
        // sibling, not a cross-runtime target) fell through
        // shouldUseForwardedActionRedirectStatus() to 303. The default
        // dispatchRedirectTargetRequest (valid Flight content) means this
        // reaches site 3 only — sites 1 and 2 are each covered by their own
        // test below.
        const response = await callHandleServerActionRscRequest(
            "/redirect-target",
            "push",
        );
        expect(response?.status).toBe(200);
        expect(response?.headers.get("x-action-redirect")).toBe(
            "/redirect-target",
        );
        expect(response?.headers.get("location")).toBeNull();
        expect(JSON.parse(await response!.text())).toEqual({
            root: "redirect-target:{}:none",
            returnValue: { ok: true },
        });
    });

    it("vinext#3689 (site 1, the `!redirectTarget` early return): a fetch action's redirect to an external URL also answers 200, not 303", async () => {
        // Exercises the `!redirectTarget` early return (resolveInternalActionRedirectTarget
        // returns null for a cross-origin target, so there is no internal
        // Flight response to stream) — ONE of the three sites this patch
        // fixes (the other two are covered by the tests immediately before
        // and after this one). The target reaches the browser only via
        // x-action-redirect, which the client already validates before
        // navigating; this response carries no Location header, so the
        // status change cannot turn it into a browser-followed redirect.
        const response = await callHandleServerActionRscRequest(
            "https://other.example/landing",
            "push",
        );
        expect(response?.status).toBe(200);
        expect(response?.headers.get("x-action-redirect")).toBe(
            "https://other.example/landing",
        );
        expect(response?.headers.get("location")).toBeNull();
        expect(await response!.text()).toBe("");
    });

    it("vinext#3689 (site 2, the forwarded-but-not-Flight fallback): a fetch action's redirect to an internal target whose dispatch returns non-Flight content also answers 200, not 303", async () => {
        // Exercises the SECOND early return: resolveInternalActionRedirectTarget
        // DOES resolve an internal target, but the dispatched response is
        // not usable RSC Flight content (wrong content-type here; vinext's
        // own suite also covers "not an App route", "an App route handler",
        // "no page", and "a non-2xx fallback page" the same way — see
        // app-server-action-execution.test.ts's "falls back to a
        // header-only redirect..." tests, and upstream #3689's
        // /pages-target, /api/logout, /layout-only, /protected fixtures).
        // Before the fix this fell back to 303, same as the other two
        // sites; after the fix it is 200 like every other fetch-action
        // redirect, still with no Location header and no streamed body.
        const response = await callHandleServerActionRscRequest(
            "/protected",
            "push",
            {
                async dispatchRedirectTargetRequest() {
                    return new Response("unauthorized", {
                        status: 401,
                        headers: { "content-type": "text/plain" },
                    });
                },
            },
        );
        expect(response?.status).toBe(200);
        expect(response?.headers.get("x-action-redirect")).toBe("/protected");
        expect(response?.headers.get("location")).toBeNull();
        expect(response?.headers.get("content-type")).toBeNull();
        expect(await response!.text()).toBe("");
    });

    it("vinext#3689 (maintainer follow-up): a header-only fetch-action redirect is marked config-headers-applied, so finalization does not repeat the source's headers at 200", async () => {
        const redirect = await callHandleServerActionRscRequest(
            "https://other.example/landing",
            "push",
        );
        expect(redirect?.status).toBe(200);
        const finalizer = await importPatched<{
            finalizeAppRscResponse: (
                response: Response,
                request: Request,
                options: Record<string, unknown>,
            ) => Promise<Response>;
        }>("dist/server/app-rsc-response-finalizer.js");
        const options = {
            basePath: "",
            configHeaders: [
                {
                    source: "/dashboard",
                    headers: [{ key: "x-from-config", value: "1" }],
                },
            ],
            requestContext: {
                headers: new Headers(),
                cookies: {},
                query: new URLSearchParams(),
                host: "example.com",
            },
        };
        const request = new Request("https://example.com/dashboard");
        const finalized = await finalizer.finalizeAppRscResponse(
            redirect as Response,
            request,
            options,
        );
        expect(finalized.headers.has("x-from-config")).toBe(false);
        // An unmarked 200 still gets them: the guard discriminates.
        const plain = await finalizer.finalizeAppRscResponse(
            new Response(null, { status: 200 }),
            request,
            options,
        );
        expect(plain.headers.get("x-from-config")).toBe("1");
    });

    it("vinext#3686 (maintainer's head): a custom loader also serves fill images, skips inline sources, yields to overrideSrc, and a caller srcSet is ignored", async () => {
        applyVinextPatches(patched);
        const mod = await importPatched<{
            getImageProps: (props: Record<string, unknown>) => {
                props: {
                    src: string;
                    srcSet?: string;
                    sizes?: string;
                    [k: string]: unknown;
                };
            };
        }>("dist/shims/image.js");
        const loader = ({ src, width }: { src: string; width: number }) =>
            `${src}?w=${width}`;
        const fill = mod.getImageProps({
            alt: "f",
            src: "/logo.png",
            fill: true,
            loader,
        }).props;
        // No intrinsic width: every device size is offered and sizes defaults.
        expect(fill.sizes).toBe("100vw");
        expect(fill.srcSet?.split(", ").length).toBeGreaterThan(2);
        expect(fill.srcSet).toContain("/logo.png?w=640 640w");
        expect(fill.src.startsWith("/logo.png?w=")).toBe(true);

        // data: and empty sources never reach the loader.
        const inline = mod.getImageProps({
            alt: "d",
            src: "data:image/gif;base64,AAAA",
            width: 10,
            height: 10,
            loader,
        }).props;
        expect(inline.src).toBe("data:image/gif;base64,AAAA");
        expect(inline.srcSet).toBeUndefined();

        const over = mod.getImageProps({
            alt: "o",
            src: "/logo.png",
            width: 200,
            height: 200,
            loader,
            overrideSrc: "/override.png",
        }).props;
        expect(over.src).toBe("/override.png");

        const withSrcSet = mod.getImageProps({
            alt: "s",
            src: "/logo.png",
            width: 200,
            height: 200,
            loader,
            srcSet: "/caller.png 1x",
        }).props;
        expect(withSrcSet.srcSet).not.toContain("caller.png");
        // src is emitted after srcSet/sizes, as in Next.js (Safari fetches
        // `src` early otherwise).
        const keys = Object.keys(withSrcSet);
        expect(keys.indexOf("src")).toBeGreaterThan(keys.indexOf("srcSet"));
    });

    it("vinext#3687 (site A, resolveConfigValue): a CJS function-form next.config gets the real pageExtensions default, not an empty object", async () => {
        applyVinextPatches(patched);
        const mod = await importPatched<{
            loadNextConfig: (
                root: string,
            ) => Promise<{ pageExtensions?: string[] } | null>;
        }>("dist/config/next-config.js");
        const tmpDir = mkdtempSync(join(tmpdir(), "knext-vp-pageext-cjs-"));
        try {
            // Ported from Next.js: test/e2e/custom-page-extension/next.config.js
            // A plain CommonJS next.config.js: vinext's Vite-runner virtual-module
            // loader (site B, below) throws evaluating `module.exports` as ESM and
            // falls back to `loadConfigViaRequire` -> `resolveConfigValue` (site A),
            // so this exercises ONLY site A's `{ defaultConfig: {} }` call.
            writeFileSync(
                join(tmpDir, "next.config.js"),
                "module.exports = (phase, { defaultConfig }) => ({\n" +
                    "  pageExtensions: [...defaultConfig.pageExtensions, 'page.js'],\n" +
                    "});\n",
            );
            const config = await mod.loadNextConfig(tmpDir);
            expect(config?.pageExtensions).toEqual([
                "tsx",
                "ts",
                "jsx",
                "js",
                "page.js",
            ]);
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("vinext#3687 (site B, the virtual-module loader): a .ts function-form next.config gets the real pageExtensions default, not an empty object", async () => {
        applyVinextPatches(patched);
        const mod = await importPatched<{
            loadNextConfig: (
                root: string,
            ) => Promise<{ pageExtensions?: string[] } | null>;
        }>("dist/config/next-config.js");
        const tmpDir = mkdtempSync(join(tmpdir(), "knext-vp-pageext-ts-"));
        try {
            symlinkSync(
                join(PKG_ROOT, "node_modules"),
                join(tmpDir, "node_modules"),
                "junction",
            );
            writeFileSync(
                join(tmpDir, "package.json"),
                JSON.stringify({ type: "module" }),
            );
            // A .ts function-form config is valid ESM (unlike the CJS .js
            // fixture above), so vinext's Vite-runner `runnerImport` of the
            // generated virtual module (site B) succeeds on its own and never
            // falls back to `loadConfigViaRequire` -- this exercises ONLY
            // site B's embedded `{ defaultConfig: {} }` template literal.
            writeFileSync(
                join(tmpDir, "next.config.ts"),
                "export default (phase: string, { defaultConfig }: { defaultConfig: { pageExtensions?: string[] } }) => ({\n" +
                    '  pageExtensions: [...(defaultConfig.pageExtensions ?? []), "page.ts"],\n' +
                    "});\n",
            );
            const config = await mod.loadNextConfig(tmpDir);
            expect(config?.pageExtensions).toEqual([
                "tsx",
                "ts",
                "jsx",
                "js",
                "page.ts",
            ]);
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("vinext#3688: a page that imports a hashbang-prefixed CJS module builds", async () => {
        applyVinextPatches(patched);
        // `patched` is a full copy of the installed vinext package (a
        // sibling of the real one inside the same node_modules directory),
        // so a bridge file written INSIDE it resolves the bare `vite`
        // specifier exactly as vinext's own code does — see the comment on
        // `patched` above.
        const bridgePath = join(patched, "dist", "__knext_vite_bridge.mjs");
        writeFileSync(bridgePath, 'export { build } from "vite";\n');
        const { build } = await importPatched<{
            build: (config: unknown) => Promise<unknown>;
        }>("dist/__knext_vite_bridge.mjs");
        const vinextMod = await importPatched<{
            default: (options?: Record<string, unknown>) => unknown;
        }>("dist/index.js");

        const tmpDir = mkdtempSync(join(tmpdir(), "knext-vp-hashbang-"));
        try {
            // React resolves through the monorepo root's node_modules, the
            // same way resolve-alias-build.test.ts's fixture does.
            symlinkSync(
                join(PKG_ROOT, "node_modules"),
                join(tmpDir, "node_modules"),
                "junction",
            );
            writeFileSync(
                join(tmpDir, "package.json"),
                JSON.stringify({ type: "module" }),
            );
            writeFileSync(
                join(tmpDir, "next.config.mjs"),
                "export default {};\n",
            );
            // Ported from Next.js: test/e2e/hashbang/src/cases/js.js — a
            // module that starts with a hashbang and also uses
            // module.exports, so it goes through the CJS interop transform.
            writeFileSync(
                join(tmpDir, "cjs-case.js"),
                "#!/usr/env node\n\nmodule.exports = 123\n",
            );
            mkdirSync(join(tmpDir, "pages"), { recursive: true });
            writeFileSync(
                join(tmpDir, "pages", "index.js"),
                'import val from "../cjs-case.js";\nexport default function Home() { return `JS: ${val}`; }\n',
            );
            await expect(
                build({
                    root: tmpDir,
                    configFile: false,
                    plugins: [vinextMod.default({ disableAppRouter: true })],
                    logLevel: "silent",
                    build: {
                        outDir: join(tmpDir, "dist", "server"),
                        ssr: "virtual:vinext-server-entry",
                        rolldownOptions: {
                            output: { entryFileNames: "entry.js" },
                        },
                    },
                }),
            ).resolves.toBeDefined();
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    }, 60_000);
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
