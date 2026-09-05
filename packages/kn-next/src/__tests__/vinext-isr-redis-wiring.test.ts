/**
 * ISR must actually reach Redis on the vinext axis (#953).
 *
 * ## The live failure this exists for
 *
 * The S3-V cluster verification (row E, both kind and OKE) observed a scaffolded
 * vinext app serving every `/isr` request as MISS + `no-store` with Redis
 * `DBSIZE` = 0 — env correct, Redis reachable, cache handler unit-proven
 * (#906/#940) and *never invoked*. The handler was wired through
 * `next.config.ts`'s `cacheHandler`, which is a webpack/turbopack mechanism
 * vinext never reads. Nothing registered a data cache handler, so vinext fell
 * back to its per-pod `MemoryCacheHandler`… whose writes never happened either,
 * because the page cache serving strategy saw no cacheable policy. Redis stayed
 * empty and the #906 unit prover — which deletes `REDIS_URL` — could not see it.
 *
 * ## The wiring point (measured against vinext@1.0.0-beta.8's dist, the exact
 * version the scaffold pins)
 *
 * vinext's hook is the `cache` option of the `vinext()` vite plugin
 * (`dist/index.d.ts:123`). At build time the plugin generates the
 * `virtual:vinext-cache-adapters` module from it (`dist/index.js`:
 * `generateCacheAdaptersModule(options.cache)`); every server entry imports
 * that module and calls `registerConfiguredCacheAdapters(env)` per request
 * (`dist/server/app-router-entry.js:23`), which passes the descriptor to
 * `setDataCacheHandler(factory({ env, options }))`. Page-level ISR then flows
 * through `DefaultCdnCacheAdapter`, which reads/writes `getDataCacheHandler()`
 * — so registering a Redis-backed DATA cache handler is sufficient for the
 * whole row-E contract (SET with TTL, HIT, STALE, background regeneration).
 *
 * ## What is asserted, in three layers (each halves-guarded)
 *
 *  1. SCAN, not enumerate: every vite config in the tree that invokes
 *     `vinext(` must pass `cache.data.adapter` pointing at knext's adapter
 *     subpath. A new app/template added without the wiring goes red here.
 *  2. The subpath is REAL: the package export map, the tsup entry, and the
 *     source module all exist and agree — a template pointing at a specifier
 *     the package does not ship is row E with extra steps (vinext logs the
 *     failed import and silently keeps the memory handler).
 *  3. The chain WORKS, through vinext's real beta.8 code and a real RESP2
 *     socket: generate the virtual module exactly as the plugin does, register
 *     it, then drive vinext's own `isrSet`/`isrGet` and observe the Redis SET
 *     carry an `EX` that OUTLIVES the revalidate window (#886 rule), a HIT,
 *     and a STALE — the acceptance sequence of #953 at the highest level a
 *     unit test can reach. (The compiled-binary-on-cluster half stays with the
 *     S3-V verification runner; this is the layer that was missing UNDER it.)
 */

// The cache handler's mutating test seams fail closed on a published subpath —
// the harness opts in (same preamble as every cache-handler suite).
process.env.KNEXT_TEST_SEAMS = "1";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type FakeRedis, startFakeRedis } from "./helpers/fake-redis";

const PKG_ROOT = resolve(import.meta.dirname, "..", "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", "..");

/** The one specifier every scaffolded vite config must hand to vinext. */
const ADAPTER_SPECIFIER = "@getknext/core/internal/vinext-cache-adapter";

/**
 * Copies that legitimately do NOT carry the wiring, each with the reason.
 * Additions here are a decision to stop requiring the wiring for that file —
 * the same "frozen bucket" discipline as create-scaffold-parity's LAYOUT map.
 */
const EXEMPT: Record<string, string> = {
    "examples/bun-exec/vite.config.ts":
        "pinned to vinext@1.0.0-beta.4 (ADR-0042 A1 benchmark recipe), which " +
        "predates the plugin `cache` option, and it installs standalone — " +
        "@getknext/core is not resolvable from its vite build",
};

const SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    "dist",
    ".output",
    ".next",
    ".claude",
    "coverage",
    "coverage-bun",
    ".turbo",
]);

/** Every vite config (checked-in or template) that invokes `vinext(`. */
function discoverVinextViteConfigs(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (SKIP_DIRS.has(entry.name)) continue;
                walk(join(dir, entry.name));
                continue;
            }
            if (
                entry.name !== "vite.config.ts" &&
                entry.name !== "vite.config.ts.hbs"
            ) {
                continue;
            }
            const full = join(dir, entry.name);
            const src = readFileSync(full, "utf8");
            if (/\bvinext\s*\(/.test(src)) {
                out.push(full.slice(root.length + 1).replaceAll("\\", "/"));
            }
        }
    };
    walk(root);
    return out.sort();
}

