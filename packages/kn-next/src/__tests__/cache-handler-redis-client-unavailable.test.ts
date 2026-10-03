/**
 * #1843 — on the standalone NODE runtime the cache handler silently fell back
 * to its in-memory store while Redis was configured. Every cache line in the
 * pod logs read `[Cache] … (memory)`, ISR did not survive scale-to-zero, and
 * nothing said why.
 *
 * Two halves, both pinned here:
 *
 *  1. The cause. The handler loaded ioredis through a computed specifier, so
 *     bundlers and `bun build --compile` would not pull it in — and Next's
 *     standalone file tracing could not follow it either, so the node image
 *     never carried it. The handler is now split per runtime: the NODE entry
 *     imports ioredis LITERALLY (tracing follows it into the image) and the
 *     BUN entry uses Bun's built-in client with no ioredis import at all. The
 *     build picks the entry (adapter-runtime-cache-handler.test.ts).
 *
 *  2. The silence. When `REDIS_URL` is set and an entry's client cannot be
 *     loaded, the handler says so at error level — once, at startup — instead
 *     of degrading to memory with nothing but `(memory)` suffixes to show for
 *     it. Proved BEHAVIOURALLY: the real handler files run under real `node`
 *     from a directory with no `node_modules` anywhere above it, which is
 *     exactly the node image's situation before this fix.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PKG_ROOT = resolve(__dirname, "..", "..");
const ADAPTERS = join(PKG_ROOT, "src", "adapters");
const DIST_ADAPTERS = join(PKG_ROOT, "dist", "adapters");

/** The token the startup error carries, so an operator can grep for it. */
const LOUD = "Redis client unavailable";

/** A literal ioredis import in any form a tracer (or a bundler) would follow. */
const LITERAL_IOREDIS =
    /\bimport\s*\(\s*["']ioredis["']\s*\)|\bfrom\s+["']ioredis["']|\brequire\s*\(\s*["']ioredis["']\s*\)/;

