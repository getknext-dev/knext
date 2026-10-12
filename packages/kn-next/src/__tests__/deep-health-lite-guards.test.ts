/**
 * deep-health-lite-guards.test.ts — the properties that keep the tracing-off
 * deep-health gauge cold-start-neutral and ADR-0027-safe.
 *
 * The behaviour lives in `deep-health-lite.test.ts`. These are the guards on its
 * SHAPE, each of which stays green only while the shape holds:
 *
 *   - COLD START: the module imports nothing but `node:*` statically, and reaches
 *     `@getknext/lib/health` only through a dynamic import. Every import form is
 *     scanned; one the scanner cannot classify FAILS rather than passes, so a new
 *     construct cannot slip past an enumerated allowlist.
 *   - ADR-0027: it reads the activity slot by the SAME `Symbol.for` key the lib
 *     writes (parity checked against the lib source AND at runtime), and it holds
 *     no module-level mutable state.
 *   - WIRING: every shipped `instrumentation.ts` starts it only in the tracing-OFF
 *     branch, only on the Node runtime, via a static-literal dynamic import, and
 *     nothing ever lists it in `serverExternalPackages`.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeepHealthLite } from "../adapters/deep-health-lite";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../../..");
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

const LITE = read("packages/kn-next/src/adapters/deep-health-lite.ts");

const ACTIVITY_KEY = "knext.lib.clients.lastDbActivityAt";

/** Strip comments so prose in a header cannot satisfy or trip a scan. */
function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

interface ImportScan {
    statics: string[];
    dynamics: string[];
    requires: string[];
    unclassified: string[];
}

/**
 * Classify EVERY import-ish construct. A line that starts an `import`/`export`
 * statement is either a form we recognise or goes to `unclassified`, which the
 * tests require to be empty (scan, don't enumerate).
 */