describe("#953 layer 1 — every vinext() vite config registers the Redis data-cache adapter", () => {
    const configs = discoverVinextViteConfigs(REPO_ROOT);

    it("the scan finds the known homes (floor, not ceiling)", () => {
        // A vacuous scan passes over zero files; pin the four shipping homes
        // plus the exempt one so the discovery itself is proven live.
        for (const known of [
            "packages/kn-next/templates/app/vite.config.ts.hbs",
            "turbo/generators/templates/zone/vite.config.ts.hbs",
            "apps/docs/vite.config.ts",
            "apps/file-manager/vite.config.ts",
            "examples/bun-exec/vite.config.ts",
        ]) {
            expect(configs, `the scan missed ${known}`).toContain(known);
        }
    });

    it("each discovered config wires cache.data.adapter (or carries a written exemption)", () => {
        const offenders: string[] = [];
        for (const rel of configs) {
            if (EXEMPT[rel]) continue;
            const src = readFileSync(join(REPO_ROOT, rel), "utf8");
            // Both halves of the wiring: the option block exists AND it names
            // the knext adapter — `cache: {}` or a typo'd specifier is row E
            // again, silently (vinext logs a warning and keeps the memory
            // handler).
            const wired =
                /cache:\s*\{[\s\S]*?data:\s*\{[\s\S]*?adapter:/.test(src) &&
                src.includes(ADAPTER_SPECIFIER);
            if (!wired) offenders.push(rel);
        }
        expect(
            offenders,
            `these vinext() configs never register the Redis data-cache adapter — ` +
                `ISR on them is vinext's per-pod memory fallback and Redis stays empty (#953 row E)`,
        ).toEqual([]);
    });

    it("every exemption still names a real file (a stale exemption is a hole)", () => {
        for (const rel of Object.keys(EXEMPT)) {
            expect(
                existsSync(join(REPO_ROOT, rel)),
                `EXEMPT names ${rel}, which no longer exists — remove the entry`,
            ).toBe(true);
        }
    });

    it("the bun-exec exemption SELF-EXPIRES: it is valid only while the example pins vinext beta.4", () => {
        // The exemption's stated reason is the beta.4 pin (predates the plugin
        // `cache` option). A reason that nothing re-checks outlives its subject
        // — the moment someone bumps the example's vinext, this reds and stays
        // red until the exemption is REMOVED and the example is wired like
        // every other vinext() config.
        const pkg = JSON.parse(
            readFileSync(
                join(REPO_ROOT, "examples/bun-exec/package.json"),
                "utf8",
            ),
        ) as { dependencies?: Record<string, string> };
        expect(
            pkg.dependencies?.vinext,
            "examples/bun-exec no longer pins vinext@1.0.0-beta.4 — the EXEMPT " +
                "entry's reason is gone: wire cache.data there and delete the exemption",
        ).toBe("1.0.0-beta.4");
    });

    it("NO imperative setCacheHandler/setDataCacheHandler registration exists outside vinext's generated module", () => {
        // The declarative plugin wiring is the ONE registration mechanism. An
        // imperative call is how the double-registration hid: apps/file-manager
        // carried a `setCacheHandler(new CacheHandler())` in cache-init.ts that
        // predated vinext (a next/cache probe that was a no-op under Next) and
        // came ALIVE under vinext's next/cache shim — it is why compat-smoke's
        // ISR check stayed green while every fresh scaffold was row-E red, and
        // with the plugin wiring added it would register the handler TWICE.
        // vinext aliases setCacheHandler → setDataCacheHandler, so both names
        // are scanned.
        const offenders: string[] = [];
        const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|hbs)$/;
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    if (SKIP_DIRS.has(entry.name)) continue;
                    if (entry.name === "__tests__") continue;
                    walk(join(dir, entry.name));
                    continue;
                }
                if (!CODE.test(entry.name)) continue;
                if (/\.(test|spec)\./.test(entry.name)) continue;
                const full = join(dir, entry.name);
                // A CALL, not a mention: comments may (and do) explain the
                // mechanism, so they are BLANKED before matching — otherwise
                // the factory's own docstring, which quotes vinext's generated
                // `setDataCacheHandler(factory(...))` line, would be an
                // offender and the fix would be deleting the explanation.
                const src = readFileSync(full, "utf8")
                    .replace(/\/\*[\s\S]*?\*\//g, "")
                    .replace(/(^|[^:])\/\/.*$/gm, "$1");
                if (/\bset(?:Data)?CacheHandler\s*\(/.test(src)) {
                    offenders.push(
                        full.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"),
                    );
                }
            }
        };
        walk(REPO_ROOT);
        expect(
            offenders,
            "imperative cache-handler registration found — the vinext() plugin's " +
                "cache.data option is the single registration mechanism (double " +
                "registration means two handler instances and an order-dependent winner)",
        ).toEqual([]);
    });
});

