/**
 * #1773 — the scaffolded `instrumentation.ts` must not load the OTel /
 * instrumentation stack at boot when tracing is off.
 *
 * Before #1773, `register()` awaited `import('./instrumentation-node')`
 * unconditionally. That module's static imports (`@vercel/otel`, the core
 * tracing/metrics adapters, `@getknext/lib/clients` → `@cerbos/grpc`, `minio`,
 * `prom-client` — a ~1.7 MB server chunk) were evaluated right after `listen`,
 * even though `registerNode()` returns at once when tracing is off (the
 * default). Measured on GKE e2 (n=10/arm): ~0.9 s of every cold start.
 *
 * The fix gates the dynamic import on the SAME core-owned, dependency-free
 * gate `registerNode()` already uses (`resolveOtelOptions`). This file proves
 * both halves:
 *
 *   1. STATIC: every shipped copy of `instrumentation.ts` (the CLI template, the
 *      zone template, and the file-manager reference app) top-level imports
 *      nothing but that pure gate module — no OTel, metrics or client module.
 *   2. BEHAVIOURAL: running the real template's `register()` evaluates
 *      `./instrumentation-node` (and calls `registerNode`) IFF the runtime is
 *      Node AND tracing is enabled — and never otherwise.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");
const OTEL_CONFIG_SRC = resolve(here, "../adapters/otel-config.ts");

/** Every shipped copy of the edge-clean instrumentation half. */
const COPIES = {
    "CLI template (knext create)": join(
        REPO_ROOT,
        "packages/kn-next/templates/app/src/instrumentation.ts.hbs",
    ),
    "zone template (turbo gen zone)": join(
        REPO_ROOT,
        "turbo/generators/templates/zone/src/instrumentation.ts.hbs",
    ),
    "file-manager reference app": join(
        REPO_ROOT,
        "apps/file-manager/src/instrumentation.ts",
    ),
} as const;

/** The ONLY module instrumentation.ts may import at the top level. */
const ALLOWED_STATIC_IMPORTS = ["@getknext/core/adapters/otel-config"];

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

describe("instrumentation.ts imports nothing heavy at the top level (#1773)", () => {
    for (const [label, path] of Object.entries(COPIES)) {
        it(`${label}: static imports are only the pure tracing gate`, () => {
            const specs = topLevelStaticImportSpecifiers(
                readFileSync(path, "utf8"),
            );
            for (const spec of specs) {
                expect(ALLOWED_STATIC_IMPORTS).toContain(spec);
            }
        });
    }

    it("the gate module it imports is dependency-free (no import/require)", () => {
        const src = readFileSync(OTEL_CONFIG_SRC, "utf8");
        expect(topLevelStaticImportSpecifiers(src)).toEqual([]);
        expect(src).not.toMatch(/\brequire\s*\(/);
        expect(src).not.toMatch(/\bimport\s*\(/);
    });
});

// ---------------------------------------------------------------------------
// Behavioural: execute the real template's register() against a stub
// ./instrumentation-node that records its own evaluation on globalThis.
// ---------------------------------------------------------------------------

const PROBE = Symbol.for("knext.test.1773.instrumentationNode");
type Probe = { evaluated: number; registered: number };
const g = globalThis as unknown as Record<symbol, Probe | undefined>;

const tmpRoots: string[] = [];
afterAll(() => {
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

/**
 * Lay the template out as a tiny app in a fresh temp dir (fresh path → fresh
 * module cache entry), resolve `@getknext/core/adapters/otel-config` to the
 * real source, and replace `./instrumentation-node` with a probe.
 */
function scaffoldApp(templatePath: string): string {
    const root = mkdtempSync(join(tmpdir(), "knext-1773-"));
    tmpRoots.push(root);
    const template = readFileSync(templatePath, "utf8");
    expect(template).not.toContain("{{");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "instrumentation.ts"), template);
    writeFileSync(
        join(root, "src", "instrumentation-node.ts"),
        [
            `const k = Symbol.for("knext.test.1773.instrumentationNode");`,
            `const p = ((globalThis as any)[k] ??= { evaluated: 0, registered: 0 });`,
            "p.evaluated += 1;",
            "export function registerNode() { p.registered += 1; }",
            "",
        ].join("\n"),
    );
    const pkg = join(root, "node_modules", "@getknext", "core");
    mkdirSync(join(pkg, "adapters"), { recursive: true });
    writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
            name: "@getknext/core",
            type: "module",
            exports: {
                "./adapters/otel-config": "./adapters/otel-config.ts",
            },
        }),
    );
    writeFileSync(
        join(pkg, "adapters", "otel-config.ts"),
        `export * from ${JSON.stringify(OTEL_CONFIG_SRC)};\n`,
    );
    return join(root, "src", "instrumentation.ts");
}

async function runRegister(
    templatePath: string,
    env: Record<string, string | undefined>,
): Promise<Probe> {
    const entry = scaffoldApp(templatePath);
    g[PROBE] = { evaluated: 0, registered: 0 };
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
        saved[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        const mod = (await import(pathToFileURL(entry).href)) as {
            register: () => Promise<void>;
        };
        await mod.register();
    } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
    return { ...(g[PROBE] as Probe) };
}

describe("register() loads ./instrumentation-node only when tracing is on (#1773)", () => {
    for (const [label, path] of Object.entries(COPIES)) {
        it(`${label}: tracing OFF (default, unset) — the Node body is never loaded`, async () => {
            const p = await runRegister(path, {
                NEXT_RUNTIME: "nodejs",
                OTEL_TRACING_ENABLED: undefined,
            });
            expect(p).toEqual({ evaluated: 0, registered: 0 });
        });

        it(`${label}: tracing ON — the Node body is loaded and registerNode() runs`, async () => {
            const p = await runRegister(path, {
                NEXT_RUNTIME: "nodejs",
                OTEL_TRACING_ENABLED: "true",
            });
            expect(p).toEqual({ evaluated: 1, registered: 1 });
        });

        it(`${label}: only the exact string "true" enables it (same gate as registerNode)`, async () => {
            const p = await runRegister(path, {
                NEXT_RUNTIME: "nodejs",
                OTEL_TRACING_ENABLED: "1",
            });
            expect(p).toEqual({ evaluated: 0, registered: 0 });
        });

        it(`${label}: edge runtime with tracing ON — still never loaded`, async () => {
            const p = await runRegister(path, {
                NEXT_RUNTIME: "edge",
                OTEL_TRACING_ENABLED: "true",
            });
            expect(p).toEqual({ evaluated: 0, registered: 0 });
        });
    }
});
