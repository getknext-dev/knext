/**
 * The compiled vinext executable applies the same deployed-platform
 * Cache-Control normalization as knext's Node runtime (#1322, compat group G1).
 *
 * Next's origin always emits shared-cache directives (`s-maxage=…,
 * stale-while-revalidate=…`); a deployed platform hands clients
 * `public, max-age=0, must-revalidate`. knext's standalone runtimes apply that
 * rule (`cache-control-normalize.cjs`, the same rules as the official reference
 * adapter-bun), and the official deploy-mode suite asserts it
 * (`test/e2e/prerender.test.ts`: "caching headers for a revalidate page" —
 * Expected "public, max-age=0, must-revalidate", Received
 * "s-maxage=2, stale-while-revalidate=31535998" on the vinext lane). The vinext
 * executable serves through `Bun.serve`, which that module's `node:http` patch
 * never reaches, so `bun-serve-cache-control.mjs` applies the SAME pure rule at
 * the `Bun.serve` seam, and `vinext-compile` bakes it into the binary.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");
const DEPLOY = "public, max-age=0, must-revalidate";
const ISR = "s-maxage=2, stale-while-revalidate=31535998";
const SHELL = "private, no-cache, no-store, max-age=0, must-revalidate";

// The module imports cache-control-normalize.cjs, whose load-time side effect
// patches node:http in THIS test process unless disabled; disable it for the
// import (as cache-control-normalize.test.ts does), then restore the env.
type Mod = typeof import("../adapters/bun-serve-cache-control.mjs");
let install: Mod["install"];
let normalizeResponse: Mod["normalizeResponse"];
let shouldInstall: Mod["shouldInstall"];
let wrapFetch: Mod["wrapFetch"];
beforeAll(async () => {
    const prev = process.env.KNEXT_CACHE_CONTROL_NORMALIZE;
    process.env.KNEXT_CACHE_CONTROL_NORMALIZE = "0";
    const mod = await import("../adapters/bun-serve-cache-control.mjs");
    if (prev === undefined) delete process.env.KNEXT_CACHE_CONTROL_NORMALIZE;
    else process.env.KNEXT_CACHE_CONTROL_NORMALIZE = prev;
    ({ install, normalizeResponse, shouldInstall, wrapFetch } = mod);
});

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function res(headers: Record<string, string>): Response {
    return new Response("x", { headers });
}
function req(method: string, path = "/"): Request {
    return new Request(`http://localhost${path}`, { method });
}

describe("normalizeResponse (the rule, at the Bun.serve seam)", () => {
    it("rewrites s-maxage for GET and HEAD", () => {
        for (const m of ["GET", "HEAD"]) {
            const r = normalizeResponse(
                req(m),
                res({ "cache-control": ISR }),
            ) as Response;
            expect(r.headers.get("cache-control"), m).toBe(DEPLOY);
        }
        const r = normalizeResponse(
            req("GET"),
            res({ "cache-control": "s-maxage=31536000" }),
        ) as Response;
        expect(r.headers.get("cache-control")).toBe(DEPLOY);
    });

    it("leaves immutable assets, non-GET/HEAD requests and absent headers alone", () => {
        const imm = "public, max-age=31536000, immutable";
        expect(
            (
                normalizeResponse(
                    req("GET"),
                    res({ "cache-control": imm }),
                ) as Response
            ).headers.get("cache-control"),
        ).toBe(imm);
        expect(
            (
                normalizeResponse(
                    req("POST"),
                    res({ "cache-control": ISR }),
                ) as Response
            ).headers.get("cache-control"),
        ).toBe(ISR);
        expect(
            (normalizeResponse(req("GET"), res({})) as Response).headers.get(
                "cache-control",
            ),
        ).toBeNull();
    });

    it("normalizes a fallback shell only with an x-nextjs-cache marker and never on /_next/data", () => {
        const marked = { "cache-control": SHELL, "x-nextjs-cache": "MISS" };
        expect(
            (
                normalizeResponse(req("GET"), res(marked)) as Response
            ).headers.get("cache-control"),
        ).toBe(DEPLOY);
        expect(
            (
                normalizeResponse(
                    req("GET"),
                    res({ "cache-control": SHELL }),
                ) as Response
            ).headers.get("cache-control"),
        ).toBe(SHELL);
        expect(
            (
                normalizeResponse(
                    req("GET", "/_next/data/b/p.json"),
                    res(marked),
                ) as Response
            ).headers.get("cache-control"),
        ).toBe(SHELL);
    });

    it("never throws on immutable headers or a non-Response", () => {
        const immutable = Response.error();
        expect(() => normalizeResponse(req("GET"), immutable)).not.toThrow();
        expect(normalizeResponse(req("GET"), undefined)).toBeUndefined();
    });
});

describe("wiring", () => {
    it("wrapFetch normalizes sync and async handler results and passes the request through", async () => {
        const sync = wrapFetch(() => res({ "cache-control": ISR }));
        expect(
            (sync(req("GET")) as Response).headers.get("cache-control"),
        ).toBe(DEPLOY);
        const asyncH = wrapFetch(async () => res({ "cache-control": ISR }));
        expect(
            ((await asyncH(req("GET"))) as Response).headers.get(
                "cache-control",
            ),
        ).toBe(DEPLOY);
        const post = wrapFetch(() => res({ "cache-control": ISR }));
        expect(
            (post(req("POST")) as Response).headers.get("cache-control"),
        ).toBe(ISR);
    });

    it("installs only on Bun, and KNEXT_CACHE_CONTROL_NORMALIZE=0 turns it off (same switch as the Node runtime)", () => {
        const bun = { serve: () => 0 };
        expect(shouldInstall({}, bun)).toBe(true);
        expect(shouldInstall({ KNEXT_CACHE_CONTROL_NORMALIZE: "0" }, bun)).toBe(
            false,
        );
        expect(shouldInstall({}, undefined)).toBe(false);
        expect(shouldInstall({}, {})).toBe(false);
    });

    it("patches serve() so its fetch is wrapped, idempotently", () => {
        let seen: unknown;
        const bun = {
            serve(opts: { fetch: (r: Request) => unknown }) {
                seen = opts;
                return 0;
            },
        };
        expect(install(bun, {})).toBe(true);
        const patched = bun.serve;
        expect(install(bun, {})).toBe(true);
        expect(bun.serve).toBe(patched);
        bun.serve({ fetch: () => res({ "cache-control": ISR }) });
        const r = (seen as { fetch: (r: Request) => Response }).fetch(
            req("GET"),
        );
        expect(r.headers.get("cache-control")).toBe(DEPLOY);
    });
});

describe("vinext-compile bakes it into the executable", () => {
    const work = realpathSync(mkdtempSync(join(tmpdir(), "knext-1322-cc-")));
    temps.push(work);
    const server = join(work, ".output", "server");
    mkdirSync(server, { recursive: true });
    writeFileSync(
        join(server, "index.mjs"),
        "const s = Bun.serve({ port: Number(process.env.PORT), fetch() {\n" +
            `  return new Response("ok", { headers: { "cache-control": ${JSON.stringify(ISR)} } });\n` +
            '} });\nconsole.log("LISTENING:" + s.port);\n',
    );
    const exe = join(work, "knext-1322-exec");
    const build = spawnSync(
        process.execPath,
        [COMPILE, "--entry", join(server, "index.mjs"), "--outfile", exe],
        {
            cwd: work,
            encoding: "utf8",
        },
    );

    async function serveOnce(
        env: Record<string, string>,
    ): Promise<string | null> {
        const child = spawn(exe, [], {
            cwd: work,
            // Explicit per case, so an inherited value cannot decide the result.
            env: {
                ...process.env,
                PORT: "0",
                KNEXT_CACHE_CONTROL_NORMALIZE: "",
                ...env,
            },
        });
        try {
            const port = await new Promise<number>((ok, fail) => {
                let buf = "";
                child.stdout.on("data", (d) => {
                    buf += d;
                    const m = buf.match(/LISTENING:(\d+)/);
                    if (m) ok(Number(m[1]));
                });
                child.on("exit", (c) => fail(new Error(`exited ${c}: ${buf}`)));
                setTimeout(
                    () => fail(new Error(`no LISTENING: ${buf}`)),
                    30_000,
                );
            });
            const r = await fetch(`http://127.0.0.1:${port}/`);
            await r.text();
            return r.headers.get("cache-control");
        } finally {
            child.kill("SIGKILL");
        }
    }

    it("refuses to compile (fail closed) when the normalization module is missing beside it", () => {
        // A copy of the compile script with every sibling it needs EXCEPT the
        // install module: the script must exit non-zero, naming what is missing.
        const alone = realpathSync(
            mkdtempSync(join(tmpdir(), "knext-1322-cc-missing-")),
        );
        temps.push(alone);
        const here = resolve(import.meta.dir, "../adapters");
        for (const f of [
            "vinext-compile.mjs",
            "entry-require-staticize.mjs",
            "bun-serve-keepalive-guard.mjs",
            "sharp-addon-dlopen.mjs",
            // the sidecar resolver is checked (fail-closed) before this module
            "sidecar-install.mjs",
            "sidecar-runtime.mjs",
            "entry-external-sidecar.mjs",
        ]) {
            copyFileSync(join(here, f), join(alone, f));
        }
        const r = spawnSync(
            process.execPath,
            [
                join(alone, "vinext-compile.mjs"),
                "--entry",
                join(server, "index.mjs"),
                "--outfile",
                join(alone, "x"),
            ],
            { cwd: alone, encoding: "utf8" },
        );
        expect(r.status).not.toBe(0);
        expect(r.stderr).toContain("Cache-Control normalization is missing");
    });

    it("compiles", () => {
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    });

    it("the running executable serves the deployed Cache-Control", async () => {
        expect(await serveOnce({})).toBe(DEPLOY);
    });

    it("KNEXT_CACHE_CONTROL_NORMALIZE=0 serves the origin value (bring-your-own CDN)", async () => {
        expect(await serveOnce({ KNEXT_CACHE_CONTROL_NORMALIZE: "0" })).toBe(
            ISR,
        );
    });
});
