/**
 * #1843 — on the standalone NODE runtime the cache handler silently fell back
 * to its in-memory store while Redis was configured. Every cache line in the
 * pod logs read `[Cache] … (memory)`, ISR did not survive scale-to-zero, and
 * nothing said why.
 *
 * Two halves, both pinned here:
 *
 *  1. The cause. `cache-handler.js` loads ioredis through a deliberately
 *     NON-literal specifier (so `bun build --compile` and bundlers never pull it
 *     in), which also means Next's standalone file tracing never copies ioredis
 *     into `.next/standalone`. The node image must therefore carry it some other
 *     way: the `standalone-deps` stage installs it, and its `node_modules` lands
 *     at a directory every traced file under `.next/standalone` resolves
 *     through (Node walks ancestor `node_modules`).
 *
 *  2. The silence. When `REDIS_URL` is set and the client cannot be loaded, the
 *     handler must say so at error level — once, at startup — instead of
 *     degrading to memory with nothing but `(memory)` suffixes to show for it.
 *     Proved BEHAVIOURALLY: the real handler file runs under real `node` from a
 *     directory with no `node_modules` anywhere above it, which is exactly the
 *     image's situation before this fix.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";

const PKG_ROOT = resolve(__dirname, "..", "..");
const ADAPTERS = join(PKG_ROOT, "src", "adapters");
const DOCKERFILE = join(
    PKG_ROOT,
    "templates",
    "runtime-standalone",
    "Dockerfile.standalone.hbs",
);

/** The token the startup error carries, so an operator can grep for it. */
const LOUD = "Redis client unavailable";

// ─── 1. the image carries ioredis where the traced handler resolves it ───

function stageBody(name: string): string {
    const code = readFileSync(DOCKERFILE, "utf8")
        .replace(/\\\n/g, " ")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("#"))
        .join("\n");
    const part = code
        .split(/^FROM /m)
        .slice(1)
        .find((p) =>
            new RegExp(`\\bAS\\s+${name}\\s*$`, "i").test(
                p.split("\n", 1)[0] ?? "",
            ),
        );
    if (!part)
        throw new Error(`no \`${name}\` stage in Dockerfile.standalone.hbs`);
    return part;
}

/** `COPY [--from=x] <src> <dest>` destinations in a stage, keyed by source. */
function copyDest(stage: string, from: RegExp): string {
    const lines = stage
        .split("\n")
        .filter((l) => /^COPY\s/.test(l.trim()) && from.test(l));
    if (lines.length !== 1) {
        throw new Error(
            `expected exactly one COPY matching ${from} in the stage, found ${lines.length}`,
        );
    }
    const words = lines[0].trim().split(/\s+/);
    return words[words.length - 1];
}

describe("#1843 — the node standalone image carries ioredis", () => {
    const pkg = JSON.parse(
        readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
    );

    it("@getknext/core depends on ioredis (the range the image must install)", () => {
        expect(typeof pkg.dependencies?.ioredis).toBe("string");
    });

    it("the standalone-deps stage installs ioredis at EXACTLY @getknext/core's range", () => {
        const deps = stageBody("standalone-deps");
        const m = deps.match(/npm\s+install[^\n]*\sioredis@(\S+)/);
        expect(
            m?.[1],
            "standalone-deps does not install ioredis — the node runtime's cache handler cannot load its Redis client and silently uses memory",
        ).toBe(pkg.dependencies.ioredis);
    });

    it("the node stage puts that node_modules on the ancestor path of the traced standalone tree", () => {
        const node = stageBody("standalone-node");
        const depsDest = copyDest(node, /--from=standalone-deps\s/);
        const treeDest = copyDest(node, /^\s*COPY\s+\.next\/standalone\s/);
        expect(posix.basename(depsDest)).toBe("node_modules");
        // Where Next's tracing puts the handler: under the standalone tree.
        const handler = posix.join(
            treeDest,
            "node_modules/@getknext/core/dist/adapters/cache-handler.js",
        );
        // Node's resolver tries `<ancestor>/node_modules` for every ancestor of
        // the importing file. The deps dir is reachable iff its parent is one.
        const ancestors: string[] = [];
        for (let d = posix.dirname(handler); ; d = posix.dirname(d)) {
            ancestors.push(posix.join(d, "node_modules"));
            if (d === "/") break;
        }
        expect(ancestors).toContain(depsDest);
    });
});