/** Code only: drop line and block comments so prose cannot trip a match. */
function code(path: string): string {
    return readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

// ─── 1. the per-runtime entries pick their client statically ───

describe("#1843 — the per-runtime cache handler entries", () => {
    it("the NODE entry imports ioredis literally (source)", () => {
        expect(code(join(ADAPTERS, "cache-handler-node.js"))).toMatch(
            LITERAL_IOREDIS,
        );
    });

    it("the NODE entry still imports ioredis literally after the package build (what Next's tracing reads)", () => {
        const built = join(DIST_ADAPTERS, "cache-handler-node.js");
        if (!existsSync(built)) {
            throw new Error(
                `${built} missing — run 'bun run build' in packages/kn-next first (CI builds @getknext/core before test)`,
            );
        }
        expect(code(built)).toMatch(LITERAL_IOREDIS);
    });

    it("the BUN entry reaches no ioredis import (source and built)", () => {
        expect(code(join(ADAPTERS, "cache-handler-bun.js"))).not.toMatch(
            /ioredis/,
        );
        expect(code(join(DIST_ADAPTERS, "cache-handler-bun.js"))).not.toMatch(
            LITERAL_IOREDIS,
        );
    });

    it("the shared module carries no LITERAL ioredis import (the generic path stays bundler-safe for vinext)", () => {
        expect(code(join(ADAPTERS, "cache-handler.js"))).not.toMatch(
            LITERAL_IOREDIS,
        );
    });

    it("the package exports both entries on internal subpaths the adapter resolves", () => {
        const pkg = JSON.parse(
            readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
        );
        expect(pkg.exports["./internal/cache-handler-node"]).toBe(
            "./dist/adapters/cache-handler-node.js",
        );
        expect(pkg.exports["./internal/cache-handler-bun"]).toBe(
            "./dist/adapters/cache-handler-bun.js",
        );
        expect(typeof pkg.dependencies?.ioredis).toBe("string");
    });
});

// ─── 2. fail LOUDLY when Redis is configured but the client cannot load ───

const work = mkdtempSync(join(tmpdir(), "knext-1843-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const HANDLER_FILES = [
    "cache-handler.js",
    "cache-handler-node.js",
    "cache-handler-bun.js",
    "cache-write-registry.js",
    "slow-dep-log.js",
];

/**
 * Stage the handler entries and their relative imports in a directory with NO
 * `node_modules` above it, so `ioredis` cannot resolve — the node image's
 * exact situation before the fix. tmpdir() is outside the repo by construction.
 */
function stageIsolated(): string {
    const dir = join(work, "isolated", "adapters");
    mkdirSync(dir, { recursive: true });
    for (const f of HANDLER_FILES)
        copyFileSync(join(ADAPTERS, f), join(dir, f));
    // ESM — the package's own `"type": "module"` does not travel with the copy.
    writeFileSync(join(dirname(dir), "package.json"), '{"type":"module"}\n');
    return dir;
}

function runEntry(entry: string, env: Record<string, string | undefined>) {
    const dir = stageIsolated();
    const driver = join(dir, `drive-${entry}.mjs`);
    writeFileSync(
        driver,
        [
            `const { default: CacheHandler } = await import(${JSON.stringify(join(dir, entry))});`,
            "const h = new CacheHandler({});",
            "for (let i = 0; i < 4; i++) await h.get(`k${i}`);",
            "await h.set('k0', { kind: 'FETCH', data: { body: 'x' } }, {});",
            "const got = await h.get('k0');",
            "console.log('DRIVER_DONE', got ? 'served' : 'null');",
        ].join("\n"),
    );
    const childEnv = { ...process.env };
    for (const k of Object.keys(childEnv)) {
        if (k.startsWith("REDIS_") || k === "KNEXT_CACHE_REDIS_CLIENT") {
            delete childEnv[k];
        }
    }
    childEnv.REDIS_KEY_PREFIX = "knext-1843";
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete childEnv[k];
        else childEnv[k] = v;
    }
    // Real `node` — the runtime the node entry is for, and one with no Bun
    // global, so the bun entry's client is unavailable too.
    const r = spawnSync("node", [driver], {
        env: childEnv,
        encoding: "utf8",
        timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("#1843 — the handler fails loudly when Redis is configured but its client cannot load", () => {
    it("sanity: ioredis really is unresolvable from the isolated copy (else this suite proves nothing)", () => {
        const dir = stageIsolated();
        const probe = join(dir, "probe.mjs");
        writeFileSync(
            probe,
            "try { await import('ioredis'); console.log('RESOLVED'); } catch { console.log('UNRESOLVED'); }\n",
        );
        const r = spawnSync("node", [probe], { encoding: "utf8" });
        expect(r.stdout.trim()).toBe("UNRESOLVED");
    });

    it.each([
        ["cache-handler-node.js", "ioredis"],
        ["cache-handler-bun.js", "Bun native"],
        ["cache-handler.js", "ioredis"],
    ])("%s: ONE error naming the %s client and the consequence, and it still serves (fails open)", (entry, client) => {
        const r = runEntry(entry, { REDIS_URL: "redis://127.0.0.1:6399" });
        expect(r.status, r.stderr).toBe(0);
        const loud = r.stderr.split("\n").filter((l) => l.includes(LOUD));
        expect(loud.length, `stderr was:\n${r.stderr}`).toBe(1);
        expect(loud[0]).toContain(`the ${client} Redis client`);
        expect(loud[0]).toContain("REDIS_URL");
        expect(loud[0]).toMatch(/in-memory/i);
        expect(loud[0]).toMatch(/scale-to-zero/);
        // The fallback itself is unchanged: it still serves from memory.
        expect(r.stdout).toContain("(memory)");
        expect(r.stdout).toContain("DRIVER_DONE served");
    });

    it.each([
        "cache-handler-node.js",
        "cache-handler-bun.js",
        "cache-handler.js",
    ])("%s: says nothing when Redis is NOT configured (memory is then the intended store)", (entry) => {
        const r = runEntry(entry, { REDIS_URL: undefined });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain("DRIVER_DONE");
        expect(r.stderr).not.toContain(LOUD);
    });
});