describe("#953 layer 2 — the adapter subpath the templates reference actually ships", () => {
    const pkg = JSON.parse(
        readFileSync(join(PKG_ROOT, "package.json"), "utf8"),
    ) as {
        exports: Record<string, unknown>;
    };

    it("package.json maps ./internal/vinext-cache-adapter to the built module", () => {
        expect(pkg.exports["./internal/vinext-cache-adapter"]).toBe(
            "./dist/adapters/vinext-cache-adapter.js",
        );
    });

    it("tsup builds it (a mapped subpath with no build entry 404s at publish)", () => {
        const tsup = readFileSync(join(PKG_ROOT, "tsup.config.ts"), "utf8");
        expect(tsup).toContain("adapters/vinext-cache-adapter");
        expect(tsup).toContain("src/adapters/vinext-cache-adapter.mjs");
    });

    it("the source module default-exports a FACTORY, not the class", async () => {
        // vinext's generated registration calls `factory({ env, options })` —
        // a bare class default (what `./adapters/cache-handler` exports for
        // next.config consumers) throws "cannot be invoked without 'new'",
        // which vinext catches, warns about, and silently replaces with the
        // memory handler. That failure shape IS row E, so the factory contract
        // is asserted directly.
        const mod = (await import(
            // @ts-expect-error — plain untyped ESM by design, same as the
            // cache-handler.js it wraps (no .d.ts is emitted for either).
            "../adapters/vinext-cache-adapter.mjs"
        )) as unknown as {
            default: (args?: { env?: unknown; options?: unknown }) => unknown;
        };
        expect(typeof mod.default).toBe("function");
        const handler = mod.default({ env: undefined, options: undefined }) as {
            get: unknown;
            set: unknown;
            revalidateTag: unknown;
        };
        expect(typeof handler.get).toBe("function");
        expect(typeof handler.set).toBe("function");
        expect(typeof handler.revalidateTag).toBe("function");
    });
});

