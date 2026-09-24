/**
 * sidecar-runtime.mjs: the package resolver the compiled exec uses for its
 * server-externals sidecar, CONFINED to `<dir of the binary>/.output/server/
 * node_modules` (#1320). The compiled binary is built WITHOUT
 * `autoloadPackageJson`, which widens runtime resolution beyond the sidecar;
 * this resolver is what replaces it.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
    exportsTargets,
    findPackageDir,
    installSidecarResolution,
    isBareRequest,
    REQUIRE_CONDITIONS,
    resolveInPackage,
    resolveSidecar,
    sidecarEntryFile,
    sidecarRoot,
    splitRequest,
} from "../adapters/sidecar-runtime.mjs";

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
    const d = realpathSync(mkdtempSync(join(tmpdir(), "knext-sidecar-rt-")));
    temps.push(d);
    return d;
}
function write(path: string, body: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
}
function pkg(
    dir: string,
    manifest: Record<string, unknown>,
    files: Record<string, string>,
): void {
    write(join(dir, "package.json"), JSON.stringify(manifest));
    for (const [rel, body] of Object.entries(files))
        write(join(dir, rel), body);
}

/** An app dir: binary path + sidecar, with a node_modules ABOVE the sidecar too. */
function app() {
    const base = temp();
    const exec = join(base, "app", "server");
    const root = sidecarRoot(exec);
    return { base, exec, root };
}

describe("request parsing", () => {
    it("splits scoped and unscoped requests", () => {
        expect(splitRequest("typescript")).toEqual({
            name: "typescript",
            subpath: ".",
        });
        expect(splitRequest("a/b/c.js")).toEqual({
            name: "a",
            subpath: "./b/c.js",
        });
        expect(splitRequest("@s/n")).toEqual({ name: "@s/n", subpath: "." });
        expect(splitRequest("@s/n/x")).toEqual({
            name: "@s/n",
            subpath: "./x",
        });
    });

    it("only bare, non-builtin requests are handled", () => {
        for (const r of ["typescript", "@s/n", "a/b"])
            expect(isBareRequest(r), r).toBe(true);
        for (const r of [
            "./x",
            "../x",
            "/abs",
            "node:fs",
            "fs",
            "fs/promises",
            "bun",
            "bun:sqlite",
            "file:///x",
            "",
        ]) {
            expect(isBareRequest(r), r).toBe(false);
        }
    });

    it("anchors the sidecar at the binary's directory", () => {
        expect(sidecarRoot("/app/server")).toBe(
            join("/app", ".output", "server", "node_modules"),
        );
    });
});

describe("package entry resolution", () => {
    it("reads exports: string, conditions (first existing target wins), subpaths and patterns", () => {
        expect(exportsTargets("./i.js", ".", REQUIRE_CONDITIONS)).toEqual([
            "./i.js",
        ]);
        expect(
            exportsTargets(
                {
                    ".": {
                        import: "./m.mjs",
                        require: "./c.cjs",
                        default: "./d.js",
                    },
                },
                ".",
                REQUIRE_CONDITIONS,
            ),
        ).toEqual(["./c.cjs", "./d.js"]);
        expect(
            exportsTargets({ "./sub": "./s.js" }, "./sub", REQUIRE_CONDITIONS),
        ).toEqual(["./s.js"]);
        expect(
            exportsTargets(
                { "./f/*": "./dist/*.js" },
                "./f/a/b",
                REQUIRE_CONDITIONS,
            ),
        ).toEqual(["./dist/a/b.js"]);
        expect(
            exportsTargets(
                { "./sub": "./s.js" },
                "./other",
                REQUIRE_CONDITIONS,
            ),
        ).toEqual([]);
    });

    it("falls through an untraced target to the next one that exists", () => {
        const dir = join(temp(), "p");
        pkg(
            dir,
            {
                exports: {
                    ".": { require: "./missing.cjs", default: "./ok.js" },
                },
            },
            { "ok.js": "" },
        );
        expect(resolveInPackage(dir, ".", REQUIRE_CONDITIONS)).toBe(
            join(dir, "ok.js"),
        );
    });

    it("exports encapsulate: an unexported subpath does not resolve, even if the file exists", () => {
        const dir = join(temp(), "p");
        pkg(
            dir,
            { exports: { ".": "./i.js" } },
            { "i.js": "", "secret.js": "" },
        );
        expect(
            resolveInPackage(dir, "./secret.js", REQUIRE_CONDITIONS),
        ).toBeNull();
    });

    it("uses main with extension and index probing, then index, then plain subpaths", () => {
        const t = temp();
        pkg(
            join(t, "a"),
            { main: "./lib/typescript" },
            { "lib/typescript.js": "" },
        );
        pkg(join(t, "b"), { main: "dist" }, { "dist/index.js": "" });
        pkg(join(t, "c"), {}, { "index.js": "" });
        pkg(join(t, "d"), {}, { "x/y.json": "{}" });
        expect(resolveInPackage(join(t, "a"), ".", REQUIRE_CONDITIONS)).toBe(
            join(t, "a", "lib", "typescript.js"),
        );
        expect(resolveInPackage(join(t, "b"), ".", REQUIRE_CONDITIONS)).toBe(
            join(t, "b", "dist", "index.js"),
        );
        expect(resolveInPackage(join(t, "c"), ".", REQUIRE_CONDITIONS)).toBe(
            join(t, "c", "index.js"),
        );
        expect(
            resolveInPackage(join(t, "d"), "./x/y", REQUIRE_CONDITIONS),
        ).toBe(join(t, "d", "x", "y.json"));
    });
});

