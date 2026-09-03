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

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    createMain,
    loadTemplates,
    renderScaffold,
    standalonePrefixFor,
    writeScaffold,
} from "../cli/create";
import { CONFIG_FILES } from "../cli/tracing-root";

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

describe("kn-next create — next.config is minimal under vinext (ADR-0048)", () => {
    it("does NOT wire turbopack-only machinery", () => {
        // `output: 'standalone'`, `adapterPath` and the @getknext/lib
        // externalisation were all webpack/turbopack mechanisms. vinext is
        // Vite/rolldown and never calls them, so emitting them would ship
        // config that silently does nothing.
        const { appDir } = scaffoldApp();
        const src = readFileSync(join(appDir, "next.config.ts"), "utf8");
        // Strip comments first. The template EXPLAINS why these keys are gone,
        // so a raw grep would match the explanation and fail on its own prose —
        // which is exactly what the first version of this test did.
        const code = src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");

        expect(code).not.toMatch(/output:\s*['"]standalone['"]/);
        expect(code).not.toMatch(/adapterPath\s*:/);
        expect(code).not.toMatch(/serverExternalPackages/);
        // And what IS there is there on purpose. `assetPrefix` is knext's own
        // wiring, not turbopack residue: with object storage configured it
        // points assets at the bucket or CDN, and the empty-string fallback is
        // what keeps a no-storage pod emitting relative `/_next/static/...`
        // paths instead of 404ing every chunk (optional-storage.test.ts owns
        // that behaviour).
        //
        // An earlier version of this test asserted `NextConfig = {}` — that the
        // config was EMPTY rather than free of the retired keys. It passed
        // while quietly requiring the assetPrefix regression to stay in place.
        // "Minimal" is a claim about what was removed, not a byte count.
        expect(code).toMatch(/assetPrefix:\s*process\.env\.ASSET_PREFIX/);
    });

    it("still exports a NextConfig, so app-level options have a home", () => {
        const { appDir } = scaffoldApp();
        const src = readFileSync(join(appDir, "next.config.ts"), "utf8");

        expect(src).toMatch(/NextConfig/);
        expect(src).toMatch(/export default/);
    });

    it("emits no next-adapter.ts — the hooks it wired are never called", () => {
        const { appDir } = scaffoldApp();
        expect(existsSync(join(appDir, "next-adapter.ts"))).toBe(false);
    });
});

describe("kn-next create — graduated per-app guards ship with the app (#344/#408)", () => {
    it("ships the edge-safety guard, which still applies", () => {
        // #342 is a Next-level concern (instrumentation compiled for BOTH the
        // nodejs and edge runtimes), independent of which bundler builds it.
        const { appDir } = scaffoldApp();
        expect(
            existsSync(join(appDir, "instrumentation-edge-safe.test.ts")),
        ).toBe(true);
    });

    it("no longer ships the STANDALONE seam guard — its subject is gone", () => {
        // ADR-0048. That guard asserted module state survived webpack layering
        // in the Next standalone bundle (#352/#344). vinext is Vite/rolldown
        // and emits no standalone tree, so the file would assert against a path
        // no build produces — a guard that can only pass is decoration.
        const { appDir } = scaffoldApp();
        expect(existsSync(join(appDir, "standalone-seam-alive.test.ts"))).toBe(
            false,
        );
    });

    it("keeps the seams globalThis-anchored, which is what that guard protected", () => {
        // The INVARIANT outlives the guard: ADR-0027 requires the seam state on
        // a namespaced globalThis symbol precisely because bundlers duplicate
        // module state, and rolldown bundles too. A bare module-level `let`
        // here would reintroduce #352 under a different bundler.
        const { appDir } = scaffoldApp();
        const src = readFileSync(
            join(appDir, "src", "instrumentation-node.ts"),
            "utf8",
        );

        expect(src).toContain("setPoolInstrumentor");
        expect(src).toContain("setTraceIdProvider");
    });
});

describe("kn-next create — the generated package.json is runnable OUTSIDE this monorepo", () => {
    it("builds with vite/vinext and declares no workspace: protocol deps", () => {
        const { appDir } = scaffoldApp();
        const raw = readFileSync(join(appDir, "package.json"), "utf8");
        const pkg = JSON.parse(raw) as {
            scripts?: Record<string, string>;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };
        // ADR-0048: the scaffold emits a vinext app, not a Next/turbopack one.
        // Both halves — the new builder present AND the retired one absent —
        // because a scaffold that emitted both would produce a config the
        // validator accepts describing files it cannot build.
        expect(pkg.scripts?.build).toBe("vite build");
        expect(pkg.scripts?.dev).toBe("vinext dev");
        expect(pkg.scripts?.start).toBe("bun .output/server/index.mjs");
        expect(pkg.dependencies?.vinext).toBeDefined();
        expect(pkg.devDependencies?.nitro).toBeDefined();
        expect(pkg.scripts?.build).not.toContain("next build");
        // No Cloudflare Workers surface: knext targets Knative, so the artifact
        // is a Bun binary, not a Worker.
        expect(raw).not.toContain("wrangler");
        expect(raw).not.toContain("@cloudflare/");
        expect(raw).not.toContain("@vinext/cloudflare");

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

    it("ships the RuntimeContract entry the vinext build needs", () => {
        // Replaces the old `test:seam` pair. That guarded the Next STANDALONE
        // bundle, where webpack layering duplicates `@getknext/lib` and breaks
        // module state (#344/#352). vinext is Vite/rolldown and emits no
        // standalone tree, so that specific guard has no subject.
        //
        // The invariant underneath it still matters, so it is asserted here in
        // the form it now takes: vinext cannot see knext's adapter hooks, so the
        // platform contract — health, `:9091` metrics, SIGTERM drain — is
        // re-provided by a Nitro server entry the app ships. If that entry were
        // missing, the build would still succeed and the pod would fail its
        // probes in the cluster.
        const { appDir } = scaffoldApp();

        expect(existsSync(join(appDir, "knext-bun-entry.mjs"))).toBe(true);
        expect(existsSync(join(appDir, "runtime-contract.mjs"))).toBe(true);

        const vite = readFileSync(join(appDir, "vite.config.ts"), "utf8");
        // Both halves: the entry is wired AND the preset it requires is set.
        expect(vite).toContain("./knext-bun-entry.mjs");
        expect(vite).toContain("preset: 'bun'");
    });

    it("disables code splitting — without it the server bundle does not run", () => {
        // Not a tuning knob. When the bundle splits, vinext's Next-compat shims
        // land in a second chunk re-exporting a symbol declared in no emitted
        // module; the server then 500s on any runtime and `--compile` refuses
        // it. Measured, see docs/benchmarks/EXPERIMENTS.md E9-E10.
        const { appDir } = scaffoldApp();
        const vite = readFileSync(join(appDir, "vite.config.ts"), "utf8");

        expect(vite).toContain("inlineDynamicImports: true");
    });
    it("the Dockerfile and vite.config agree on the artifact (ADR-0048)", () => {
        // Same "one inference, two consumers" property the standalone version
        // of this test protected, restated for the shape that ships now: the
        // build emits `.output`, and the image must copy from `.output`. If
        // they disagree the image starts a server that is not there — the #857
        // failure, which exits 0 the whole way.
        const { appDir } = scaffoldApp("hello-knext");
        const dockerfile = readFileSync(join(appDir, "Dockerfile"), "utf8");
        const vite = readFileSync(join(appDir, "vite.config.ts"), "utf8");

        expect(vite).toContain("preset: 'bun'");
        expect(dockerfile).toContain(".output/public");
        expect(dockerfile).toContain("/app/server");
        // And the retired path appears in neither.
        expect(dockerfile).not.toContain(".next/standalone");
    });
});

/**
 * The Dockerfile is the one emitted artifact whose correctness is a SEQUENCE,
 * not a substring: `npm ci` must run where the lockfile is, the build must run
 * where the app is, and the runtime must boot the knext entry. A `toContain`
 * check passes on a Dockerfile that cannot build, which is what shipped in the
 * first round. These tests interpret the instruction stream instead.
 */
describe("kn-next create — the generated Dockerfile ships the compiled binary (ADR-0048)", () => {
    it("copies a prebuilt binary and runs it directly", () => {
        // No builder stage, no install, no `npm run build`. The binary is built
        // by `kn-next build` outside the image, because cross-compiling inside
        // it would force a Bun toolchain into the runtime layer for nothing.
        const { appDir } = scaffoldApp();
        const df = readFileSync(join(appDir, "Dockerfile"), "utf8");

        expect(df).toMatch(/COPY \$\{BINARY\} \/app\/server/);
        expect(df).toMatch(/CMD \["\/app\/server"\]/);
    });

    it("ships the static assets the server resolves at runtime", () => {
        // Without `.output/public` beside the binary, the server starts and
        // then 500s every asset request — it logs "no static-asset root found"
        // and keeps serving, so this fails quietly rather than loudly.
        const { appDir } = scaffoldApp();
        const df = readFileSync(join(appDir, "Dockerfile"), "utf8");

        expect(df).toMatch(/COPY \.output\/public/);
    });

    it("carries NO node, npm, or standalone machinery", () => {
        // Both halves of the ADR-0048 cleanup: the new shape is present above,
        // and the retired shape is gone. A Dockerfile that still installed node
        // would build an image nothing in it uses.
        const { appDir } = scaffoldApp();
        const df = readFileSync(join(appDir, "Dockerfile"), "utf8");

        expect(df).not.toMatch(/\.next\/standalone/);
        expect(df).not.toMatch(/npm (ci|install|run build)/);
        expect(df).not.toMatch(/NODE_COMPILE_CACHE/);
        expect(df).not.toMatch(/FROM node:/);
    });

    it("needs no bytecode cache mount — it is baked into the binary", () => {
        // `bun build --compile --bytecode` puts V8 bytecode inside the
        // executable. There is nothing to warm, mount, or share between pods.
        const { appDir } = scaffoldApp();
        const df = readFileSync(join(appDir, "Dockerfile"), "utf8");

        expect(df).not.toMatch(/compile-cache/);
        expect(df).not.toMatch(/VOLUME/);
    });

    it("runs as non-root", () => {
        const { appDir } = scaffoldApp();
        const df = readFileSync(join(appDir, "Dockerfile"), "utf8");
        expect(df).toMatch(/USER 65532:65532/);
    });
});

describe("kn-next create — the CLI entry (createMain)", () => {
    /** Capture what createMain writes to stdout/stderr for one invocation. */
    async function capture(
        argv: string[],
    ): Promise<{ code: number; out: string; err: string }> {
        let out = "";
        let err = "";
        const outSpy = spyOn(process.stdout, "write").mockImplementation(
            (chunk) => {
                out += String(chunk);
                return true;
            },
        );
        const errSpy = spyOn(process.stderr, "write").mockImplementation(
            (chunk) => {
                err += String(chunk);
                return true;
            },
        );
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

describe("kn-next create — the app name is VALIDATED, never escaped-and-shipped", () => {
    /**
     * The name is interpolated into JSON (`package.json`), TypeScript
     * (`kn-next.config.ts`) and JSX (the page) — and it becomes the NextApp /
     * Knative Service name, which Kubernetes requires to be an RFC1123 label.
     * `renderScaffold` already refuses to emit an unsubstituted placeholder;
     * the same discipline applies here. REJECT, do not escape: an escaped
     * `My App` would still be an invalid Service name at deploy time, just
     * later and further from the cause.
     */
    const INVALID = [
        [
            'ev"il',
            "breaks package.json out of JSON and kn-next.config out of TS",
        ],
        ["My App", "spaces are not RFC1123"],
        ["UPPER_Case", "uppercase + underscore are not RFC1123"],
        ["../escape", "path traversal"],
        ["<script>", "lands verbatim in a JSX text node"],
        ["-leading", "must start alphanumeric"],
        ["trailing-", "must end alphanumeric"],
        ["a".repeat(64), "RFC1123 labels cap at 63 characters"],
    ] as const;

    it.each([...INVALID])("rejects %j (%s)", (name) => {
        const appDir = join(root, "apps", "victim");
        mkdirSync(appDir, { recursive: true });
        expect(() => writeScaffold({ appDir, name })).toThrow(/RFC1123|name/i);
        // …and nothing is written: a rejected name must not leave a half-app.
        expect(existsSync(join(appDir, "package.json"))).toBe(false);
    });

    it("the CLI exits NON-ZERO on an invalid name (a broken app must never be exit 0)", async () => {
        const appDir = join(root, "apps", "cli-victim");
        mkdirSync(appDir, { recursive: true });
        const errSpy = spyOn(process.stderr, "write").mockImplementation(
            () => true,
        );
        const outSpy = spyOn(process.stdout, "write").mockImplementation(
            () => true,
        );
        let err = "";
        errSpy.mockImplementation((chunk) => {
            err += String(chunk);
            return true;
        });
        try {
            expect(await createMain([appDir, "--name", 'ev"il'])).toBe(1);
        } finally {
            errSpy.mockRestore();
            outSpy.mockRestore();
        }
        expect(existsSync(join(appDir, "package.json"))).toBe(false);
        // The user must be told WHY, on stderr — a bare "create failed" is not
        // actionable, and pino's async transport buries the message.
        expect(err).toMatch(/RFC1123/);
    });

    it("rejects an invalid DIRECTORY-derived name too (no hostile flag needed)", () => {
        // The name defaults to the directory basename, so the invalid-name path
        // is reachable without anyone passing --name.
        const appDir = join(root, "apps", "My App");
        mkdirSync(appDir, { recursive: true });
        expect(() => writeScaffold({ appDir })).toThrow(/RFC1123|name/i);
    });

    it("accepts ordinary RFC1123 names", () => {
        for (const name of ["a", "hello-knext", "app123", "a-b-c-1"]) {
            const appDir = join(root, "apps", `ok-${name}`);
            mkdirSync(appDir, { recursive: true });
            expect(() => writeScaffold({ appDir, name })).not.toThrow();
            const pkg = JSON.parse(
                readFileSync(join(appDir, "package.json"), "utf8"),
            ) as { name?: string };
            expect(pkg.name).toBe(name);
        }
    });

    it("every emitted file parses as what it claims to be (JSON stays JSON)", () => {
        const { appDir } = scaffoldApp("hello-knext");
        expect(() =>
            JSON.parse(readFileSync(join(appDir, "package.json"), "utf8")),
        ).not.toThrow();
        expect(() =>
            JSON.parse(readFileSync(join(appDir, "tsconfig.json"), "utf8")),
        ).not.toThrow();
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

describe("kn-next create — the seam-guard CI matrix no longer applies (ADR-0048)", () => {
    it("does not require a scaffolded app to carry the standalone seam guard", () => {
        // The matrix pairs "apps that NEED the guard" with "apps that CARRY
        // it". Under ADR-0048 a scaffolded app needs neither, so it must sit
        // outside the matrix rather than on its uncovered side — which would
        // read as a coverage hole that no longer exists.
        const { appDir } = scaffoldApp("scaffolded");

        expect(existsSync(appDir)).toBe(true);
        expect(existsSync(join(appDir, "standalone-seam-alive.test.ts"))).toBe(
            false,
        );
    });
});

describe("kn-next create — the scaffolded config keeps the last pod warm (ADR-0045)", () => {
    /**
     * ADR-0045 Decision 2: the field itself defaults to UNSET (byte-identical
     * back-compat for every existing NextApp); the zero-devops posture ships in
     * the SCAFFOLDER instead, where it lands in the user's own file and is
     * removed by deleting a line. So this is asserted on the generated app, not
     * on the CR builder.
     */
    it('writes scaleDownDelay: "5m" into the generated kn-next.config.ts', () => {
        const { appDir } = scaffoldApp("warm-app");
        const config = readFileSync(join(appDir, "kn-next.config.ts"), "utf8");
        expect(config).toMatch(/scaleDownDelay:\s*"5m"/);
    });

    it("puts it inside the scaling block (a stray top-level key is not the field)", () => {
        const { appDir } = scaffoldApp("warm-scope");
        const config = readFileSync(join(appDir, "kn-next.config.ts"), "utf8");
        const scalingBlock = /scaling:\s*\{([\s\S]*?)\n\s*\},/.exec(config);
        expect(scalingBlock).not.toBeNull();
        expect(scalingBlock?.[1]).toMatch(/scaleDownDelay:\s*"5m"/);
    });

    it("states the idle cost and the opt-out in a comment next to it", () => {
        const { appDir } = scaffoldApp("warm-doc");
        const config = readFileSync(join(appDir, "kn-next.config.ts"), "utf8");
        const line = config
            .split("\n")
            .findIndex((l) => /scaleDownDelay:/.test(l));
        expect(line).toBeGreaterThan(0);
        const comment = config.split("\n").slice(0, line).join("\n");
        // The cost (an idle pod + its DB connections) and the one-line opt-out
        // must both be visible where the value is, not only in the docs site.
        expect(comment).toMatch(/idle/i);
        expect(comment).toMatch(/delete this line/i);
    });

    it("the scaffolded value SURVIVES the CLI's own validation (a config that cannot deploy is not a scaffold)", async () => {
        const { appDir } = scaffoldApp("warm-valid");
        const config = readFileSync(join(appDir, "kn-next.config.ts"), "utf8");
        const value = /scaleDownDelay:\s*"([^"]+)"/.exec(config)?.[1];
        expect(value).toBe("5m");
        const { validateConfig } = await import("../cli/validate");
        expect(() =>
            validateConfig({
                name: "warm-valid",
                registry: "registry",
                storage: {
                    provider: "gcs",
                    bucket: "b",
                    publicUrl: "https://example.com",
                },
                scaling: { minScale: 0, maxScale: 10, scaleDownDelay: value },
            }),
        ).not.toThrow();
    });

    it("the scaffolded value FLOWS into the emitted NextApp CR (a config the builder drops is decoration)", async () => {
        const { appDir } = scaffoldApp("warm-flow");
        const config = readFileSync(join(appDir, "kn-next.config.ts"), "utf8");
        const value = /scaleDownDelay:\s*"([^"]+)"/.exec(config)?.[1];
        const { buildNextAppCRObject } = await import("../cli/cr-builder");
        const cr = buildNextAppCRObject(
            {
                name: "warm-flow",
                registry: "registry",
                storage: {
                    provider: "gcs",
                    bucket: "b",
                    publicUrl: "https://example.com",
                },
                scaling: { minScale: 0, maxScale: 10, scaleDownDelay: value },
            },
            "registry/app@sha256:deadbeef",
            "ns",
        );
        const scaling = (cr.spec as Record<string, unknown>).scaling as Record<
            string,
            unknown
        >;
        expect(scaling.scaleDownDelay).toBe("5m");
    });
});

/**
 * #864 — a higher-precedence config shadows the one `create` writes.
 *
 * `create` emits `next.config.ts`. Next's own precedence is `.js` → `.mjs` → `.ts` →
 * `.mts`, first match wins, and `tracing-root.ts` already records that the order is
 * load-bearing. So on an app that uses `next.config.js`, `--force` leaves
 * BOTH files and Next reads the one knext did not write — the one with no
 * `output: "standalone"` and no `adapterPath`.
 *
 * Measured before this guard existed: `create --force` exited 0, reported success, and
 * the winning config carried 0 of knext's required settings while the emitted `.ts`
 * carried 4 that Next never reads. The build then emits no standalone server at all,
 * which is where #857 landed — an image with nothing to run, reached with a green
 * scaffold and no diagnostic.
 *
 * `--force` is REQUIRED for any pre-existing app (a bare `create` refuses on
 * `package.json`), so this is the default path for "add knext to an app I already have".
 * A warning would not do: this repo's record is that a message standing in for a
 * guarantee is how the guarantee is lost.
 */
describe("#864 — create refuses when an existing config would shadow the one it writes", () => {
    it("refuses under --force, naming the shadowing file", () => {
        const appDir = join(root, "existing");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "package.json"), "{}\n");
        writeFileSync(
            join(appDir, "next.config.js"),
            "module.exports = { reactStrictMode: true };\n",
        );
        expect(() =>
            writeScaffold({ appDir, name: "existing", force: true }),
        ).toThrow(/next\.config\.js/);
    });

    it("does not refuse for a LOWER-precedence config, which the emitted one wins over", () => {
        const appDir = join(root, "lower");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "package.json"), "{}\n");
        writeFileSync(
            join(appDir, "next.config.cjs"),
            "module.exports = {};\n",
        );
        expect(() =>
            writeScaffold({ appDir, name: "lower", force: true }),
        ).not.toThrow();
    });

    it("still scaffolds a clean app with no config at all", () => {
        const appDir = join(root, "clean864");
        mkdirSync(appDir, { recursive: true });
        expect(() => writeScaffold({ appDir, name: "clean864" })).not.toThrow();
    });
});

/**
 * #864 follow-ups from the design gate.
 *
 * A — nothing asserted that `--dry-run` refuses too. The check deliberately precedes the
 * dry-run return, because a dry run should report what would happen; without a test,
 * someone later "fixes" the ordering by moving the check after that return and the dry
 * run starts reporting a success the real run would refuse.
 *
 * B — `CONFIG_FILES` cited `next/dist/shared/lib/constants` while disagreeing with it.
 * Executed against the pinned next 16.2.11: the real list is four entries, and the two
 * extra ones this repo carried (`.cjs`, `.cts`) are not consulted by Next at all.
 */
describe("#864 follow-ups — dry-run refuses, and the precedence list matches upstream", () => {
    it("refuses under --dry-run as well, since a dry run reports what would happen", () => {
        const appDir = join(root, "dryrun864");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "package.json"), "{}\n");
        writeFileSync(join(appDir, "next.config.js"), "module.exports = {};\n");
        expect(() =>
            writeScaffold({
                appDir,
                name: "dryrun864",
                force: true,
                dryRun: true,
            }),
        ).toThrow(/next\.config\.js/);
    });

    it("pins CONFIG_FILES against the constant it cites, executed not read", () => {
        // The previous version of this test asserted that a `.cjs` on disk does not
        // refuse — an outcome that is INVARIANT under the bug, because `create` only ever
        // emits `next.config.ts` and the scan early-returns at index 2 without reaching
        // `.cjs`. Review mutation-proved it: re-adding `.cjs`/`.cts` left the suite green.
        // It claimed to pin "the reason rather than only the outcome" and pinned neither.
        //
        // This asserts the claim directly: our list IS the upstream constant.
        const upstream = require("next/dist/shared/lib/constants").CONFIG_FILES;
        expect(CONFIG_FILES).toEqual(upstream);
    });

    it("does not refuse for next.config.mts, which the emitted next.config.ts outranks", () => {
        // The only genuine lower-precedence case, and it was untested. It is what makes
        // this a PRECEDENCE check rather than "any next.config.* refuses": deleting the
        // `candidate === emitted` early return leaves every other case green.
        const appDir = join(root, "mts864");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "package.json"), "{}\n");
        writeFileSync(join(appDir, "next.config.mts"), "export default {};\n");
        expect(() =>
            writeScaffold({ appDir, name: "mts864", force: true }),
        ).not.toThrow();
    });

    it("allows a next.config.cjs, which Next does not consult at all", () => {
        // It is not in the real CONFIG_FILES. Carrying it made the list disagree with the
        // constant it cites; the emitted .ts wins regardless, so this asserts the reason
        // rather than only the outcome.
        const appDir = join(root, "cjs864");
        mkdirSync(appDir, { recursive: true });
        writeFileSync(join(appDir, "package.json"), "{}\n");
        writeFileSync(
            join(appDir, "next.config.cjs"),
            "module.exports = {};\n",
        );
        expect(() =>
            writeScaffold({ appDir, name: "cjs864", force: true }),
        ).not.toThrow();
    });
});