// ─── 2. fail LOUDLY when Redis is configured but the client cannot load ───

const work = mkdtempSync(join(tmpdir(), "knext-1843-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/**
 * Stage the handler and its two relative imports in a directory with NO
 * `node_modules` above it, so `ioredis` cannot resolve — the image's exact
 * situation before the fix. tmpdir() is outside the repo by construction.
 */
function stageIsolatedHandler(): string {
    const dir = join(work, "isolated", "adapters");
    mkdirSync(dir, { recursive: true });
    for (const f of [
        "cache-handler.js",
        "cache-write-registry.js",
        "slow-dep-log.js",
    ]) {
        copyFileSync(join(ADAPTERS, f), join(dir, f));
    }
    // ESM — the package's own `"type": "module"` does not travel with the copy.
    writeFileSync(join(dirname(dir), "package.json"), '{"type":"module"}\n');
    return join(dir, "cache-handler.js");
}

function runHandler(env: Record<string, string | undefined>) {
    const handler = stageIsolatedHandler();
    const driver = join(dirname(handler), "drive.mjs");
    writeFileSync(
        driver,
        [
            `const { default: CacheHandler } = await import(${JSON.stringify(handler)});`,
            "const h = new CacheHandler({});",
            "for (let i = 0; i < 4; i++) await h.get(`k${i}`);",
            "await h.set('k0', { kind: 'FETCH', data: { body: 'x' } }, {});",
            "const got = await h.get('k0');",
            "console.log('DRIVER_DONE', got ? 'served' : 'null');",
        ].join("\n"),
    );
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (
            v !== undefined &&
            !k.startsWith("REDIS_") &&
            k !== "KNEXT_CACHE_REDIS_CLIENT"
        ) {
            childEnv[k] = v;
        }
    }
    childEnv.REDIS_KEY_PREFIX = "knext-1843";
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete childEnv[k];
        else childEnv[k] = v;
    }
    // Real `node` — the runtime this bug lives on (bun takes its native client).
    const r = spawnSync("node", [driver], {
        env: childEnv,
        encoding: "utf8",
        timeout: 30_000,
    });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

describe("#1843 — the handler fails loudly when Redis is configured but its client cannot load", () => {
    it("sanity: ioredis really is unresolvable from the isolated copy (else this suite proves nothing)", () => {
        const handler = stageIsolatedHandler();
        const probe = join(dirname(handler), "probe.mjs");
        writeFileSync(
            probe,
            "try { await import(['io','redis'].join('')); console.log('RESOLVED'); } catch { console.log('UNRESOLVED'); }\n",
        );
        const r = spawnSync("node", [probe], { encoding: "utf8" });
        expect(r.stdout.trim()).toBe("UNRESOLVED");
    });

    it("logs ONE error naming the missing client and the consequence, and still serves (fails open)", () => {
        const r = runHandler({ REDIS_URL: "redis://127.0.0.1:6399" });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain("DRIVER_DONE");
        const loud = r.stderr.split("\n").filter((l) => l.includes(LOUD));
        expect(loud.length, `stderr was:\n${r.stderr}`).toBe(1);
        expect(loud[0]).toContain("ioredis");
        expect(loud[0]).toContain("REDIS_URL");
        expect(loud[0]).toMatch(/in-memory/i);
        expect(loud[0]).toMatch(/scale-to-zero/);
        // The fallback itself is unchanged: it still serves from memory.
        expect(r.stdout).toContain("(memory)");
        expect(r.stdout).toContain("DRIVER_DONE served");
    });

    it("says nothing when Redis is NOT configured (memory is then the intended store, not a degradation)", () => {
        const r = runHandler({ REDIS_URL: undefined });
        expect(r.status, r.stderr).toBe(0);
        expect(r.stdout).toContain("DRIVER_DONE");
        expect(r.stderr).not.toContain(LOUD);
    });
});