describe("confinement to the sidecar", () => {
    it("never resolves a package that exists only above the sidecar (the binary's dir, its parents)", () => {
        const { base, exec, root } = app();
        pkg(
            join(dirname(exec), "node_modules", "above"),
            { main: "i.js" },
            { "i.js": "" },
        );
        pkg(
            join(base, "node_modules", "above"),
            { main: "i.js" },
            { "i.js": "" },
        );
        pkg(join(root, "inside"), { main: "i.js" }, { "i.js": "" });
        expect(resolveSidecar("above", undefined, root)).toBeNull();
        expect(
            resolveSidecar("above", join(root, "inside", "i.js"), root),
        ).toBeNull();
        expect(resolveSidecar("inside", undefined, root)).toBe(
            join(root, "inside", "i.js"),
        );
    });

    it("walks nested node_modules inside the sidecar, nearest first, like Node", () => {
        const { root } = app();
        pkg(join(root, "dep"), { main: "top.js" }, { "top.js": "" });
        pkg(
            join(root, "user", "node_modules", "dep"),
            { main: "nested.js" },
            { "nested.js": "" },
        );
        pkg(join(root, "user"), { main: "u.js" }, { "u.js": "" });
        pkg(join(root, "other"), { main: "o.js" }, { "o.js": "" });
        expect(findPackageDir("dep", join(root, "user", "u.js"), root)).toBe(
            join(root, "user", "node_modules", "dep"),
        );
        expect(findPackageDir("dep", join(root, "other", "o.js"), root)).toBe(
            join(root, "dep"),
        );
        // a requester outside the sidecar (bundled code) sees only the top level
        expect(findPackageDir("dep", "/$bunfs/root/server", root)).toBe(
            join(root, "dep"),
        );
    });

    it("rejects relative segments in a request, even when the path would stay inside the sidecar", () => {
        const { exec, root } = app();
        pkg(
            join(root, "good"),
            { main: "i.js" },
            { "i.js": "", "sub/x.js": "" },
        );
        pkg(join(root, "sibling"), { main: "i.js" }, { "i.js": "" });
        write(join(dirname(exec), "outside", "esc.js"), "");
        for (const r of [
            "good/../../../outside/esc.js",
            "good/../sibling/i.js",
            "good/./sub/x.js",
            "good/sub/../i.js",
            "@x/../good",
        ]) {
            expect(resolveSidecar(r, undefined, root), r).toBeNull();
            expect(
                resolveSidecar(r, join(root, "good", "i.js"), root),
                r,
            ).toBeNull();
        }
        expect(resolveSidecar("good/sub/x.js", undefined, root)).toBe(
            join(root, "good", "sub", "x.js"),
        );
    });

    it("rejects exports targets and pattern substitutions with relative or node_modules segments", () => {
        const { root } = app();
        pkg(
            join(root, "sibling"),
            { main: "i.js" },
            { "i.js": "", "x.js": "" },
        );
        pkg(
            join(root, "e"),
            {
                exports: {
                    ".": "./../sibling/x.js",
                    "./nm": "./node_modules/dep/x.js",
                    "./f/*": "./dist/*.js",
                },
            },
            { "dist/a.js": "", "node_modules/dep/x.js": "" },
        );
        expect(resolveSidecar("e", undefined, root)).toBeNull();
        expect(resolveSidecar("e/nm", undefined, root)).toBeNull();
        expect(
            resolveInPackage(
                join(root, "e"),
                "./f/../../sibling/x",
                REQUIRE_CONDITIONS,
            ),
        ).toBeNull();
        expect(resolveSidecar("e/f/a", undefined, root)).toBe(
            join(root, "e", "dist", "a.js"),
        );
    });

    it("never returns a file whose real path is outside the sidecar (main escaping it, symlinks)", () => {
        const { exec, root } = app();
        write(join(dirname(exec), "outside", "m.js"), "");
        pkg(join(root, "esc-main"), { main: "../../../outside/m.js" }, {});
        pkg(join(root, "esc-link"), { main: "lib/m.js" }, {});
        mkdirSync(join(root, "esc-link", "lib"), { recursive: true });
        symlinkSync(
            join(dirname(exec), "outside", "m.js"),
            join(root, "esc-link", "lib", "m.js"),
        );
        expect(resolveSidecar("esc-main", undefined, root)).toBeNull();
        expect(resolveSidecar("esc-link", undefined, root)).toBeNull();
    });

    it("the hook fails closed for a request with relative segments, from any requester", () => {
        const { root } = app();
        pkg(join(root, "good"), { main: "i.js" }, { "i.js": "" });
        const calls: string[] = [];
        const M = {
            _resolveFilename(request: string) {
                calls.push(request);
                return `ORIGINAL:${request}`;
            },
        };
        installSidecarResolution(M, root);
        for (const parent of [
            { filename: "/$bunfs/root/server" },
            { filename: join(root, "good", "i.js") },
        ]) {
            expect(() =>
                M._resolveFilename("good/../../../outside/esc.js", parent),
            ).toThrow(/Cannot find module/);
        }
        expect(calls).toEqual([]);
    });

    it("sidecarEntryFile throws (fail closed) when a present package has no resolvable entry", () => {
        const { root } = app();
        pkg(join(root, "broken"), { main: "gone.js" }, {});
        expect(() => sidecarEntryFile("broken", root)).toThrow(
            /cannot be resolved/,
        );
    });
});