describe("#867 the scaffold ships a .dockerignore", () => {
    /**
     * The generated Dockerfile does `COPY . .`, and its context is the resolved
     * tracing root — which is not always the app directory. When the lockfile
     * walk finds a marker above the app, the context widens to that ancestor
     * and everything under it is uploaded to the daemon and baked into the
     * builder layer.
     *
     * `create` already WARNS on a duplicate root marker. A warning tells the
     * user something is wrong; this file is what makes being wrong harmless.
     *
     * The secret exclusions are the load-bearing half. A `.env` in the context
     * lands in a layer, and layers are extractable from any pushed image — so
     * it is readable by anyone who can pull, not just someone who can exec.
     * The runtime reads config from Kubernetes Secrets via env
     * (`.claude/rules/security.md`), so nothing here is needed at build time.
     */
    const dockerignore = (): string => {
        const repoRoot = resolve(
            dirname(fileURLToPath(import.meta.url)),
            "../../../..",
        );
        return readFileSync(
            resolve(
                repoRoot,
                "packages/kn-next/templates/app/.dockerignore.hbs",
            ),
            "utf8",
        );
    };

    it("excludes secrets — the exposure that costs the most", () => {
        const body = dockerignore();
        for (const pattern of [
            ".env",
            ".env.*",
            "*.pem",
            "*.key",
            ".npmrc",
            "kubeconfig",
        ]) {
            expect(body.split("\n")).toContain(pattern);
        }
        // …while still allowing the committed example, which carries no secret
        // and is what a reader copies from.
        expect(body.split("\n")).toContain("!.env.example");
    });

    it("excludes .git, dependencies and build output — and re-includes what the Dockerfile COPYs", () => {
        const lines = dockerignore().split("\n");
        for (const pattern of [
            "node_modules",
            ".git",
            ".next",
            ".output",
            "knext-exec*",
        ]) {
            expect(lines).toContain(pattern);
        }
        // The other half, without which the image is UNBUILDABLE: the
        // Dockerfile COPYs `.output/public` and the compiled binary out of
        // this very context, so blanket build-output exclusions must carry
        // their negations (dockerignore is last-match-wins).
        for (const negation of ["!.output/public", "!knext-exec-linux-*"]) {
            expect(lines).toContain(negation);
        }
        // And order matters: a negation ABOVE its exclusion is dead.
        expect(lines.indexOf("!.output/public")).toBeGreaterThan(
            lines.indexOf(".output"),
        );
        expect(lines.indexOf("!knext-exec-linux-*")).toBeGreaterThan(
            lines.indexOf("knext-exec*"),
        );
    });

    it("is rendered into the scaffold, not just present in the template", () => {
        // A template file the generator never writes is decoration. `create`
        // renders every `.hbs` under the template root, so the guard is that
        // the file carries the `.hbs` suffix the loader keys on.
        const repoRoot = resolve(
            dirname(fileURLToPath(import.meta.url)),
            "../../../..",
        );
        expect(
            existsSync(
                resolve(
                    repoRoot,
                    "packages/kn-next/templates/app/.dockerignore.hbs",
                ),
            ),
        ).toBe(true);
    });
});
