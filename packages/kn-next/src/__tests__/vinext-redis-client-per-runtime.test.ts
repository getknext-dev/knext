/**
 * The vinext cache adapter picks its Redis client per RUNTIME, statically.
 *
 * The one generic adapter loaded ioredis through a computed specifier. Nitro's
 * node preset traces what a bundle can SEE, so a vinext x node image could ship
 * without ioredis and run from the in-memory store: ISR lost on every
 * scale-to-zero, with nothing saying why. Now:
 *
 *  - `vinext-cache-adapter-node` wraps the node handler, whose ioredis import
 *    is LITERAL (the tracer/bundler follows it);
 *  - `vinext-cache-adapter-bun` wraps the bun handler (Bun's built-in client,
 *    no ioredis anywhere in its graph, so `bun build --compile` stays clean);
 *  - the scaffolded vite.config picks one from `knext.runtime`.
 */

process.env.KNEXT_TEST_SEAMS = "1";

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dirname, "..", "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");
const ADAPTERS = join(PKG_ROOT, "src", "adapters");

const tempRoots: string[] = [];
afterAll(() => {
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

type Factory = (a?: unknown) => {
    constructor: { redisClient: { name: string } };
};

/** Bundle an entry for a target with ioredis external; return the output text. */
function bundle(entry: string, target: "node" | "bun", name: string): string {
    const out = mkdtempSync(join(tmpdir(), "knext-1851-"));
    tempRoots.push(out);
    const res = spawnSync(
        "bun",
        [
            "build",
            entry,
            "--target",
            target,
            "--external",
            "ioredis",
            "--outdir",
            out,
        ],
        { encoding: "utf8" },
    );
    if (res.status !== 0) throw new Error(`bun build failed: ${res.stderr}`);
    return readFileSync(join(out, `${name}.js`), "utf8");
}

describe("vinext adapter: node entry", () => {
    const src = join(ADAPTERS, "vinext-cache-adapter-node.mjs");

    it("default-exports a factory returning the NODE handler (ioredis client)", async () => {
        expect(existsSync(src)).toBe(true);
        const mod = (await import(src)) as { default: Factory };
        const h = mod.default({ options: undefined });
        expect(h.constructor.redisClient.name).toBe("ioredis");
    });

    it("its bundle keeps a LITERAL import('ioredis') that nitro/vite tracing can follow", () => {
        const out = bundle(src, "node", "vinext-cache-adapter-node");
        expect(out).toMatch(/import\(\s*["']ioredis["']\s*\)/);
    });
});

describe("vinext adapter: bun entry", () => {
    const src = join(ADAPTERS, "vinext-cache-adapter-bun.mjs");

    it("default-exports a factory returning the BUN handler (built-in client)", async () => {
        expect(existsSync(src)).toBe(true);
        const mod = (await import(src)) as { default: Factory };
        const h = mod.default({ options: undefined });
        expect(h.constructor.redisClient.name).toBe("Bun native");
    });

    it("its bundle reaches no ioredis at all (the compiled exec cannot run it)", () => {
        const out = bundle(src, "bun", "vinext-cache-adapter-bun");
        // No import form a bundler/compiler could follow. (The shared core
        // keeps a computed specifier for its generic path; `bun build
        // --compile` cannot follow it, which is the point.)
        expect(out).not.toMatch(
            /\bimport\s*\(\s*["']ioredis["']\s*\)|\bfrom\s+["']ioredis["']|\brequire\s*\(\s*["']ioredis["']\s*\)/,
        );
    });
});

describe("the generic path no longer carries the unresolved TODO", () => {
    it("cache-handler.js has no TODO(#1843)", () => {
        expect(
            readFileSync(join(ADAPTERS, "cache-handler.js"), "utf8"),
        ).not.toContain("TODO(#1843)");
    });
});

describe("wiring: package exports, tsup, vite configs", () => {
    const pkg = JSON.parse(
        readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
    );
    const tsup = readFileSync(join(PKG_ROOT, "tsup.config.ts"), "utf8");

    for (const rt of ["node", "bun"]) {
        it(`${rt}: exported and built`, () => {
            expect(pkg.exports[`./internal/vinext-cache-adapter-${rt}`]).toBe(
                `./dist/adapters/vinext-cache-adapter-${rt}.js`,
            );
            expect(tsup).toContain(
                `src/adapters/vinext-cache-adapter-${rt}.mjs`,
            );
        });
    }

    it("the scaffolded vite.config picks the adapter by runtime", () => {
        const src = readFileSync(
            join(PKG_ROOT, "templates", "app", "vite.config.ts.hbs"),
            "utf8",
        );
        expect(src).toContain("internal/vinext-cache-adapter-node");
        expect(src).toContain("internal/vinext-cache-adapter-bun");
        expect(src).toMatch(
            /onNode\s*\?\s*['"]@getknext\/core\/internal\/vinext-cache-adapter-node/,
        );
    });

    it("the bun-only vite configs name the bun adapter", () => {
        for (const rel of [
            "apps/file-manager/vite.config.ts",
            "turbo/generators/templates/zone/vite.config.ts.hbs",
        ]) {
            expect(readFileSync(join(REPO_ROOT, rel), "utf8")).toContain(
                "internal/vinext-cache-adapter-bun",
            );
        }
    });
});

describe("kind e2e lane covers vinext x node and vinext x bun", () => {
    const wf = readFileSync(
        join(REPO_ROOT, ".github/workflows/runtime-redis-cache-kind-e2e.yml"),
        "utf8",
    );
    it("the matrix includes a vinext builder and the scaffold is told so", () => {
        expect(wf).toMatch(/builder:\s*vinext/);
        expect(wf).toContain("--builder");
    });
});

describe("built output (what the app's vite/nitro build consumes)", () => {
    const LITERAL =
        /\bimport\s*\(\s*["']ioredis["']\s*\)|\bfrom\s+["']ioredis["']|\brequire\s*\(\s*["']ioredis["']\s*\)/;
    const built = (n: string) =>
        join(PKG_ROOT, "dist", "adapters", `vinext-cache-adapter-${n}.js`);

    it("the node adapter carries a literal ioredis import in its own file", () => {
        if (!existsSync(built("node"))) {
            throw new Error(
                `${built("node")} missing: build @getknext/core first`,
            );
        }
        expect(readFileSync(built("node"), "utf8")).toMatch(LITERAL);
    });

    it("the bun adapter file has no literal ioredis import", () => {
        if (!existsSync(built("bun"))) {
            throw new Error(
                `${built("bun")} missing: build @getknext/core first`,
            );
        }
        expect(readFileSync(built("bun"), "utf8")).not.toMatch(LITERAL);
    });
});

describe("a configured Redis whose client cannot load is reported loudly, once", () => {
    it("the bun adapter under plain node (no Bun global) logs ONE 'Redis client unavailable' error", () => {
        const res = spawnSync(
            "node",
            [
                "--input-type=module",
                "-e",
                `const { default: f } = await import(${JSON.stringify(
                    join(ADAPTERS, "vinext-cache-adapter-bun.mjs"),
                )});
                 const h = f({});
                 await h.get('k', {}); await h.get('k2', {});`,
            ],
            {
                encoding: "utf8",
                env: { ...process.env, REDIS_URL: "redis://127.0.0.1:1" },
            },
        );
        const hits = (res.stderr.match(/Redis client unavailable/g) ?? [])
            .length;
        expect(hits).toBe(1);
    });
});

describe("nitro's bundle of the node adapter contains ioredis itself", () => {
    it("bundling without --external ioredis inlines the client (nitro bundles it into .output/server; no node_modules/ioredis dir is needed)", () => {
        const out = mkdtempSync(join(tmpdir(), "knext-1851-"));
        tempRoots.push(out);
        const res = spawnSync(
            "bun",
            [
                "build",
                join(ADAPTERS, "vinext-cache-adapter-node.mjs"),
                "--target",
                "node",
                "--outdir",
                out,
            ],
            { encoding: "utf8", cwd: PKG_ROOT },
        );
        expect(res.status).toBe(0);
        const text = readFileSync(
            join(out, "vinext-cache-adapter-node.js"),
            "utf8",
        );
        expect(text).toContain("enableOfflineQueue");
        expect(text).toContain("cluster_state");
    });
});