describe("the Module._resolveFilename hook", () => {
    function fakeModule() {
        const calls: string[] = [];
        const M = {
            _resolveFilename(request: string) {
                calls.push(request);
                return `ORIGINAL:${request}`;
            },
        };
        return { M, calls };
    }

    it("answers bare requests the sidecar holds, from bundled code and from sidecar files", () => {
        const { root } = app();
        pkg(
            join(root, "typescript"),
            { main: "./lib/typescript.js" },
            { "lib/typescript.js": "" },
        );
        const { M } = fakeModule();
        expect(installSidecarResolution(M, root)).toBe(true);
        expect(
            M._resolveFilename("typescript", {
                filename: "/$bunfs/root/server",
            }),
        ).toBe(join(root, "typescript", "lib", "typescript.js"));
        expect(
            M._resolveFilename("typescript/package.json", {
                filename: "/$bunfs/root/server",
            }),
        ).toBe(join(root, "typescript", "package.json"));
    });

    it("fails closed for bundled code: a bare request the sidecar lacks never reaches the original resolver", () => {
        const { root } = app();
        const { M, calls } = fakeModule();
        installSidecarResolution(M, root);
        let err: { code?: string } | undefined;
        try {
            M._resolveFilename("planted", { filename: "/$bunfs/root/server" });
        } catch (e) {
            err = e as { code?: string };
        }
        expect(err?.code).toBe("MODULE_NOT_FOUND");
        expect(calls).toEqual([]);
        // no parent at all is treated the same
        expect(() => M._resolveFilename("planted", undefined)).toThrow(
            /Cannot find module 'planted'/,
        );
        expect(calls).toEqual([]);
    });

    it("delegates relative/builtin requests, and sidecar files' misses, to the original resolver", () => {
        const { root } = app();
        const { M, calls } = fakeModule();
        installSidecarResolution(M, root);
        expect(
            M._resolveFilename("./x.js", { filename: "/$bunfs/root/server" }),
        ).toBe("ORIGINAL:./x.js");
        expect(
            M._resolveFilename("node:fs", { filename: "/$bunfs/root/server" }),
        ).toBe("ORIGINAL:node:fs");
        expect(
            M._resolveFilename("missing", {
                filename: join(root, "p", "i.js"),
            }),
        ).toBe("ORIGINAL:missing");
        expect(calls).toEqual(["./x.js", "node:fs", "missing"]);
    });

    it("is idempotent", () => {
        const { root } = app();
        const { M } = fakeModule();
        installSidecarResolution(M, root);
        const once = M._resolveFilename;
        installSidecarResolution(M, root);
        expect(M._resolveFilename).toBe(once);
    });
});
