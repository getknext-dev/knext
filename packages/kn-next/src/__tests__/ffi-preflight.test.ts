/**
 * In-process Rust (Beta) — core's build-side involvement (ADR-0069 D14, D15,
 * D18): the shared `assertFfiTargetSupported` preflight, the image-arch →
 * Rust-triple mapping, the `knext ffi build` dispatch step, and a scan that
 * every image-building command calls them in the right order.
 *
 * Core reads only the EXISTENCE of `knext.ffi.json`; it never parses it.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    assertFfiTargetSupported,
    FFI_CONFIG_FILE,
    FFI_NODE_REFUSAL,
    FFI_SELF_CONTAINED_REFUSAL,
    FFI_TARGET_TRIPLES,
    ffiOptedIn,
    ffiTargetTriple,
    runFfiBuildStep,
} from "../cli/ffi-preflight";
import { UsageError } from "../cli/shared";

const roots: string[] = [];
afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function appDir(optedIn: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-ffi-preflight-"));
    roots.push(dir);
    if (optedIn) {
        // Deliberately NOT valid JSON: core must never parse the file.
        writeFileSync(join(dir, FFI_CONFIG_FILE), "{ not json");
    }
    return dir;
}

/** The D15 text, verbatim from ADR-0069. */
const D15 = `knext: in-process Rust (bun:ffi) needs the Bun runtime, but this app builds for Node.

  knext.ffi.json opts this app into in-process Rust, and knext.config.ts resolves
  runtime: 'node'. bun:ffi exists only in Bun, so the build stops here instead of
  shipping an image whose Rust calls would fail on the first request.

  Fix one of:
    - use the Bun runtime: remove runtime: 'node' from knext.config.ts (Bun is the default);
    - or move this code to a zone function (knext add function <name> --lang rust),
      which runs on both runtimes.`;

function refusal(fn: () => void): UsageError {
    try {
        fn();
    } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        return err as UsageError;
    }
    throw new Error("expected a refusal, got none");
}

describe("assertFfiTargetSupported — the D15 Node refusal", () => {
    it("is the ADR's text, verbatim", () => {
        expect(FFI_NODE_REFUSAL).toBe(D15);
    });

    for (const build of ["turbopack", "webpack", "vinext"] as const) {
        it(`refuses runtime 'node' × ${build} when knext.ffi.json exists`, () => {
            const err = refusal(() =>
                assertFfiTargetSupported(
                    { runtime: "node", build },
                    appDir(true),
                ),
            );
            expect(err.message).toBe(D15);
        });

        it(`changes nothing for runtime 'node' × ${build} without knext.ffi.json`, () => {
            expect(() =>
                assertFfiTargetSupported(
                    { runtime: "node", build },
                    appDir(false),
                ),
            ).not.toThrow();
        });
    }

    it("accepts the Bun runtime, explicit or defaulted", () => {
        const dir = appDir(true);
        expect(() =>
            assertFfiTargetSupported({ runtime: "bun" }, dir),
        ).not.toThrow();
        expect(() => assertFfiTargetSupported({}, dir)).not.toThrow();
    });
});

describe("assertFfiTargetSupported — the self-contained refusal", () => {
    for (const build of ["turbopack", "webpack", "vinext"] as const) {
        it(`refuses selfContained: true × ${build} when knext.ffi.json exists`, () => {
            const err = refusal(() =>
                assertFfiTargetSupported(
                    { runtime: "bun", build, selfContained: true },
                    appDir(true),
                ),
            );
            expect(err.message).toBe(FFI_SELF_CONTAINED_REFUSAL);
        });
    }

    it("the --self-contained flag counts, and an explicit false overrides the config", () => {
        const dir = appDir(true);
        expect(
            refusal(() =>
                assertFfiTargetSupported({ runtime: "bun" }, dir, {
                    selfContained: true,
                }),
            ).message,
        ).toBe(FFI_SELF_CONTAINED_REFUSAL);
        expect(() =>
            assertFfiTargetSupported(
                { runtime: "bun", selfContained: true },
                dir,
                { selfContained: false },
            ),
        ).not.toThrow();
    });

    it("says why and how to fix it, and is distinct from the Node message", () => {
        expect(FFI_SELF_CONTAINED_REFUSAL).toContain("knext.ffi.json");
        expect(FFI_SELF_CONTAINED_REFUSAL).toContain("selfContained");
        expect(FFI_SELF_CONTAINED_REFUSAL).toContain("--self-contained");
        expect(FFI_SELF_CONTAINED_REFUSAL).toContain("native/ffi/");
        expect(FFI_SELF_CONTAINED_REFUSAL).not.toBe(FFI_NODE_REFUSAL);
    });

    it("changes nothing without knext.ffi.json", () => {
        expect(() =>
            assertFfiTargetSupported(
                { runtime: "bun", selfContained: true },
                appDir(false),
            ),
        ).not.toThrow();
    });

    it("Node wins when both apply (the more fundamental fix)", () => {
        expect(
            refusal(() =>
                assertFfiTargetSupported(
                    { runtime: "node", selfContained: true },
                    appDir(true),
                ),
            ).message,
        ).toBe(D15);
    });
});

