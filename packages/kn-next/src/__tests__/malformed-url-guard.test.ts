/**
 * Request URL decoding hardening for the vinext entries.
 *
 * h3's event constructor runs `decodeURI` on the request path before any app
 * code, and throws on a path that is not valid percent-encoding. Under the
 * vinext entries that throw lands inside srvx's middleware chain: on Node the
 * rejected promise has no handler and the process exits; on Bun it becomes a
 * 500. The scaffolded runtime contract answers such a path with a 400 BEFORE h3
 * (`rejectMalformedPath`), and every entry passes `requestErrorResponse` as
 * srvx's `error` handler so any other request-path failure is a 500 response,
 * never a dead process.
 *
 * What is proved here:
 *   - the guard's verdict equals h3's own (a real h3 app over a path corpus);
 *   - on real srvx + h3, under node AND under bun, each malformed path answers
 *     400 and the server keeps serving; a handler that fails after the guard
 *     answers 500 without leaking the error; and a CONTROL run without the
 *     wiring shows the failure this closes (node exits);
 *   - every shipped entry wires both halves, and every copy of the contract
 *     carries the same implementation.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../..");
const HARNESS = join(HERE, "fixtures/malformed-url-harness.mjs");
const METRICS_HARNESS = join(HERE, "fixtures/metrics-listener-harness.mjs");

/** Every copy of the runtime contract a vinext app ships. */
const CONTRACTS = [
    "packages/kn-next/templates/app/runtime-contract.mjs.hbs",
    "turbo/generators/templates/zone/runtime-contract.mjs.hbs",
    "apps/file-manager/runtime-contract.mjs",
    "apps/docs/runtime-contract.mjs",
    "examples/bun-exec/runtime-contract.mjs",
];
/** Every vinext server entry that serves app traffic through srvx. */
const ENTRIES = [
    "packages/kn-next/templates/app/knext-bun-entry.mjs.hbs",
    "packages/kn-next/templates/app/knext-node-entry.mjs.hbs",
    "turbo/generators/templates/zone/knext-bun-entry.mjs.hbs",
    "apps/file-manager/knext-bun-entry.mjs",
    "apps/docs/knext-bun-entry.mjs",
    "examples/bun-exec/knext-bun-entry.mjs",
];

/** Paths `decodeURI` rejects — each must be a 400. */
const MALFORMED = [
    "/%2/",
    "/%E0%A4%A",
    "/%",
    "/%%",
    "/a%2",
    "/%C0%AF",
    "/ok/%zz",
    `/${"%zz%".repeat(2000)}`,
];
/** Paths that decode fine (or keep their escapes) — each must pass through. */
const VALID = [
    "/",
    "/%00",
    "/%25",
    "/%2525",
    "/a%20b",
    "/%2F",
    "/%E2%9C%93",
    "/users?q=%zz",
];

