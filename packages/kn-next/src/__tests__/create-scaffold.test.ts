/**
 * #407 / ADR-0041 (amends ADR-0031) — `kn-next create` must scaffold the SAME
 * guarded-instrumentation shape the in-repo `turbo gen zone` template emits, so
 * an app created through the published CLI is correct by construction rather
 * than hand-writing the #342 edge fence.
 *
 * The three invariants a generated app has to inherit (identical to the ones
 * `template-guarded-instrumentation.test.ts` pins for the turbo template):
 *
 *   1. EDGE-SAFETY (#342): `src/instrumentation.ts` is edge-clean, guards the
 *      Node-only body behind `NEXT_RUNTIME === 'nodejs'` and pulls it in via a
 *      dynamic `await import('./instrumentation-node')`. The load-bearing
 *      `IgnorePlugin` stays PLATFORM-OWNED (adapter `modifyConfig`), so the
 *      generated `next.config.ts` wires `adapterPath` and never hand-writes it.
 *   2. SEAM-ALIVE (#352/ADR-0027): `src/instrumentation-node.ts` wires the
 *      `globalThis`-anchored `@getknext/lib` seams, and `@getknext/lib` is never
 *      added to `serverExternalPackages`.
 *   3. GRADUATED GUARDS: both per-app guards ship with the generated app, and
 *      the seam guard is runnable for REAL (`test:seam` builds first and forces
 *      hard-fail mode) — a guard that can only skip is decoration (#408).
 *
 * Written RED-first: `src/cli/create.ts` did not exist, so every assertion here
 * failed on the missing module.
 */
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createMain,
    loadTemplates,
    renderScaffold,
    standalonePrefixFor,
    writeScaffold,
} from "../cli/create";

/**
 * The #408 seam-alive scanner, loaded through a runtime path (the same shape
 * `tests/seam-alive-app-coverage.test.ts` uses) — it is plain `.mjs` with no
 * declarations, so a static import would be an implicit `any`.
 */
const SCANNER = resolve(
    import.meta.dirname,
    "../../../../scripts/seam-alive-apps.mjs",
);
async function loadScanner(): Promise<{
    discoverSeamAliveApps: (root: string) => string[];
    appsRequiringSeamGuard: (root: string) => string[];
}> {
    return (await import(SCANNER)) as {
        discoverSeamAliveApps: (root: string) => string[];
        appsRequiringSeamGuard: (root: string) => string[];
    };
}

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "knext-create-"));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

/** Scaffold into `<root>/apps/<name>` (the layout QUICKSTART Step 3 prescribes). */
function scaffoldApp(name = "hello-knext"): {
    appDir: string;
    files: Map<string, string>;
} {
    // A lockfile at the temp root makes it the workspace root, exactly as Next
    // infers `outputFileTracingRoot` — the standalone output nests under the
    // app's path relative to it.
    writeFileSync(join(root, "package-lock.json"), "{}\n");
    const appDir = join(root, "apps", name);
    mkdirSync(appDir, { recursive: true });
    const files = writeScaffold({ appDir, name });
    return { appDir, files };
}

/** Top-level *static* import specifiers (dynamic `await import()` excluded). */
function topLevelStaticImportSpecifiers(source: string): string[] {
    const specs: string[] = [];
    const staticImportRe = /^\s*import\b[^;]*?from\s*['"]([^'"]+)['"]/gm;
    const sideEffectImportRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
    for (const re of [staticImportRe, sideEffectImportRe]) {
        for (const match of source.matchAll(re)) {
            specs.push(match[1]);
        }
    }
    return specs;
}

const NODE_ONLY_MODULES = [
    "@getknext/lib/clients",
    "pg",
    "@cerbos/grpc",
    "minio",
];