describe("the image arch → Rust target triple", () => {
    it("maps the two shipped image arches to their musl triples", () => {
        expect(FFI_TARGET_TRIPLES).toEqual({
            "linux-x64": "x86_64-unknown-linux-musl",
            "linux-arm64": "aarch64-unknown-linux-musl",
        });
        expect(ffiTargetTriple("linux-x64")).toBe("x86_64-unknown-linux-musl");
        expect(ffiTargetTriple("linux-arm64")).toBe(
            "aarch64-unknown-linux-musl",
        );
    });

    it("refuses an arch with no image triple", () => {
        expect(() => ffiTargetTriple("darwin-arm64")).toThrow(UsageError);
    });

    it("ffiOptedIn reads existence only", () => {
        expect(ffiOptedIn(appDir(true))).toBe(true);
        expect(ffiOptedIn(appDir(false))).toBe(false);
    });
});

describe("runFfiBuildStep — the knext ffi build dispatch", () => {
    it("does nothing (no dispatch) without knext.ffi.json", async () => {
        const calls: unknown[] = [];
        const ran = await runFfiBuildStep(appDir(false), "linux-x64", {
            dispatch: async (...a) => {
                calls.push(a);
                return 0;
            },
        });
        expect(ran).toBe(false);
        expect(calls).toEqual([]);
    });

    it("dispatches `knext ffi build --target <triple> --native-dir <app>/native`", async () => {
        const dir = appDir(true);
        const calls: unknown[][] = [];
        const ran = await runFfiBuildStep(dir, "linux-arm64", {
            coreVersion: "2.0.0",
            dispatch: async (...a) => {
                calls.push(a);
                return 0;
            },
        });
        expect(ran).toBe(true);
        expect(calls).toEqual([
            [
                "ffi",
                [
                    "build",
                    "--target",
                    "aarch64-unknown-linux-musl",
                    "--native-dir",
                    join(dir, "native"),
                ],
                "2.0.0",
            ],
        ]);
    });

    it("a failed ffi build stops the build with a usage error", async () => {
        await expect(
            runFfiBuildStep(appDir(true), "linux-x64", {
                dispatch: async () => 1,
            }),
        ).rejects.toThrow(/knext ffi build failed \(exit 1\)/);
    });
});

// ---------------------------------------------------------------------------
// Caller scan: build, deploy and preview each call the preflight FIRST (right
// after loadConfig, before any skip branch or build work) and the dispatch
// before the project build. Scans the real sources.
// ---------------------------------------------------------------------------

const CLI = join(import.meta.dir, "..", "cli");
const src = (f: string) => readFileSync(join(CLI, f), "utf8");

