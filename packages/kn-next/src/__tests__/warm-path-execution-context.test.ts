/**
 * The vinext entries warm KNEXT_WARM_PATH in-process through `nitro.fetch`.
 * Live requests run inside the runtime contract's execution context, whose
 * `waitUntil` registers `after()` work with the SIGTERM/bake drain. The warm
 * fetch must run inside it too: otherwise an `after()` on a warm route is
 * fire-and-forget, and the node entry's image bake (KNEXT_COMPILE_CACHE_BAKE=1)
 * — or a SIGTERM soon after boot — exits before that work finishes.
 *
 * Each scaffolded entry is booted UNMODIFIED beside the scaffolded runtime
 * contract. Only its build-time imports are stood in for: nitro's app (a route
 * that schedules `after()` work writing a marker file), vinext's request
 * context (AsyncLocalStorage, and an `after()` that registers with the active
 * context's `waitUntil` or else runs detached, as vinext's does), and the
 * @getknext/core internals and sharp as no-ops. srvx is the real package.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const tmp = mkdtempSync(join(tmpdir(), "knext-warm-ctx-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A new directory under `tmp` (removed with it in afterAll). */
let freshDirs = 0;
const freshDir = (prefix: string) => {
    const d = join(tmp, `${prefix}-${++freshDirs}`);
    mkdirSync(d);
    return d;
};

/** How long the warm route's after() work takes — longer than a bare exit. */
const AFTER_MS = 600;

function writeApp(entryTemplate: string, contractPath: string): string {
    const dir = freshDir("app");
    const w = (rel: string, text: string) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
    };
    copyFileSync(join(REPO_ROOT, entryTemplate), join(dir, "entry.mjs"));
    copyFileSync(
        join(REPO_ROOT, contractPath),
        join(dir, "runtime-contract.mjs"),
    );
    w(
        "package.json",
        JSON.stringify({
            type: "module",
            imports: { "#nitro/virtual/polyfills": "./stub-polyfills.mjs" },
        }),
    );
    w("stub-polyfills.mjs", "");
    const pkg = (name: string, exportsMap: Record<string, string>) =>
        w(
            `node_modules/${name}/package.json`,
            JSON.stringify({ name, type: "module", exports: exportsMap }),
        );
    pkg("vinext", { "./shims/request-context": "./request-context.mjs" });
    w(
        "node_modules/vinext/request-context.mjs",
        [
            "import { AsyncLocalStorage } from 'node:async_hooks';",
            "const als = new AsyncLocalStorage();",
            "export const runWithExecutionContext = (ctx, fn) => als.run(ctx, fn);",
            "export const currentExecutionContext = () => als.getStore();",
        ].join("\n"),
    );
    pkg("nitro", { "./app": "./app.mjs" });
    // Faithful to vinext's function-form after(): its completion is tied to
    // the RESPONSE BODY closing (the body is piped through a passthrough, and
    // only its end settles the promise handed to waitUntil). A caller that
    // never reads the body leaves that promise pending forever — so the drain
    // hangs to its hard cap. The body stream pulls lazily (highWaterMark 0),
    // so nothing closes it except a reader.
    w(
        "node_modules/nitro/app.mjs",
        [
            "import { writeFileSync } from 'node:fs';",
            "import { currentExecutionContext } from 'vinext/shims/request-context';",
            "export const useNitroApp = () => ({",
            "  fetch: async (req) => {",
            "    if (new URL(req.url).pathname === '/warm-forever') {",
            "      let timer;",
            "      return new Response(new ReadableStream({",
            "        start(c) { timer = setInterval(() => c.enqueue(new TextEncoder().encode('.')), 50); },",
            "        cancel() { clearInterval(timer); },",
            "      }));",
            "    }",
            "    let bodyClosed;",
            "    const closed = new Promise((r) => { bodyClosed = r; });",
            "    let sent = false;",
            "    const body = new ReadableStream({",
            "      pull(c) {",
            "        if (!sent) { sent = true; c.enqueue(new TextEncoder().encode('ok')); return; }",
            "        c.close();",
            "        bodyClosed();",
            "      },",
            "      cancel() { bodyClosed(); },",
            "    }, { highWaterMark: 0 });",
            "    if (new URL(req.url).pathname === '/warm-after') {",
            `      const task = closed.then(() => new Promise((r) => setTimeout(() => { writeFileSync(process.env.KNEXT_TEST_MARKER, 'done'); r(); }, ${AFTER_MS})));`,
            "      const ctx = currentExecutionContext();",
            "      if (ctx && ctx.waitUntil) ctx.waitUntil(task);",
            "    }",
            "    return new Response(body);",
            "  },",
            "});",
        ].join("\n"),
    );
    pkg("@getknext/core", {
        "./internal/vinext-image-optimizer": "./image.mjs",
        "./internal/response-cache-control": "./cache-control.mjs",
    });
    w(
        "node_modules/@getknext/core/image.mjs",
        "export const handleImageRequest = async () => null;\n",
    );
    w(
        "node_modules/@getknext/core/cache-control.mjs",
        "export const applyVinextDeployDefault = () => {};\n" +
            "export const cacheControlMiddleware = () => (_req, next) => next();\n",
    );
    pkg("sharp", { ".": "./index.mjs" });
    w("node_modules/sharp/index.mjs", "export default {};\n");
    symlinkSync(
        realpathSync(join(REPO_ROOT, "apps/file-manager/node_modules/srvx")),
        join(dir, "node_modules/srvx"),
    );
    return dir;
}

