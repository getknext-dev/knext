/**
 * The adapter wires the shared `'use cache'` backend (`cacheHandlers`) the same
 * way it wires the singular `cacheHandler`, and only when the app uses knext's.
 *
 *   - runtime `node` -> the node entries (literal ioredis import, traced into the
 *     image); `bun` -> the bun entries (Bun's native client);
 *   - BOTH `default` and `remote` kinds are wired: Next keeps a no-op built-in for
 *     any kind left unset, so wiring only `default` would leave
 *     `'use cache: remote'` silently uncached;
 *   - the app's own entry for a kind wins, per key;
 *   - an unset or unknown runtime, or a user's own `cacheHandler`, is left alone;
 *   - a scaffold that sets `cacheMaxMemorySize: 0` is never left with Next's no-op
 *     `'use cache'` handler (the guard at the bottom reads the real templates).
 */
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import adapter from "../adapters/next-adapter";

type ModifyConfig = NonNullable<typeof adapter.modifyConfig>;
const modifyConfig = adapter.modifyConfig as ModifyConfig;
type Out = {
    cacheHandler?: string;
    cacheHandlers?: Record<string, string>;
    cacheMaxMemorySize?: number;
};

const here = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(here, "../..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");

const dir = mkdtempSync(join(tmpdir(), "knext-adapter-uc-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const saved = process.env.KNEXT_RUNTIME;
afterEach(() => {
    if (saved === undefined) delete process.env.KNEXT_RUNTIME;
    else process.env.KNEXT_RUNTIME = saved;
});

function file(name: string, body: string): string {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
}

const KNEXT_REEXPORT = file(
    "cache-handler.js",
    'export { default } from "@getknext/core/adapters/cache-handler";\n',
);
const USER_HANDLER = file(
    "my-cache-handler.js",
    "export default class MyHandler { async get() { return null; } async set() {} }\n",
);

function run(
    runtime: string | undefined,
    config: Record<string, unknown>,
): Out {
    if (runtime === undefined) delete process.env.KNEXT_RUNTIME;
    else process.env.KNEXT_RUNTIME = runtime;
    spyOn(console, "log").mockImplementation(() => {});
    return modifyConfig(
        {
            images: { customCacheHandler: false },
            ...config,
        } as Parameters<ModifyConfig>[0],
        { phase: "phase-production-build" } as Parameters<ModifyConfig>[1],
    ) as Out;
}

describe("adapter.modifyConfig -- cacheHandlers follows the configured runtime", () => {
    it("node -> the node 'use cache' entries, for BOTH default and remote", () => {
        const out = run("node", { cacheHandler: KNEXT_REEXPORT });
        expect(out.cacheHandlers?.default).toMatch(
            /[\\/]adapters[\\/]use-cache-handler-node\.js$/,
        );
        expect(out.cacheHandlers?.remote).toMatch(
            /[\\/]adapters[\\/]use-cache-handler-remote-node\.js$/,
        );
    });

    it("bun -> the bun 'use cache' entries, for BOTH default and remote", () => {
        const out = run("bun", { cacheHandler: KNEXT_REEXPORT });
        expect(out.cacheHandlers?.default).toMatch(
            /[\\/]adapters[\\/]use-cache-handler-bun\.js$/,
        );
        expect(out.cacheHandlers?.remote).toMatch(
            /[\\/]adapters[\\/]use-cache-handler-remote-bun\.js$/,
        );
    });

    it("an app's own entry for a kind wins, per key; the other kind is still wired", () => {
        const own = file("own-uc.js", "export default {};\n");
        const out = run("node", {
            cacheHandler: KNEXT_REEXPORT,
            cacheHandlers: { default: own },
        });
        expect(out.cacheHandlers?.default).toBe(own);
        expect(out.cacheHandlers?.remote).toMatch(
            /use-cache-handler-remote-node\.js$/,
        );

        const onlyRemote = run("node", {
            cacheHandler: KNEXT_REEXPORT,
            cacheHandlers: { remote: own },
        });
        expect(onlyRemote.cacheHandlers?.remote).toBe(own);
        expect(onlyRemote.cacheHandlers?.default).toMatch(
            /use-cache-handler-node\.js$/,
        );
    });

    it("keeps unrelated cacheHandlers kinds the app configured", () => {
        const custom = file("custom-kind.js", "export default {};\n");
        const out = run("node", {
            cacheHandler: KNEXT_REEXPORT,
            cacheHandlers: { analytics: custom },
        });
        expect(out.cacheHandlers?.analytics).toBe(custom);
    });

    it("no runtime exported (next dev, a plain next build) -> not wired", () => {
        expect(
            run(undefined, { cacheHandler: KNEXT_REEXPORT }).cacheHandlers,
        ).toBeUndefined();
    });

    it("an unknown runtime -> not wired, never guessed", () => {
        expect(
            run("deno", { cacheHandler: KNEXT_REEXPORT }).cacheHandlers,
        ).toBeUndefined();
    });

    it("a user's own cacheHandler -> not wired (their cache, their contract)", () => {
        expect(
            run("node", { cacheHandler: USER_HANDLER }).cacheHandlers,
        ).toBeUndefined();
        expect(
            run("bun", { cacheHandler: USER_HANDLER }).cacheHandlers,
        ).toBeUndefined();
    });

    it("no cacheHandler at all -> not wired", () => {
        expect(run("node", {}).cacheHandlers).toBeUndefined();
    });
});

/**
 * The scaffold guard (mutation target). A template that sets
 * `cacheMaxMemorySize: 0` turns Next's built-in `'use cache'` handler into a
 * no-op in production. That is only acceptable while the adapter replaces it, so
 * for every template that goes through the adapter, the REAL generated
 * `cache-handler.js` plus the template's own `cacheMaxMemorySize` must come out
 * of `modifyConfig` with both kinds wired.
 */
describe("scaffold guard: cacheMaxMemorySize: 0 never leaves 'use cache' a silent no-op", () => {
    const uncommented = (src: string) =>
        src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    /** Every next.config template in the repo's scaffolders. */
    const templates = [
        join(PKG_ROOT, "templates", "app", "next.config.ts.hbs"),
        join(PKG_ROOT, "templates", "app", "next.config.ts.vinext.hbs"),
        join(
            REPO_ROOT,
            "turbo",
            "generators",
            "templates",
            "zone",
            "next.config.ts.hbs",
        ),
    ];

    it("finds the scaffolds (anti-vacuity)", () => {
        const sets = templates.filter((t) =>
            /cacheMaxMemorySize:\s*0\b/.test(
                uncommented(readFileSync(t, "utf8")),
            ),
        );
        expect(sets.length).toBeGreaterThanOrEqual(1);
        // The generated cache-handler.js is the one-line knext re-export.
        expect(
            readFileSync(
                join(PKG_ROOT, "templates", "app", "cache-handler.js.hbs"),
                "utf8",
            ),
        ).toContain(
            'export { default } from "@getknext/core/adapters/cache-handler"',
        );
    });

    for (const t of templates) {
        const name = t.replace(`${REPO_ROOT}/`, "");
        it(`${name}: wired by the adapter, or not an adapter scaffold`, () => {
            const src = uncommented(readFileSync(t, "utf8"));
            if (!/cacheMaxMemorySize:\s*0\b/.test(src)) return;
            const usesAdapter = /\badapterPath\s*:/.test(src);
            if (!usesAdapter) {
                // vinext targets never read `cacheHandler`/`cacheHandlers`: their
                // cache is vinext's own adapter, so this guard has no subject.
                expect(src).not.toMatch(/\bcacheHandlers\s*:/);
                return;
            }
            const handler = file(
                `scaffold-${name.replaceAll("/", "_")}.js`,
                // The file the scaffolder really generates next to the config.
                readFileSync(
                    join(PKG_ROOT, "templates", "app", "cache-handler.js.hbs"),
                    "utf8",
                ),
            );
            const out = run("node", {
                cacheHandler: handler,
                cacheMaxMemorySize: 0,
            });
            expect(
                out.cacheHandlers?.default,
                `${name} would ship a no-op 'use cache'`,
            ).toBeDefined();
            expect(
                out.cacheHandlers?.remote,
                `${name} would ship a no-op 'use cache: remote'`,
            ).toBeDefined();
        });
    }

    it("the scaffold's cacheHandler is the knext re-export the adapter recognises", () => {
        const src = readFileSync(
            join(PKG_ROOT, "templates", "app", "next.config.ts.hbs"),
            "utf8",
        );
        expect(uncommented(src)).toMatch(
            /cacheHandler:\s*new URL\("\.\/cache-handler\.js"/,
        );
        // Keep this list honest: a new next.config template must be added above.
        const found = readdirSync(join(PKG_ROOT, "templates", "app")).filter(
            (f) => f.startsWith("next.config.ts"),
        );
        expect(found.sort()).toEqual([
            "next.config.ts.hbs",
            "next.config.ts.vinext.hbs",
        ]);
    });
});