/** The body of `function <name>(` in `text` (brace-matched), or undefined. */
function body(text: string, name: string): string | undefined {
    const start = text.search(
        new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`),
    );
    if (start === -1) return undefined;
    // The body brace is the first `{` after the parameter list's `)` (none of
    // the scanned signatures nests parentheses).
    const i = text.indexOf("{", text.indexOf(")", start));
    let depth = 0;
    for (let j = i; j < text.length; j++) {
        if (text[j] === "{") depth++;
        else if (text[j] === "}") {
            depth--;
            if (depth === 0) return text.slice(i + 1, j);
        }
    }
    return undefined;
}

/** Code only: `//` line comments and block comments blanked. */
const code = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

interface Caller {
    file: string;
    fn: string;
    /** Must the preflight directly follow the loadConfig statement? */
    afterLoadConfig: boolean;
}

/**
 * Violations of the ordering contract in one function body:
 *  - `assertFfiTargetSupported(` is present;
 *  - if `afterLoadConfig`, it is the first statement after the
 *    `= await loadConfig(...)` one;
 *  - otherwise it is the first statement of the body;
 *  - it precedes every build-work marker (skip branches, project build,
 *    compile, dispatch).
 */
function preflightViolations(fnBody: string, c: Caller): string[] {
    const out: string[] = [];
    const b = code(fnBody);
    const at = b.indexOf("assertFfiTargetSupported(");
    if (at === -1) return [`${c.fn}: never calls assertFfiTargetSupported`];
    if (c.afterLoadConfig) {
        const m = /=\s*await\s+loadConfig\([^;]*\);/.exec(b);
        if (!m) return [`${c.fn}: no loadConfig call`];
        const between = b.slice(m.index + m[0].length, at).trim();
        if (between !== "")
            out.push(
                `${c.fn}: something runs between loadConfig and the preflight: ${between.slice(0, 80)}`,
            );
    } else if (b.slice(0, at).trim() !== "") {
        out.push(`${c.fn}: the preflight is not the first statement`);
    }
    for (const marker of [
        "skipBuild",
        "skipNextBuild",
        "runProjectBuild(",
        "compileArtifactForDeploy(",
        "assertCompiledArtifactFresh(",
        "runFfiBuildStep(",
        "buildAndPush(",
    ]) {
        const m = b.indexOf(marker);
        if (m !== -1 && m < at)
            out.push(`${c.fn}: ${marker} comes before the preflight`);
    }
    return out;
}

/** The dispatch must come before the project build in a function body. */
function dispatchViolations(fnBody: string, fn: string): string[] {
    const b = code(fnBody);
    const d = b.indexOf("runFfiBuildStep(");
    const p = b.indexOf("runProjectBuild(");
    if (p === -1) return [`${fn}: no runProjectBuild call (scan is stale)`];
    if (d === -1) return [`${fn}: never dispatches knext ffi build`];
    if (d > p) return [`${fn}: dispatches after runProjectBuild`];
    return [];
}

const CALLERS: Caller[] = [
    { file: "build.ts", fn: "build", afterLoadConfig: true },
    { file: "deploy.ts", fn: "deploy", afterLoadConfig: true },
    // preview: `preview()` loads the config and hands it to runPreviewDeploy,
    // the deploy leg (destroy builds nothing and is not refused).
    { file: "preview.ts", fn: "runPreviewDeploy", afterLoadConfig: false },
];

describe("caller scan — every image-building command", () => {
    for (const c of CALLERS) {
        it(`${c.file} ${c.fn}() calls assertFfiTargetSupported first`, () => {
            const b = body(src(c.file), c.fn);
            expect(b, `${c.fn} not found in ${c.file}`).toBeDefined();
            expect(preflightViolations(b as string, c)).toEqual([]);
        });
    }

    it("preview() hands the loaded config straight to runPreviewDeploy on the deploy leg", () => {
        const b = code(body(src("preview.ts"), "preview") as string);
        expect(b).toContain("await loadConfig()");
        expect(b).toContain("runPreviewDeploy(");
    });

    for (const [file, fn] of [
        ["build.ts", "build"],
        ["deploy.ts", "deploy"],
        ["preview.ts", "defaultBuildAndPush"],
    ] as const) {
        it(`${file} ${fn}() dispatches knext ffi build before runProjectBuild`, () => {
            const b = body(src(file), fn);
            expect(b, `${fn} not found in ${file}`).toBeDefined();
            expect(dispatchViolations(b as string, fn)).toEqual([]);
        });
    }

    it("the scan sees a violation (self-test)", () => {
        const c: Caller = { file: "x", fn: "x", afterLoadConfig: true };
        expect(
            preflightViolations(
                "const config = await loadConfig(); assertFfiTargetSupported(config, cwd);",
                c,
            ),
        ).toEqual([]);
        expect(
            preflightViolations(
                "const config = await loadConfig(); log.info('x'); assertFfiTargetSupported(config, cwd);",
                c,
            ),
        ).toHaveLength(1);
        expect(
            preflightViolations(
                "const config = await loadConfig();\nif (options.skipBuild) {}\n",
                c,
            ),
        ).toHaveLength(1);
        expect(
            preflightViolations(
                "validate(); assertFfiTargetSupported(config, cwd);",
                { ...c, afterLoadConfig: false },
            ),
        ).toHaveLength(1);
        expect(
            dispatchViolations(
                "runProjectBuild({}); await runFfiBuildStep(cwd, arch);",
                "x",
            ),
        ).toHaveLength(1);
        expect(dispatchViolations("runProjectBuild({});", "x")).toHaveLength(1);
    });
});