type Run = { code: number | null; out: string; marker: boolean };

/** Boot the entry; `sigtermAfterWarm` sends SIGTERM once the warm path answered. */
function run(
    bin: string,
    dir: string,
    env: Record<string, string>,
    sigtermAfterWarm: boolean,
): Promise<Run> {
    const marker = join(dir, "after-ran");
    return new Promise((resolveRun) => {
        const child = spawn(bin, [join(dir, "entry.mjs")], {
            cwd: dir,
            env: {
                ...process.env,
                PORT: "0",
                METRICS_PORT: "0",
                HOSTNAME: "127.0.0.1",
                NODE_ENV: "production",
                KNEXT_WARM_PATH: "/warm-after",
                KNEXT_TEST_MARKER: marker,
                SHUTDOWN_GRACE_MS: "4000",
                ...env,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let signalled = false;
        const onData = (d: Buffer) => {
            out += d.toString();
            if (
                sigtermAfterWarm &&
                !signalled &&
                /WARMED:\S+ status=/.test(out)
            ) {
                signalled = true;
                child.kill("SIGTERM");
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        const killer = setTimeout(() => child.kill("SIGKILL"), 30_000);
        child.on("exit", (code) => {
            clearTimeout(killer);
            resolveRun({ code, out, marker: existsSync(marker) });
        });
    });
}

describe("warm-path after() work is drained", () => {
    it("node entry: the image bake waits for a warm route's after() before exiting", async () => {
        const dir = writeApp(
            "packages/kn-next/templates/app/knext-node-entry.mjs.hbs",
            "packages/kn-next/templates/app/runtime-contract.mjs.hbs",
        );
        const r = await run(
            "node",
            dir,
            { KNEXT_COMPILE_CACHE_BAKE: "1" },
            false,
        );
        expect(r.out).toContain("WARMED:/warm-after status=200");
        expect({ code: r.code, afterRan: r.marker }).toEqual({
            code: 0,
            afterRan: true,
        });
    }, 60_000);

    it("node entry: SIGTERM right after the warm drains its after() work", async () => {
        const dir = writeApp(
            "packages/kn-next/templates/app/knext-node-entry.mjs.hbs",
            "packages/kn-next/templates/app/runtime-contract.mjs.hbs",
        );
        const r = await run("node", dir, {}, true);
        expect({ code: r.code, afterRan: r.marker }).toEqual({
            code: 0,
            afterRan: true,
        });
    }, 60_000);

    const BUN_ENTRIES = [
        [
            "packages/kn-next/templates/app/knext-bun-entry.mjs.hbs",
            "packages/kn-next/templates/app/runtime-contract.mjs.hbs",
        ],
        [
            "turbo/generators/templates/zone/knext-bun-entry.mjs.hbs",
            "turbo/generators/templates/zone/runtime-contract.mjs.hbs",
        ],
        [
            "apps/file-manager/knext-bun-entry.mjs",
            "apps/file-manager/runtime-contract.mjs",
        ],
        ["apps/docs/knext-bun-entry.mjs", "apps/docs/runtime-contract.mjs"],
        [
            "examples/bun-exec/knext-bun-entry.mjs",
            "examples/bun-exec/runtime-contract.mjs",
        ],
    ];
    for (const [entry, contract] of BUN_ENTRIES) {
        it(`${entry}: SIGTERM right after the warm drains its after() work`, async () => {
            const r = await run(
                process.execPath,
                writeApp(entry, contract),
                {},
                true,
            );
            expect(r.out).toContain("WARMED:/warm-after status=200");
            expect({ code: r.code, afterRan: r.marker }).toEqual({
                code: 0,
                afterRan: true,
            });
        }, 60_000);
    }

    // A warm route whose body never ends must not hang the process: the read
    // is bounded by SHUTDOWN_GRACE_MS, then the body is cancelled.
    it("node entry: a bake whose warm body never ends exits within the cap, logged", async () => {
        const dir = writeApp(
            "packages/kn-next/templates/app/knext-node-entry.mjs.hbs",
            "packages/kn-next/templates/app/runtime-contract.mjs.hbs",
        );
        const t0 = Date.now();
        const r = await run(
            "node",
            dir,
            {
                KNEXT_COMPILE_CACHE_BAKE: "1",
                KNEXT_WARM_PATH: "/warm-forever",
                SHUTDOWN_GRACE_MS: "1500",
            },
            false,
        );
        expect(Date.now() - t0).toBeLessThan(15_000);
        expect(r.out).toContain("WARM_BODY_TIMEOUT:/warm-forever");
        // A bake that could not finish its warm path fails loudly, never hangs.
        expect(r.code).toBe(1);
    }, 60_000);

    for (const [entry, contract] of BUN_ENTRIES) {
        it(`${entry}: a warm body that never ends is cancelled at the cap and the pod still drains`, async () => {
            const t0 = Date.now();
            const r = await run(
                process.execPath,
                writeApp(entry, contract),
                { KNEXT_WARM_PATH: "/warm-forever", SHUTDOWN_GRACE_MS: "1500" },
                true,
            );
            expect(Date.now() - t0).toBeLessThan(15_000);
            expect(r.out).toContain("WARM_BODY_TIMEOUT:/warm-forever");
            expect(r.code).toBe(0);
        }, 60_000);
    }
});
