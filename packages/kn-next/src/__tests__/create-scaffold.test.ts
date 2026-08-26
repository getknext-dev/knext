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
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        // STRUCTURAL, not substring: assert the symbols appear in the ARRAY the
        // guard actually asserts over (`SEAM_SYMBOLS`), and the API pairing in
        // `SEAM_FAMILIES`. A plain `toContain` is satisfied by the docblock,
        // which names both symbols in prose — so gutting the array while
        // leaving the comments would keep a substring check green while the
        // shipped guard asserts nothing.
        const symbols =
            guard.match(/const\s+SEAM_SYMBOLS\s*=\s*\[([^\]]*)\]/s)?.[1] ?? "";
        expect(
            symbols,
            "the emitted guard has no SEAM_SYMBOLS array to assert over",
        ).not.toBe("");
        expect(symbols).toContain("knext.lib.clients.poolInstrumentor");
        expect(symbols).toContain("knext.lib.context.state");

        const families =
            guard.match(/const\s+SEAM_FAMILIES[^=]*=\s*\[(.*?)\];/s)?.[1] ?? "";
        expect(families).toContain("setPoolInstrumentor");
        expect(families).toContain("correlationLogFields");

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

    it("treats pnpm-workspace.yaml as a root marker, because Next checks it FIRST", () => {
        // This spec used to assert the opposite, and the reason it gave was wrong:
        // it said next 16.2.11 considers only the five lockfiles. It does not.
        // `dist/lib/find-root.js`'s `findWorkRoot` searches up for
        // `pnpm-workspace.yaml` BEFORE any lockfile — its own comment explains why,
        // since lockfiles "can be included in the application directory by accident".
        //
        // Asserting the divergence kept it GREEN while every path `create` baked
        // pointed at a file the build never wrote: both COPY sources, the WORKDIR,
        // the CMD's STANDALONE_SERVER_PATH and `npm start`. The image built, the
        // container started, and there was nothing to run (#857).
        writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - a\n");
        const app = join(root, "apps", "a");
        mkdirSync(app, { recursive: true });
        expect(standalonePrefixFor(app)).toBe("apps/a/");
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

/**
 * The Dockerfile is the one emitted artifact whose correctness is a SEQUENCE,
 * not a substring: `npm ci` must run where the lockfile is, the build must run
 * where the app is, and the runtime must boot the knext entry. A `toContain`
 * check passes on a Dockerfile that cannot build, which is what shipped in the
 * first round. These tests interpret the instruction stream instead.
 */
describe("kn-next create — the generated Dockerfile actually builds (structurally)", () => {
    interface Docker {
        /** WORKDIR in effect for each RUN, paired with the command. */
        runs: { cwd: string; cmd: string }[];
        copies: { from: string; src: string; dest: string }[];
        froms: string[];
        user: string | null;
        cmd: string | null;
    }

    /** Interpret the Dockerfile's instruction stream, tracking WORKDIR state. */
    function parseDockerfile(src: string): Docker {
        const out: Docker = {
            runs: [],
            copies: [],
            froms: [],
            user: null,
            cmd: null,
        };
        let cwd = "/";
        // Join line continuations so a multi-line RUN is one command.
        const lines = src
            .replace(/\\\n\s*/g, " ")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));
        for (const line of lines) {
            const [verbRaw, ...rest] = line.split(/\s+/);
            const verb = verbRaw.toUpperCase();
            const arg = rest.join(" ");
            if (verb === "FROM") {
                out.froms.push(arg);
                cwd = "/";
            } else if (verb === "WORKDIR") {
                const p = rest[0];
                // Normalise the trailing slash `/repo/{{prefix}}` leaves when
                // the prefix is empty — Docker treats `/repo/` and `/repo` the
                // same, so the parser must too.
                cwd = (p.startsWith("/") ? p : join(cwd, p)).replace(
                    /(.)\/$/,
                    "$1",
                );
            } else if (verb === "RUN") {
                out.runs.push({ cwd, cmd: arg });
            } else if (verb === "COPY") {
                const m = line.match(
                    /^COPY\s+(?:--from=(\S+)\s+)?(\S+)\s+(\S+)\s*$/i,
                );
                if (m) {
                    out.copies.push({
                        from: m[1] ?? "",
                        src: m[2],
                        dest: m[3],
                    });
                }
            } else if (verb === "USER") {
                out.user = rest[0];
            } else if (verb === "CMD") {
                out.cmd = arg;
            }
        }
        return out;
    }

    /** Scaffold at `<root>/<sub>` with the lockfile at `<lockAt>`. */
    function dockerfileFor(
        sub: string,
        lockAt: string,
        lockName = "package-lock.json",
    ): { docker: Docker; text: string; appDir: string } {
        mkdirSync(join(root, lockAt), { recursive: true });
        writeFileSync(join(root, lockAt, lockName), "{}\n");
        const appDir = join(root, sub);
        mkdirSync(appDir, { recursive: true });
        writeScaffold({ appDir, name: "hello-knext" });
        const text = readFileSync(join(appDir, "Dockerfile"), "utf8");
        return { docker: parseDockerfile(text), text, appDir };
    }

    it("runs the dependency install in the directory that HAS the lockfile (nested layout)", () => {
        // `npm ci` does not walk up. Running it in the app dir of a workspace,
        // where only the root has a package-lock.json, is a hard build failure.
        const { docker } = dockerfileFor("apps/hello-knext", ".");
        const install = docker.runs.find((r) =>
            /npm ci|npm install/.test(r.cmd),
        );
        expect(
            install,
            "no dependency-install RUN in the Dockerfile",
        ).toBeDefined();
        expect(
            (install as { cwd: string }).cwd,
            "the install must run at the build context root, where the lockfile is",
        ).toBe("/repo");
    });

    it("runs `npm run build` in the APP directory, not the context root (nested layout)", () => {
        const { docker } = dockerfileFor("apps/hello-knext", ".");
        const build = docker.runs.find((r) => /npm run build/.test(r.cmd));
        expect(build).toBeDefined();
        expect((build as { cwd: string }).cwd).toBe("/repo/apps/hello-knext");
    });

    it("FLAT layout: install AND build both run at the context root", () => {
        // App carries its own lockfile, nothing above — the layout QUICKSTART's
        // `npm ci` in the app dir implies. Here the app IS the context root, so
        // a `/repo/<prefix>` that still carried a prefix would point at nothing.
        const { docker } = dockerfileFor("flat", "flat");
        const install = docker.runs.find((r) =>
            /npm ci|npm install/.test(r.cmd),
        );
        const build = docker.runs.find((r) => /npm run build/.test(r.cmd));
        expect((install as { cwd: string }).cwd).toBe("/repo");
        expect((build as { cwd: string }).cwd).toBe("/repo");
        const standaloneCopy = docker.copies.find((c) =>
            c.src.includes(".next/standalone"),
        );
        expect((standaloneCopy as { src: string }).src).toBe(
            "/repo/.next/standalone",
        );
    });

    it("emits the install command matching the lockfile it found (pnpm ≠ npm)", () => {
        // Deriving the root from a pnpm-lock.yaml and then running `npm ci`
        // against it fails: npm cannot consume a pnpm lockfile.
        const { docker } = dockerfileFor(
            "apps/hello-knext",
            ".",
            "pnpm-lock.yaml",
        );
        const install = docker.runs.find((r) =>
            /npm ci|npm install|pnpm install|yarn install|bun install/.test(
                r.cmd,
            ),
        );
        expect((install as { cmd: string }).cmd).toMatch(/pnpm install/);
    });

    it("pins every base image by digest (security.md supply chain)", () => {
        const { docker } = dockerfileFor("apps/hello-knext", ".");
        const external = docker.froms.filter(
            (f) => !/^(builder|runner|scratch)\b/i.test(f),
        );
        expect(external.length).toBeGreaterThan(0);
        for (const from of external) {
            expect(from, `floating base image: ${from}`).toMatch(
                /@sha256:[0-9a-f]{64}/,
            );
        }
    });

    it("drops privileges to a non-root USER before CMD (security.md)", () => {
        const { docker } = dockerfileFor("apps/hello-knext", ".");
        expect(docker.user).toBe("node");
    });

    it("boots the knext runtime entry, NOT a bare `node server.js` (graceful shutdown)", () => {
        // adapters/node-server.ts is the ONLY thing that installs the SIGTERM
        // handler draining in-flight requests + running after() callbacks on
        // scale-down. Bare-exec'ing the standalone server bypasses it, so every
        // created app would ship without the graceful-shutdown invariant.
        const { docker } = dockerfileFor("apps/hello-knext", ".");
        expect(docker.cmd).toContain("@getknext/core/internal/node-server");
        expect(
            docker.cmd,
            "CMD bare-execs server.js — that bypasses the SIGTERM drain",
        ).not.toMatch(/\bnode(\\?")?\s*,?\s*(\\?")?[^"]*server\.js/);
        // The runtime entry needs to be told where the standalone server is.
        expect(docker.cmd).toContain("STANDALONE_SERVER_PATH");
        expect(docker.cmd).toContain("apps/hello-knext/server.js");
    });

    it("is covered by the repo's base-image pin guard (scan, not an enumerated list)", () => {
        // The guard's default file list used to enumerate file-manager + the
        // operator, so this template escaped it entirely — the enumerate-vs-scan
        // trap. Run the guard with NO arguments and assert it reached this file.
        const out = execFileSync(
            "bash",
            [
                resolve(
                    import.meta.dirname,
                    "../../../../scripts/check-base-images-pinned.sh",
                ),
            ],
            { encoding: "utf8" },
        );
        expect(out).toContain("packages/kn-next/templates/app/Dockerfile.hbs");
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

    it.each(INVALID)("rejects %j (%s)", (name) => {
        const appDir = join(root, "apps", "victim");
        mkdirSync(appDir, { recursive: true });
        expect(() => writeScaffold({ appDir, name })).toThrow(/RFC1123|name/i);
        // …and nothing is written: a rejected name must not leave a half-app.
        expect(existsSync(join(appDir, "package.json"))).toBe(false);
    });

    it("the CLI exits NON-ZERO on an invalid name (a broken app must never be exit 0)", async () => {
        const appDir = join(root, "apps", "cli-victim");
        mkdirSync(appDir, { recursive: true });
        const errSpy = vi
            .spyOn(process.stderr, "write")
            .mockImplementation(() => true);
        const outSpy = vi
            .spyOn(process.stdout, "write")
            .mockImplementation(() => true);
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