function scanImports(source: string): ImportScan {
    const out: ImportScan = {
        statics: [],
        dynamics: [],
        requires: [],
        unclassified: [],
    };
    const src = code(source);
    for (const m of src.matchAll(/\bimport\s*\(\s*([^)]*?)\s*\)/g)) {
        // Inside a type position (`import("x").T`) or a value, both count.
        const lit = /^(['"`])([^'"`]+)\1$/.exec(m[1].replace(/\s+/g, " "));
        if (lit) out.dynamics.push(lit[2]);
        else out.unclassified.push(`import(${m[1]})`);
    }
    for (const m of src.matchAll(/\brequire\s*\(\s*([^)]*)\)/g)) {
        out.requires.push(m[1]);
    }
    // Static forms: `import ... from "x"`, `import "x"`, `export ... from "x"`.
    // Walk statement starts so a multi-line named-import list is one statement.
    for (const m of src.matchAll(
        /^(import|export)\b[\s\S]*?(?:;|\n(?=\S)|(?![\s\S]))/gm,
    )) {
        const stmt = m[0];
        if (/^import\s*\(/.test(stmt)) continue; // dynamic, handled above
        if (/^export\b/.test(stmt) && !/\bfrom\s*['"]/.test(stmt)) continue; // local export
        const from = /\bfrom\s*(['"])([^'"]+)\1/.exec(stmt);
        const bare = /^import\s*(['"])([^'"]+)\1/.exec(stmt);
        if (from) out.statics.push(from[2]);
        else if (bare) out.statics.push(bare[2]);
        else out.unclassified.push(stmt.trim().slice(0, 80));
    }
    return out;
}

describe("cold start: deep-health-lite imports nothing heavy", () => {
    const scan = scanImports(LITE);

    it("the scanner classified every import-ish construct (an unclassifiable one fails, never passes)", () => {
        expect(scan.unclassified).toEqual([]);
    });

    it("its ONLY static import is node:http", () => {
        expect(scan.statics.length).toBeGreaterThan(0);
        for (const spec of scan.statics) {
            expect(spec, `static import of ${spec}`).toBe("node:http");
        }
    });

    it("reaches the health check only through ONE dynamic import of @getknext/lib/health", () => {
        expect(scan.dynamics).toEqual(["@getknext/lib/health"]);
    });

    it("uses no require()", () => {
        expect(scan.requires).toEqual([]);
    });

    it("does not name prom-client, the OTel stack or lib/clients anywhere in code", () => {
        const c = code(LITE);
        for (const heavy of [
            "prom-client",
            "@vercel/otel",
            "@opentelemetry",
            "@getknext/lib/clients",
            "@getknext/core/adapters",
        ]) {
            expect(c, `deep-health-lite names ${heavy}`).not.toContain(heavy);
        }
    });

    it("the scanner itself catches what it must (mutation-free self-test)", () => {
        const bad = scanImports(
            [
                'import { createServer } from "node:http";',
                'import { Registry } from "prom-client";',
                'const x = await import("@getknext/lib/clients");',
                "const y = require('pg');",
                "import something, * as weird",
            ].join("\n"),
        );
        expect(bad.statics).toContain("prom-client");
        expect(bad.dynamics).toContain("@getknext/lib/clients");
        expect(bad.requires.length).toBe(1);
        expect(bad.unclassified.length).toBeGreaterThan(0);
    });
});

describe("ADR-0027: a reading seam on the lib's own key, and no module-level state", () => {
    it("reads Symbol.for('knext.lib.clients.lastDbActivityAt') by literal", () => {
        expect(code(LITE)).toContain(`Symbol.for("${ACTIVITY_KEY}")`);
    });

    it("the lib still writes exactly that key (the two literals cannot drift apart)", () => {
        const lib = read("packages/lib/src/clients.ts");
        expect(lib).toContain(`Symbol.for('${ACTIVITY_KEY}')`);
    });

    it("RUNTIME parity: a value written to the lib's slot opens lite's gate", async () => {
        const slot = Symbol.for(ACTIVITY_KEY);
        const g = globalThis as unknown as Record<symbol, number | undefined>;
        const before = g[slot];
        try {
            let probed = 0;
            const lite = createDeepHealthLite({
                app: "a",
                env: {},
                loadHealth: async () => ({
                    checkDeepHealth: async () => {
                        probed++;
                        return {
                            status: "ok",
                            checks: { postgres: "up", redis: "unconfigured" },
                        };
                    },
                }),
            });
            delete g[slot];
            expect(await lite.scrape()).toBe("");
            expect(probed).toBe(0);
            g[slot] = Date.now();
            expect(await lite.scrape()).toContain(
                'dependency="overall",state="ok"} 1',
            );
            expect(probed).toBe(1);
        } finally {
            if (before === undefined) delete g[slot];
            else g[slot] = before;
        }
    });

    it("holds no module-level mutable state (no top-level let/var)", () => {
        const topLevel = code(LITE)
            .split("\n")
            .filter((l) => /^(let|var)\s/.test(l));
        expect(topLevel).toEqual([]);
    });

    it("the server is unref'd and swallows errors (observability must not hold or break the pod)", () => {
        const c = code(LITE);
        expect(c).toMatch(/server\.unref\(\)/);
        expect(c).toMatch(/server\.on\(\s*"error"/);
    });

    it("binds loopback only", () => {
        expect(code(LITE)).toContain('"127.0.0.1"');
        expect(code(LITE)).not.toMatch(/0\.0\.0\.0|"::"/);
    });
});

/** Every shipped copy of the edge-clean instrumentation half. */
const COPIES = {
    "CLI template": "packages/kn-next/templates/app/src/instrumentation.ts.hbs",
    "zone template":
        "turbo/generators/templates/zone/src/instrumentation.ts.hbs",
    "file-manager": "apps/file-manager/src/instrumentation.ts",
} as const;

const LITE_SPECIFIER = "@getknext/core/internal/deep-health-lite";

describe("wiring: instrumentation.ts starts lite only when tracing is OFF, on Node", () => {
    for (const [label, rel] of Object.entries(COPIES)) {
        const src = code(read(rel));

        it(`${label}: lite is reached only by a dynamic import with a static literal`, () => {
            const scan = scanImports(read(rel));
            expect(scan.unclassified).toEqual([]);
            expect(scan.statics).not.toContain(LITE_SPECIFIER);
            expect(scan.dynamics).toContain(LITE_SPECIFIER);
        });

        it(`${label}: it sits inside the tracing-off branch, after the NEXT_RUNTIME guard`, () => {
            const guard = src.search(
                /process\.env\.NEXT_RUNTIME\s*!==\s*['"]nodejs['"]/,
            );
            const off = src.search(
                /if\s*\(\s*!resolveOtelOptions\(process\.env\)\s*\)/,
            );
            const lite = src.indexOf(LITE_SPECIFIER);
            const node = src.indexOf("./instrumentation-node");
            expect(guard).toBeGreaterThan(-1);
            expect(off).toBeGreaterThan(guard);
            expect(lite).toBeGreaterThan(off);
            // ... and BEFORE the tracing-on import of the Node body
            expect(node).toBeGreaterThan(lite);
            // the off-branch block ends (its `return`) before the Node body import
            const offBlock = src.slice(off, node);
            expect(offBlock).toMatch(/return;\s*\}/);
        });

        it(`${label}: the start is not awaited and cannot reject into boot`, () => {
            const stmt = src.slice(
                src.indexOf(`import('${LITE_SPECIFIER}')`) - 8,
            );
            expect(stmt.slice(0, 8)).toMatch(/void\s+/);
            expect(src).toMatch(/\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)/);
        });
    }

    it("nothing lists a @getknext package or the lite module in serverExternalPackages", () => {
        for (const rel of [
            "apps/file-manager/next.config.ts",
            "packages/kn-next/templates/app/next.config.ts.hbs",
        ]) {
            const m = read(rel).match(
                /serverExternalPackages:\s*\[([^\]]*)\]/s,
            );
            const list = m?.[1] ?? "";
            expect(list, rel).not.toContain("@getknext");
            expect(list, rel).not.toContain("deep-health-lite");
        }
    });

    it("the module is published as an internal subpath and built as its own entry", () => {
        const pkg = JSON.parse(read("packages/kn-next/package.json")) as {
            exports: Record<string, unknown>;
        };
        expect(pkg.exports["./internal/deep-health-lite"]).toBeDefined();
        expect(read("packages/kn-next/tsup.config.ts")).toContain(
            "'adapters/deep-health-lite': 'src/adapters/deep-health-lite.ts'",
        );
    });
});