describe("kn-next create — edge-clean instrumentation.ts (#342/#407)", () => {
    it("emits src/instrumentation.ts and src/instrumentation-node.ts", () => {
        const { appDir } = scaffoldApp();
        expect(existsSync(join(appDir, "src", "instrumentation.ts"))).toBe(
            true,
        );
        expect(existsSync(join(appDir, "src", "instrumentation-node.ts"))).toBe(
            true,
        );
    });

    it("guards the Node-only body behind NEXT_RUNTIME === 'nodejs'", () => {
        const { appDir } = scaffoldApp();
        const src = readFileSync(
            join(appDir, "src", "instrumentation.ts"),
            "utf8",
        );
        expect(src).toMatch(
            /process\.env\.NEXT_RUNTIME\s*[!=]==?\s*['"]nodejs['"]/,
        );
        expect(src).toMatch(
            /await\s+import\s*\(\s*['"]\.\/instrumentation-node['"]\s*\)/,
        );
    });

    it.each(
        NODE_ONLY_MODULES,
    )("never top-level static-imports the Node-only module %s", (mod) => {
        const { appDir } = scaffoldApp();
        const src = readFileSync(
            join(appDir, "src", "instrumentation.ts"),
            "utf8",
        );
        expect(topLevelStaticImportSpecifiers(src)).not.toContain(mod);
    });
});

describe("kn-next create — seam-alive instrumentation-node.ts (#352/ADR-0027)", () => {
    it("exports registerNode and keeps tracing behind the default-off gate", () => {
        const { appDir } = scaffoldApp();
        const src = readFileSync(
            join(appDir, "src", "instrumentation-node.ts"),
            "utf8",
        );
        expect(src).toMatch(/export\s+function\s+registerNode\s*\(/);
        expect(src).toContain("resolveOtelOptions");
    });

    it.each([
        { mod: "@getknext/lib/clients", fn: "setPoolInstrumentor" },
        { mod: "@getknext/lib/context", fn: "setTraceIdProvider" },
        { mod: "@getknext/lib/context", fn: "setCorrelationIdProvider" },
    ])("wires the globalThis-anchored seam $fn from $mod", ({ mod, fn }) => {
        const { appDir } = scaffoldApp();
        const src = readFileSync(
            join(appDir, "src", "instrumentation-node.ts"),
            "utf8",
        );
        expect(src).toMatch(
            new RegExp(`from\\s*['"]${mod.replace(/\//g, "\\/")}['"]`),
        );
        expect(src).toContain(fn);
    });
});

describe("kn-next create — next.config wires the platform fence (#356/ADR-0031)", () => {
    it("wires adapterPath, keeps standalone output, and never hand-writes the IgnorePlugin", () => {
        const { appDir } = scaffoldApp();
        const src = readFileSync(join(appDir, "next.config.ts"), "utf8");
        expect(src).toMatch(/adapterPath\s*:/);
        expect(src).toMatch(/output:\s*['"]standalone['"]/);
        expect(src).not.toMatch(/new\s+webpack\.IgnorePlugin\s*\(/);
        expect(src).not.toMatch(/^\s*webpack\s*[:(]/m);
    });

    it("never externalizes @getknext/lib (ADR-0027: would re-split the seam state)", () => {
        const { appDir } = scaffoldApp();
        const src = readFileSync(join(appDir, "next.config.ts"), "utf8");
        const externals =
            src.match(/serverExternalPackages:\s*\[([^\]]*)\]/s)?.[1] ?? "";
        expect(externals).not.toMatch(/@getknext\/lib/);
    });

    it("ships the thin app adapter re-exporting @getknext/core/adapter", () => {
        const { appDir } = scaffoldApp();
        const src = readFileSync(join(appDir, "next-adapter.ts"), "utf8");
        expect(src).toMatch(/from\s*['"]@getknext\/core\/adapter['"]/);
    });
});

describe("kn-next create — graduated per-app guards ship with the app (#344/#408)", () => {
    it("ships instrumentation-edge-safe.test.ts with both halves of the fence", () => {
        const { appDir } = scaffoldApp();
        const guard = readFileSync(
            join(appDir, "instrumentation-edge-safe.test.ts"),
            "utf8",
        );
        expect(guard).toContain("NEXT_RUNTIME");
        expect(guard).toContain("@getknext/lib/clients");
        expect(guard).toContain("adapterPath");
        expect(guard).toContain("IgnorePlugin");
    });

    it("ships standalone-seam-alive.test.ts asserting BOTH globalThis seam keys", () => {
        const { appDir } = scaffoldApp();
        const guard = readFileSync(
            join(appDir, "standalone-seam-alive.test.ts"),
            "utf8",
        );
        expect(guard).toContain("knext.lib.clients.poolInstrumentor");
        expect(guard).toContain("knext.lib.context.state");
        expect(guard).toContain("KNEXT_REQUIRE_STANDALONE");
    });

    it("points the seam guard at the standalone path THIS app's layout produces", () => {
        // Next nests the standalone output under the app's path relative to the
        // inferred tracing root (the nearest lockfile). A guard aimed at the
        // wrong directory finds no build and SKIPS — green-by-skip, the exact
        // decoration #408 removed. So the emitted path must track the layout.
        const { appDir } = scaffoldApp("hello-knext");
        const guard = readFileSync(
            join(appDir, "standalone-seam-alive.test.ts"),
            "utf8",
        );
        expect(guard).toContain(
            ".next/standalone/apps/hello-knext/.next/server",
        );
    });

    it("emits the FLAT standalone path when the app dir IS the tracing root", () => {
        const appDir = join(root, "flat-app");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "package-lock.json"), "{}\n");
        writeScaffold({ appDir, name: "flat-app" });
        const guard = readFileSync(
            join(appDir, "standalone-seam-alive.test.ts"),
            "utf8",
        );
        expect(guard).toContain(".next/standalone/.next/server");
        expect(guard).not.toContain("standalone/flat-app/");
    });

    it("standalonePrefixFor mirrors Next's lockfile-based tracing-root inference", () => {
        writeFileSync(join(root, "pnpm-lock.yaml"), "\n");
        const nested = join(root, "apps", "z");
        mkdirSync(nested, { recursive: true });
        expect(standalonePrefixFor(nested)).toBe("apps/z/");
        expect(standalonePrefixFor(root)).toBe("");
    });
});

describe("kn-next create — the generated package.json is runnable OUTSIDE this monorepo", () => {
    it("builds with `next build --webpack` and declares no workspace: protocol deps", () => {
        const { appDir } = scaffoldApp();
        const raw = readFileSync(join(appDir, "package.json"), "utf8");
        const pkg = JSON.parse(raw) as {
            scripts?: Record<string, string>;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        expect(pkg.scripts?.build).toBe("next build --webpack");
        expect(raw).not.toContain("workspace:");
        // @getknext/ui is PRIVATE and never publishes — a generated app that
        // depends on it cannot install.
        expect(raw).not.toContain("@getknext/ui");
    });

    it("declares the packages the generated instrumentation imports", () => {
        const { appDir } = scaffoldApp();
        const pkg = JSON.parse(
            readFileSync(join(appDir, "package.json"), "utf8"),
        ) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const declared = { ...pkg.dependencies, ...pkg.devDependencies };
        for (const dep of [
            "@getknext/core",
            "@getknext/lib",
            "@vercel/otel",
            "prom-client",
            "next",
        ]) {
            expect(Object.hasOwn(declared, dep), `missing dep ${dep}`).toBe(
                true,
            );
        }
    });

    it("ships a `test:seam` script that BUILDS and then hard-fails (no green-by-skip)", () => {
        const { appDir } = scaffoldApp();
        const pkg = JSON.parse(
            readFileSync(join(appDir, "package.json"), "utf8"),
        ) as { scripts?: Record<string, string> };
        const script = pkg.scripts?.["test:seam"];
        expect(script, "generated app has no test:seam script").toBeDefined();
        expect(script).toContain("next build --webpack");
        expect(script).toContain("KNEXT_REQUIRE_STANDALONE=1");
        expect(script).toContain("standalone-seam-alive.test.ts");
    });

    it("declares every binary `test:seam` invokes (no root-hoisting rescue outside a monorepo)", () => {
        const { appDir } = scaffoldApp();
        const manifest = JSON.parse(
            readFileSync(join(appDir, "package.json"), "utf8"),
        ) as {
            scripts?: Record<string, string>;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        const script = manifest.scripts?.["test:seam"] ?? "";
        const declared = {
            ...manifest.dependencies,
            ...manifest.devDependencies,
        };
        const binaries = script
            .split(/&&|\|\||;|\|/)
            .map((segment) =>
                segment
                    .trim()
                    .split(/\s+/)
                    .find((token) => !/^[A-Z_][A-Z0-9_]*=/.test(token)),
            )
            .filter((bin): bin is string => Boolean(bin));
        expect(binaries.length).toBeGreaterThan(0);
        for (const bin of binaries) {
            expect(
                Object.hasOwn(declared, bin),
                `test:seam runs \`${bin}\` but the scaffold never declares it`,
            ).toBe(true);
        }
    });

    it("the Dockerfile copies the SAME standalone path the seam guard asserts", () => {
        // One layout inference, two consumers. If they disagree, either the
        // image has no server.js or the guard silently skips.
        const { appDir } = scaffoldApp("hello-knext");
        const dockerfile = readFileSync(join(appDir, "Dockerfile"), "utf8");
        expect(dockerfile).toContain("apps/hello-knext/.next/standalone");
        expect(dockerfile).toContain("apps/hello-knext/server.js");
    });
});

describe("kn-next create — the CLI entry (createMain)", () => {
    /** Capture what createMain writes to stdout/stderr for one invocation. */
    async function capture(
        argv: string[],
    ): Promise<{ code: number; out: string; err: string }> {
        let out = "";
        let err = "";
        const outSpy = vi
            .spyOn(process.stdout, "write")
            .mockImplementation((chunk) => {
                out += String(chunk);
                return true;
            });
        const errSpy = vi
            .spyOn(process.stderr, "write")
            .mockImplementation((chunk) => {
                err += String(chunk);
                return true;
            });
        try {
            const code = await createMain(argv);
            return { code, out, err };
        } finally {
            outSpy.mockRestore();
            errSpy.mockRestore();
        }
    }

    it("--help exits 0 and documents the scaffolded guards", async () => {
        const { code, out } = await capture(["--help"]);
        expect(code).toBe(0);
        expect(out).toContain("kn-next create");
        expect(out).toContain("standalone-seam-alive");
        expect(out).toContain("--dry-run");
    });

    it("an unknown flag is a hard error, never a silent default", async () => {
        const { code, err } = await capture(["--not-a-flag"]);
        expect(code).toBe(1);
        expect(err).toContain("kn-next create");
    });

    it("scaffolds into the positional directory and reports the files", async () => {
        const appDir = join(root, "apps", "cli-made");
        mkdirSync(appDir, { recursive: true });
        const { code, out } = await capture([appDir]);
        expect(code).toBe(0);
        expect(out).toContain("src/instrumentation.ts");
        expect(existsSync(join(appDir, "src", "instrumentation-node.ts"))).toBe(
            true,
        );
    });

    it("--dry-run reports the file list without writing anything", async () => {
        const appDir = join(root, "apps", "cli-dry");
        mkdirSync(appDir, { recursive: true });
        const { code, out } = await capture([appDir, "--dry-run"]);
        expect(code).toBe(0);
        expect(out).toContain("Would create");
        expect(existsSync(join(appDir, "next.config.ts"))).toBe(false);
    });

    it("returns 1 (not a throw, not a silent 0) when a file would be clobbered", async () => {
        const appDir = join(root, "apps", "cli-clash");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "next.config.ts"), "// mine\n");
        const { code } = await capture([appDir]);
        expect(code).toBe(1);
        expect(readFileSync(join(appDir, "next.config.ts"), "utf8")).toBe(
            "// mine\n",
        );
        // …and --force is the documented escape hatch.
        const forced = await capture([appDir, "--force"]);
        expect(forced.code).toBe(0);
    });

    it("--name overrides the directory-derived app name", async () => {
        const appDir = join(root, "apps", "dir-name");
        mkdirSync(appDir, { recursive: true });
        await capture([appDir, "--name", "chosen-name"]);
        const pkg = JSON.parse(
            readFileSync(join(appDir, "package.json"), "utf8"),
        ) as { name?: string };
        expect(pkg.name).toBe("chosen-name");
    });
});

describe("kn-next create — the renderer leaves no unsubstituted placeholder", () => {
    it("no emitted file contains a `{{ … }}` template placeholder", () => {
        const { files } = scaffoldApp();
        const leftovers = [...files.entries()]
            .filter(([, content]) => content.includes("{{"))
            .map(([rel]) => rel);
        expect(
            leftovers,
            "template placeholders survived into the generated app",
        ).toEqual([]);
    });

    it("renderScaffold THROWS on a MALFORMED placeholder the substitution regex cannot match", () => {
        // The belt (`unknown variable`) only sees well-formed `{{ name }}`. The
        // braces guard is the braces — a stray `{{ }}` or `{{9}}` would sail
        // through the replace and land, literally, in a user's app.
        expect(() =>
            renderScaffold({
                name: "x",
                standalonePrefix: "",
                version: "0.0.0",
                templates: new Map([["a.ts", "const a = '{{ }}';\n"]]),
            }),
        ).toThrow(/unsubstituted template placeholder/);
    });

    it("loadTemplates THROWS when the shipped templates directory is absent", () => {
        // The published-package failure mode: `files` forgot `templates`.
        expect(() => loadTemplates(join(root, "no-such-templates"))).toThrow(
            /templates not found/,
        );
    });

    it("renderScaffold THROWS on an unknown placeholder rather than emitting it", () => {
        expect(() =>
            renderScaffold({
                name: "x",
                standalonePrefix: "",
                version: "0.0.0",
                templates: new Map([["a.ts", "const a = '{{ nope }}';\n"]]),
            }),
        ).toThrow(/nope/);
    });
});

describe("kn-next create — file safety", () => {
    it("refuses to overwrite an existing file unless --force", () => {
        const { appDir } = scaffoldApp();
        writeFileSync(join(appDir, "next.config.ts"), "// mine\n");
        expect(() => writeScaffold({ appDir, name: "hello-knext" })).toThrow(
            /next\.config\.ts/,
        );
        expect(readFileSync(join(appDir, "next.config.ts"), "utf8")).toBe(
            "// mine\n",
        );
        writeScaffold({ appDir, name: "hello-knext", force: true });
        expect(readFileSync(join(appDir, "next.config.ts"), "utf8")).toContain(
            "adapterPath",
        );
    });

    it("dryRun writes nothing but reports the same file set", () => {
        const appDir = join(root, "apps", "dry");
        mkdirSync(appDir, { recursive: true });
        const planned = writeScaffold({ appDir, name: "dry", dryRun: true });
        expect(planned.size).toBeGreaterThan(0);
        for (const rel of planned.keys()) {
            expect(existsSync(join(appDir, rel)), `${rel} was written`).toBe(
                false,
            );
        }
    });
});

describe("kn-next create — a generated app is COVERED by the seam-guard CI matrix (#408)", () => {
    it("appears in BOTH appsRequiringSeamGuard and discoverSeamAliveApps", async () => {
        const { appsRequiringSeamGuard, discoverSeamAliveApps } =
            await loadScanner();
        // The per-app seam matrix asserts that every app which NEEDS the guard
        // CARRIES it. Scaffolding into `apps/<name>` must therefore land on the
        // covered side of that difference, never open a coverage hole.
        const { appDir } = scaffoldApp("scaffolded");
        expect(existsSync(appDir)).toBe(true);
        expect(appsRequiringSeamGuard(root)).toContain("scaffolded");
        expect(discoverSeamAliveApps(root)).toContain("scaffolded");
    });
});