// The template is plain JS behind a .hbs extension; import a .mjs copy.
const tmp = mkdtempSync(join(tmpdir(), "knext-malformed-url-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
/** A new directory under `tmp` (removed with it in afterAll). */
let freshDirs = 0;
const freshDir = (prefix: string) => {
    const d = join(tmp, `${prefix}-${++freshDirs}`);
    mkdirSync(d);
    return d;
};
const CONTRACT = join(tmp, "runtime-contract.mjs");
copyFileSync(join(REPO_ROOT, CONTRACTS[0]), CONTRACT);
const contract = await import(CONTRACT);

// srvx and h3 exactly as a vinext app resolves them: file-manager depends on
// srvx and nitro, and h3 is nitro's dependency.
const fmRequire = createRequire(
    join(REPO_ROOT, "apps/file-manager/package.json"),
);
const SRVX_NODE = fmRequire.resolve("srvx/node");
const SRVX_BUN = fmRequire.resolve("srvx/bun");
const H3_PATH = createRequire(
    `${realpathSync(join(REPO_ROOT, "apps/file-manager/node_modules/nitro"))}/package.json`,
).resolve("h3");
const { H3 } = await import(H3_PATH);

const call = (path: string) => {
    let nextCalled = false;
    const res = contract.rejectMalformedPath(
        new Request(`http://app.local${path}`),
        () => {
            nextCalled = true;
            return new Response("next");
        },
    );
    return { res, nextCalled };
};

describe("rejectMalformedPath (the runtime contract's guard)", () => {
    for (const path of MALFORMED) {
        it(`answers 400 for ${path.slice(0, 24)} without reaching the app`, async () => {
            const { res, nextCalled } = call(path);
            expect(nextCalled).toBe(false);
            expect(res).toBeInstanceOf(Response);
            expect(res.status).toBe(400);
            expect(await res.text()).not.toContain("URIError");
        });
    }
    for (const path of VALID) {
        it(`passes ${path} through to the app`, async () => {
            const { res, nextCalled } = call(path);
            expect(nextCalled).toBe(true);
            expect(await (res as Response).text()).toBe("next");
        });
    }

    it("rejects exactly the paths h3 itself fails to decode (verdict parity with a real h3 app)", async () => {
        const app = new H3().get("/**", () => "ok");
        const corpus = [
            ...MALFORMED,
            ...VALID,
            "/%E0%A4",
            "/%ff",
            "/%25%2",
            "/%%25",
            "/x%2Fy%3",
            "/%F0%9F%98%80",
        ];
        for (const path of corpus) {
            let h3Threw = false;
            try {
                await app.fetch(new Request(`http://app.local${path}`));
            } catch {
                h3Threw = true;
            }
            const { nextCalled } = call(path);
            expect({ path, rejected: !nextCalled }).toEqual({
                path,
                rejected: h3Threw,
            });
        }
    });
});

describe("isDecodablePath (no exceptions, so no minifier can delete it)", () => {
    const viaDecodeURI = (p: string) => {
        try {
            decodeURI(p);
            return true;
        } catch {
            return false;
        }
    };

    it("agrees with decodeURI on a seeded fuzz corpus of percent-encoded paths", () => {
        // Deterministic PRNG (mulberry32) so a failure reproduces.
        let seed = 0x1313;
        const rand = () => {
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const HEX = "0123456789abcdefABCDEF";
        const pieces = [
            () => "/",
            () => "a",
            () => "%",
            () => `%${HEX[Math.floor(rand() * 22)]}`,
            () =>
                `%${HEX[Math.floor(rand() * 22)]}${HEX[Math.floor(rand() * 22)]}`,
            () =>
                `%${Math.floor(rand() * 256)
                    .toString(16)
                    .padStart(2, "0")}`,
            () => `%${(0x80 + Math.floor(rand() * 64)).toString(16)}`,
            () => `%${(0xc0 + Math.floor(rand() * 64)).toString(16)}`,
            () => "%zz",
            () => "é",
        ];
        const mismatches: string[] = [];
        for (let n = 0; n < 20_000; n++) {
            let p = "/";
            const len = 1 + Math.floor(rand() * 8);
            for (let k = 0; k < len; k++)
                p += pieces[Math.floor(rand() * pieces.length)]();
            if (contract.isDecodablePath(p) !== viaDecodeURI(p))
                mismatches.push(p);
        }
        // Every valid UTF-8 boundary class, exhaustively for 2- and 3-byte leads.
        for (let b0 = 0x80; b0 <= 0xff; b0++) {
            for (let b1 = 0x70; b1 <= 0xc0; b1++) {
                const p = `/%${b0.toString(16)}%${b1.toString(16)}%80%80`;
                if (contract.isDecodablePath(p) !== viaDecodeURI(p))
                    mismatches.push(p);
            }
        }
        expect(mismatches.slice(0, 10)).toEqual([]);
    });
});

describe("the guard survives the production minifier", () => {
    // vinext's production build minifies the server entry with rolldown. Its
    // minifier treats a call to decodeURI whose result is unused as removable,
    // so `try { decodeURI(p) } catch { return 400 }` compiles to nothing — the
    // guard passed every source-level test and was absent from the built app.
    // This builds the contract the same way and runs the minified guard.
    it("rejects a malformed path after a minified rolldown build", async () => {
        const viteDir = realpathSync(
            join(REPO_ROOT, "apps/file-manager/node_modules/vite"),
        );
        const { rolldown } = await import(
            createRequire(`${viteDir}/package.json`).resolve("rolldown")
        );
        const bundle = await rolldown({
            input: CONTRACT,
            platform: "node",
            logLevel: "silent",
        });
        const { output } = await bundle.generate({
            format: "esm",
            minify: true,
        });
        // A fresh directory: Bun caches a directory's entries once a module in it
        // resolved, so a file written later beside CONTRACT is not found.
        const minified = join(freshDir("min"), "runtime-contract.min.mjs");
        writeFileSync(minified, output[0].code);
        const built = await import(minified);
        const next = () => new Response("next");
        for (const path of MALFORMED) {
            const res = built.rejectMalformedPath(
                new Request(`http://app.local${path}`),
                next,
            );
            expect({ path: path.slice(0, 24), status: res.status }).toEqual({
                path: path.slice(0, 24),
                status: 400,
            });
        }
        for (const path of VALID) {
            const res = built.rejectMalformedPath(
                new Request(`http://app.local${path}`),
                next,
            );
            expect(await res.text()).toBe("next");
        }
    });
});

describe("requestErrorResponse (srvx's error handler)", () => {
    it("answers a plain 500 that does not echo the error", async () => {
        const err = new Error("secret detail /%2/");
        const origError = console.error;
        console.error = () => {};
        try {
            const res = contract.requestErrorResponse(err);
            expect(res.status).toBe(500);
            const body = await res.text();
            expect(body).not.toContain("secret detail");
            expect(body).not.toContain("at ");
        } finally {
            console.error = origError;
        }
    });
});

// ── live servers: real srvx + real h3, under node and under bun ─────────────

type Booted = { port: number; exited: () => string | null; stop: () => void };

function boot(
    bin: string,
    srvx: string,
    extraEnv: Record<string, string> = {},
    harness = HARNESS,
): Promise<Booted> {
    return new Promise((resolveBoot, rejectBoot) => {
        const child = spawn(bin, [harness], {
            env: {
                ...process.env,
                CONTRACT,
                SRVX: srvx,
                H3: H3_PATH,
                ...extraEnv,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let exited: string | null = null;
        child.on("exit", (code, signal) => {
            exited = `exit ${code ?? signal}`;
        });
        const onData = (d: Buffer) => {
            out += d.toString();
            const m = out.match(/LISTENING:(\d+)/);
            if (m) {
                resolveBoot({
                    port: Number(m[1]),
                    exited: () => exited,
                    stop: () => child.kill("SIGKILL"),
                });
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        setTimeout(
            () => rejectBoot(new Error(`harness did not boot: ${out}`)),
            20_000,
        );
    });
}

/** One raw HTTP/1.1 GET — a client library would normalise the path. */
function rawGet(
    port: number,
    path: string,
): Promise<{ status: number; body: string }> {
    return new Promise((resolveGet) => {
        const s = net.connect(port, "127.0.0.1", () =>
            s.write(
                `GET ${path} HTTP/1.1\r\nHost: app.local\r\nConnection: close\r\n\r\n`,
            ),
        );
        let buf = "";
        s.on("data", (d) => {
            buf += d;
        });
        const done = () => {
            const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
            const body = buf.split("\r\n\r\n").slice(1).join("\r\n\r\n");
            resolveGet({ status: m ? Number(m[1]) : 0, body });
        };
        s.on("close", done);
        s.on("error", () => resolveGet({ status: 0, body: "" }));
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// This suite runs under bun, so bun is always available: the bun half runs
// unconditionally, with the running binary.
const RUNTIMES = [
    { name: "node", bin: "node", srvx: SRVX_NODE },
    { name: "bun", bin: process.execPath, srvx: SRVX_BUN },
];

for (const rt of RUNTIMES) {
    describe(`live srvx/${rt.name} + h3 under ${rt.name}`, () => {
        it("answers 400 for every malformed path and keeps serving", async () => {
            const srv = await boot(rt.bin, rt.srvx);
            try {
                expect((await rawGet(srv.port, "/")).status).toBe(200);
                for (const path of MALFORMED) {
                    const res = await rawGet(srv.port, path);
                    expect({
                        path: path.slice(0, 24),
                        status: res.status,
                    }).toEqual({
                        path: path.slice(0, 24),
                        status: 400,
                    });
                    expect(res.body).not.toContain("URIError");
                    expect(srv.exited()).toBeNull();
                    expect((await rawGet(srv.port, "/")).status).toBe(200);
                }
            } finally {
                srv.stop();
            }
        }, 60_000);

        it("a handler that fails after the guard answers 500, leaks nothing, and the server keeps serving", async () => {
            const srv = await boot(rt.bin, rt.srvx);
            try {
                for (const path of ["/boom-sync", "/boom-async"]) {
                    const res = await rawGet(srv.port, path);
                    expect({ path, status: res.status }).toEqual({
                        path,
                        status: 500,
                    });
                    expect(res.body).not.toContain("handler");
                    await sleep(200);
                    expect(srv.exited()).toBeNull();
                    expect((await rawGet(srv.port, "/")).status).toBe(200);
                }
            } finally {
                srv.stop();
            }
        }, 60_000);
    });
}

// CONTROL: the same server without the wiring. Proves the live tests above can
// go red — without it, node dies on the first malformed path.
describe("control: without the guard and the error handler", () => {
    it("node exits on a single malformed path", async () => {
        const srv = await boot("node", SRVX_NODE, {
            KNEXT_HARNESS_NO_GUARD: "1",
            KNEXT_HARNESS_NO_ERROR: "1",
        });
        try {
            await rawGet(srv.port, "/%2/");
            await sleep(500);
            expect(srv.exited()).not.toBeNull();
        } finally {
            srv.stop();
        }
    }, 60_000);

    it("node exits on a handler rejection when only the guard is present", async () => {
        const srv = await boot("node", SRVX_NODE, {
            KNEXT_HARNESS_NO_ERROR: "1",
        });
        try {
            await rawGet(srv.port, "/boom-async");
            await sleep(500);
            expect(srv.exited()).not.toBeNull();
        } finally {
            srv.stop();
        }
    }, 60_000);
});

// ── the node metrics listener: plain node:http, outside srvx ────────────────
/** Request targets node:http accepts but a URL parser may not. */
const ODD_TARGETS = [
    "//",
    "///",
    "//metrics",
    "/%",
    "/%2/",
    "http://[",
    "http://",
    "/metrics#x",
];

describe("metricsRequestListener (the node entry's :9464 listener)", () => {
    it("answers 500 instead of throwing when rendering fails", () => {
        let status = 0;
        let ended = false;
        const res = {
            headersSent: false,
            writeHead(code: number) {
                status = code;
                return res;
            },
            end() {
                ended = true;
                return res;
            },
        };
        const origError = console.error;
        console.error = () => {};
        try {
            // A null state makes renderMetrics throw.
            expect(() =>
                contract.metricsRequestListener(null)(
                    { method: "GET", url: "/metrics", headers: {} },
                    res,
                ),
            ).not.toThrow();
        } finally {
            console.error = origError;
        }
        expect({ status, ended }).toEqual({ status: 500, ended: true });
    });

    it("survives odd request targets and keeps serving /metrics", async () => {
        const srv = await boot("node", "", {}, METRICS_HARNESS);
        try {
            expect((await rawGet(srv.port, "/metrics")).status).toBe(200);
            for (const target of ODD_TARGETS) {
                const res = await rawGet(srv.port, target);
                // 404, not merely "answered": a URL-parser throw that the
                // listener's try/catch absorbs would show up as a 500.
                expect({ target, status: res.status }).toEqual({
                    target,
                    status: 404,
                });
                await sleep(100);
                expect(srv.exited()).toBeNull();
                expect((await rawGet(srv.port, "/metrics")).status).toBe(200);
            }
            expect((await rawGet(srv.port, "/metrics?x=1")).status).toBe(200);
            expect((await rawGet(srv.port, "/other")).status).toBe(404);
        } finally {
            srv.stop();
        }
    }, 60_000);

    it("control: the previous `new URL(req.url)` handler exits on a `//` target", async () => {
        const srv = await boot(
            "node",
            "",
            { KNEXT_HARNESS_OLD_METRICS: "1" },
            METRICS_HARNESS,
        );
        try {
            await rawGet(srv.port, "//");
            await sleep(500);
            expect(srv.exited()).not.toBeNull();
        } finally {
            srv.stop();
        }
    }, 60_000);

    it("no shipped node:http handler parses the request target with new URL", () => {
        // Scanned, not enumerated: every tracked file in shipped code that
        // creates a node:http server OR defines a (req, res) listener
        // (templates, the in-repo apps, the core adapters) must not hand
        // req.url to the URL parser. Aliased forms are the behavioural tests'
        // job (the listener must answer 404, and the real entry is booted).
        const out = spawnSync(
            "git",
            [
                "grep",
                "-lE",
                "createServer\\(|\\([[:space:]]*req[[:space:]]*,[[:space:]]*res[[:space:]]*\\)",
                "--",
                "packages/kn-next/templates",
                "packages/kn-next/src/adapters",
                "turbo/generators/templates",
                "apps/file-manager/*.mjs",
                "apps/docs/*.mjs",
                "examples/bun-exec/*.mjs",
            ],
            { cwd: REPO_ROOT, encoding: "utf8" },
        );
        const files = out.stdout.split("\n").filter(Boolean);
        expect(files.length).toBeGreaterThan(0);
        expect(files).toContain(
            "packages/kn-next/templates/app/runtime-contract.mjs.hbs",
        );
        const offenders = files.filter((f) =>
            /new\s+(?:globalThis\.)?URL\(\s*req\.url/.test(
                readFileSync(join(REPO_ROOT, f), "utf8"),
            ),
        );
        expect(offenders).toEqual([]);
    });
});

// ── the REAL node entry, booted ─────────────────────────────────────────────
// The scaffolded knext-node-entry.mjs, unmodified, beside the scaffolded
// runtime contract. Only its build-time imports are stood in for — nitro's
// virtual polyfills and app (a real h3 app), vinext's request context, and two
// @getknext/core internals that are no-ops for this purpose — while srvx is
// the real package. So the entry's OWN wiring of both listeners is what runs.
function writeEntryApp(): string {
    const dir = freshDir("entry");
    const w = (rel: string, text: string) => {
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        writeFileSync(join(dir, rel), text);
    };
    copyFileSync(
        join(
            REPO_ROOT,
            "packages/kn-next/templates/app/knext-node-entry.mjs.hbs",
        ),
        join(dir, "knext-node-entry.mjs"),
    );
    copyFileSync(
        join(REPO_ROOT, CONTRACTS[0]),
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
    // #1298: the entry now statically `import sharp from 'sharp'` (direct-pass
    // to the image optimizer, like the bun entry) — a bare stub satisfies
    // module resolution; nothing here calls it, since handleImageRequest is
    // itself stubbed to a no-op below.
    pkg("sharp", { ".": "./index.mjs" });
    w("node_modules/sharp/index.mjs", "export default {};\n");
    pkg("nitro", { "./app": "./app.mjs" });
    w(
        "node_modules/nitro/app.mjs",
        `import { H3 } from ${JSON.stringify(pathToFileURL(H3_PATH).href)};\n` +
            "const app = new H3().get('/**', () => 'ok');\n" +
            "export const useNitroApp = () => ({ fetch: app.fetch });\n",
    );
    pkg("vinext", { "./shims/request-context": "./request-context.mjs" });
    w(
        "node_modules/vinext/request-context.mjs",
        "export const runWithExecutionContext = (_ctx, fn) => fn();\n",
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
    symlinkSync(
        realpathSync(join(REPO_ROOT, "apps/file-manager/node_modules/srvx")),
        join(dir, "node_modules/srvx"),
    );
    return dir;
}

type EntryBooted = {
    app: number;
    metrics: number;
    exited: () => string | null;
    stop: () => void;
    out: () => string;
};

function bootEntry(dir: string): Promise<EntryBooted> {
    return new Promise((resolveBoot, rejectBoot) => {
        const child = spawn("node", [join(dir, "knext-node-entry.mjs")], {
            cwd: dir,
            env: {
                ...process.env,
                PORT: "0",
                METRICS_PORT: "0",
                HOSTNAME: "127.0.0.1",
                KNEXT_EAGER_WARM: "0",
                NODE_ENV: "production",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let exited: string | null = null;
        child.on("exit", (code, signal) => {
            exited = `exit ${code ?? signal}`;
        });
        const onData = (d: Buffer) => {
            out += d.toString();
            const m = out.match(/LISTENING:(\d+) METRICS:(\d+)/);
            if (m) {
                resolveBoot({
                    app: Number(m[1]),
                    metrics: Number(m[2]),
                    exited: () => exited,
                    stop: () => child.kill("SIGKILL"),
                    out: () => out,
                });
            }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        setTimeout(
            () => rejectBoot(new Error(`the node entry did not boot: ${out}`)),
            20_000,
        );
    });
}

describe("the scaffolded node entry, booted", () => {
    it("its metrics port answers odd request targets with 404 and keeps serving; its app port answers malformed paths with 400", async () => {
        const srv = await bootEntry(writeEntryApp());
        try {
            expect((await rawGet(srv.metrics, "/metrics")).status).toBe(200);
            for (const target of ODD_TARGETS) {
                const res = await rawGet(srv.metrics, target);
                expect({ target, status: res.status }).toEqual({
                    target,
                    status: 404,
                });
                await sleep(100);
                expect({ target, exited: srv.exited() }).toEqual({
                    target,
                    exited: null,
                });
                expect((await rawGet(srv.metrics, "/metrics")).status).toBe(
                    200,
                );
            }
            expect((await rawGet(srv.app, "/")).status).toBe(200);
            for (const path of MALFORMED) {
                const res = await rawGet(srv.app, path);
                expect({ path: path.slice(0, 24), status: res.status }).toEqual(
                    {
                        path: path.slice(0, 24),
                        status: 400,
                    },
                );
            }
            expect(srv.exited()).toBeNull();
            expect((await rawGet(srv.app, "/")).status).toBe(200);
        } finally {
            srv.stop();
        }
    }, 60_000);

    it("wires the metrics port through the contract's listener (the only createServer call)", () => {
        const src = readFileSync(
            join(
                REPO_ROOT,
                "packages/kn-next/templates/app/knext-node-entry.mjs.hbs",
            ),
            "utf8",
        );
        const calls = [
            ...src.matchAll(/createServer\(\s*([A-Za-z_$][\w$]*)\(/g),
        ].map((m) => m[1]);
        expect(src.split("createServer(").length - 1).toBe(1);
        expect(calls).toEqual(["metricsRequestListener"]);
    });
});

// ── wiring: every shipped entry and contract copy ────────────────────────────

/** The text of `export function <name>(…) {…}` up to its closing brace at column 0. */
function functionSource(src: string, name: string): string {
    const start = src.indexOf(`export function ${name}(`);
    if (start === -1) return "";
    const end = src.indexOf("\n}\n", start);
    return end === -1 ? "" : src.slice(start, end + 2);
}

describe("every contract copy carries the same guard and error handler", () => {
    const reference = readFileSync(join(REPO_ROOT, CONTRACTS[0]), "utf8");
    for (const name of [
        "rejectMalformedPath",
        "isDecodablePath",
        "requestErrorResponse",
        "metricsRequestListener",
    ]) {
        const ref = functionSource(reference, name);
        it(`the template defines ${name}`, () => {
            expect(ref.length).toBeGreaterThan(0);
        });
        for (const copy of CONTRACTS.slice(1)) {
            it(`${copy} carries the template's ${name} verbatim`, () => {
                const src = readFileSync(join(REPO_ROOT, copy), "utf8");
                expect(functionSource(src, name)).toBe(ref);
            });
        }
    }
});

describe("every vinext entry wires the guard first and the error handler", () => {
    for (const entry of ENTRIES) {
        const src = readFileSync(join(REPO_ROOT, entry), "utf8");
        // The app server is the serve() call whose fetch is nitro's.
        const serveAt = src.indexOf("fetch: nitro.fetch");
        const call =
            serveAt === -1
                ? ""
                : src.slice(
                      src.lastIndexOf("serve({", serveAt),
                      src.indexOf("\n});", serveAt),
                  );

        it(`${entry}: imports both from the runtime contract`, () => {
            const imports =
                src.match(
                    /import\s*\{[^}]*\}\s*from\s*['"]\.\/runtime-contract\.mjs['"]/,
                )?.[0] ?? "";
            expect(imports).toContain("rejectMalformedPath");
            expect(imports).toContain("requestErrorResponse");
        });

        it(`${entry}: passes requestErrorResponse as srvx's error handler`, () => {
            expect(call).toMatch(/\n\s*error: requestErrorResponse,/);
        });

        it(`${entry}: runs rejectMalformedPath before any middleware that reads the URL`, () => {
            const mw = call.slice(call.indexOf("middleware: ["));
            const guardAt = mw.indexOf("rejectMalformedPath,");
            expect(guardAt).toBeGreaterThan(-1);
            const imageAt = mw.indexOf("handleImageRequest(");
            if (imageAt !== -1) expect(guardAt).toBeLessThan(imageAt);
        });
    }
});