describe("#953 layer 3 — vinext's real registration + ISR path writes SET/EX to Redis, then serves HIT and STALE", () => {
    let fake: FakeRedis;
    /** Full argv of every SET the server received, captured at the socket. */
    const setCommands: string[][] = [];
    let tmpDir: string;

    beforeAll(async () => {
        fake = await startFakeRedis({
            onCommand: (cmd, args) => {
                if (cmd === "set") setCommands.push(args);
            },
        });
        // Env BEFORE the handler module re-reads it. The runner is one process
        // per file, but the canonical cache-handler module may already be
        // loaded by an earlier import in THIS file's graph — the explicit
        // reset below makes the order a stated fact instead of a hope.
        process.env.REDIS_URL = fake.url;
        process.env.REDIS_KEY_PREFIX = "wiring";
        const canonical = (await import("../adapters/cache-handler.js")) as {
            __resetEnvForTests: () => void;
        };
        canonical.__resetEnvForTests();

        tmpDir = join(PKG_ROOT, `.tmp-vinext-wiring-${process.pid}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterAll(async () => {
        rmSync(tmpDir, { recursive: true, force: true });
        await fake.close();
        delete process.env.REDIS_URL;
        delete process.env.REDIS_KEY_PREFIX;
    });

    it("registers knext's handler through vinext's OWN generated module, then vinext's isrSet/isrGet round-trip through the fake Redis", async () => {
        const { generateCacheAdaptersModule } = (await import(
            "vinext/internal/cache-adapters"
        )) as unknown as {
            generateCacheAdaptersModule: (cache: {
                data: { adapter: string };
            }) => string;
        };
        const { getDataCacheHandler } = (await import(
            "vinext/shims/cache-handler"
        )) as unknown as {
            getDataCacheHandler: () => object;
        };
        const canonical = (await import("../adapters/cache-handler.js")) as {
            default: new () => object;
        };

        // NEGATIVE HALF, first: before registration vinext serves ISR from its
        // per-pod MemoryCacheHandler — the exact state row E observed. If this
        // ever starts as OUR handler, the positive assertion below is vacuous.
        expect(getDataCacheHandler().constructor.name).toBe(
            "MemoryCacheHandler",
        );
        expect(getDataCacheHandler()).not.toBeInstanceOf(canonical.default);

        // Generate the registration module EXACTLY as vinext's vite plugin
        // does for `vinext({ cache: { data: { adapter } } })` — same codegen
        // function, same shape. The descriptor points at the SOURCE twin of
        // the module the published subpath maps to (layer 2 pins that the two
        // are the same file, built); a scaffolded app's vite build resolves
        // the published specifier instead and inlines it into the server
        // bundle.
        const generated = generateCacheAdaptersModule({
            data: {
                adapter: join(
                    PKG_ROOT,
                    "src",
                    "adapters",
                    "vinext-cache-adapter.mjs",
                ),
            },
        });
        const genPath = join(tmpDir, "vinext-cache-adapters.gen.mjs");
        writeFileSync(genPath, generated);
        const { registerConfiguredCacheAdapters } = (await import(
            pathToFileURL(genPath).href
        )) as unknown as {
            registerConfiguredCacheAdapters: (env: unknown) => void;
        };
        registerConfiguredCacheAdapters({});

        // Registration must have REPLACED the memory handler with knext's —
        // vinext swallows a throwing factory (logs + keeps the default), so
        // instance identity is the only signal that registration truly landed.
        expect(getDataCacheHandler()).toBeInstanceOf(canonical.default);

        // Now drive vinext's REAL page-level ISR path: isrSet/isrGet go
        // through DefaultCdnCacheAdapter → getDataCacheHandler() → Redis.
        const isr = (await import(
            "vinext/internal/server/isr-cache"
        )) as unknown as {
            isrCacheControl: (
                revalidate: number | false,
            ) => Record<string, unknown>;
            isrSet: (
                key: string,
                data: unknown,
                policy: {
                    cacheControl: Record<string, unknown>;
                    tags?: string[];
                },
            ) => Promise<void>;
            isrGet: (key: string) => Promise<{
                value: { value: { html?: string } };
                isStale: boolean;
            } | null>;
        };

        await isr.isrSet(
            "/isr",
            {
                kind: "APP_PAGE",
                html: "<h1>rendered-once</h1>",
                rscData: undefined,
                headers: undefined,
                postponed: undefined,
                status: 200,
            },
            { cacheControl: isr.isrCacheControl(1), tags: [] },
        );

        // The write reached the SOCKET (not the in-memory fallback), keyed by
        // the injected prefix…
        const isrSets = setCommands.filter(
            (args) => args[0] === "wiring:cache:/isr",
        );
        expect(
            isrSets.length,
            "no SET for the ISR key reached Redis — the write went to the memory fallback (row E)",
        ).toBeGreaterThan(0);

        // …and it carries an EX that OUTLIVES the revalidate window. `EX 1`
        // (TTL == revalidate) is the #886 regression: the entry is evicted at
        // the moment it becomes stale-but-servable, so STALE is unreachable
        // and every request past the window is a cold MISS.
        const [, , ...ttlArgs] = isrSets[0];
        const exIndex = ttlArgs.findIndex((a) => a.toUpperCase() === "EX");
        expect(exIndex, "the ISR SET carries no EX — unbounded key").not.toBe(
            -1,
        );
        // PINNED, not merely bounded. `isrCacheControl(1)` yields
        // `{ revalidate: 1 }` with NO expire claim, so `__redisTtlSeconds`
        // takes its no-expire branch: max(revalidate * 2, 3600) = 3600. (A
        // route whose render CLAIMS an expire — e.g. cacheLife's 1-year
        // default, which is what a booted file-manager bundle writes — gets
        // that expire as the TTL instead; this path is the claimless one.)
        // The exact value is the guard: `EX 1` (TTL == revalidate) is the
        // #886 regression where the entry is evicted at the moment it becomes
        // stale-but-servable.
        const ttlSeconds = Number(ttlArgs[exIndex + 1]);
        expect(
            ttlSeconds,
            "Redis TTL must be the no-expire floor (3600s), never the revalidate window (#886 / #953 acceptance)",
        ).toBe(3600);

        // HIT while fresh: served from Redis, body intact, not stale.
        const hit = await isr.isrGet("/isr");
        expect(hit).not.toBeNull();
        expect(hit?.isStale).toBe(false);
        expect(hit?.value.value.html).toBe("<h1>rendered-once</h1>");
        expect(
            fake.received,
            "the read never touched the socket — it was served from memory",
        ).toContain("get");

        // STALE once the window passes: vinext's own interpretation of the
        // `cacheState` knext's handler labels on read (#940's contract, now
        // proven THROUGH vinext rather than beside it). The entry still
        // EXISTS in Redis — stale-while-revalidate serves it while a
        // background render replaces it.
        await Bun.sleep(1100);
        const stale = await isr.isrGet("/isr");
        expect(stale).not.toBeNull();
        expect(stale?.isStale).toBe(true);
        expect(stale?.value.value.html).toBe("<h1>rendered-once</h1>");
        expect(fake.strings.has("wiring:cache:/isr")).toBe(true);
    });
});
