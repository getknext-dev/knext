/**
 * Allowlisted public origin for redirects (`adapters/public-origin.cjs`).
 *
 * Next's standalone server builds `request.url` from its BIND address, so a
 * route handler's `NextResponse.redirect(new URL('/x', request.url))` answers
 * `Location: http://0.0.0.0:PORT/x` behind Knative. The preload rewrites a
 * Location whose origin is a wildcard bind address to a public origin drawn
 * from `KNEXT_PUBLIC_ORIGINS` — and from nothing else:
 *
 *   - host:   `X-Forwarded-Host`, then `Host`, ONLY when the value is on the
 *             allowlist exactly; otherwise the first allowlisted entry;
 *   - scheme: `X-Forwarded-Proto` ONLY when it is exactly `http` or `https`;
 *             otherwise `https`;
 *   - any other origin (a real host, a relative path) is left alone;
 *   - with the env var unset the preload installs nothing at all.
 *
 * Pure half: the resolver functions. Behavioural half: a real `node:http`
 * server booted in a CHILD process with the preload loaded the way the runtime
 * loads it (`--require`), under BOTH Node and Bun, exercising every way a
 * Location can be written. Wiring half: every standalone launch path loads it.
 */

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BUN_BIN, NODE_BIN } from "../../../../tests/helpers/runtime-binaries";

setDefaultTimeout(30_000);

const require = createRequire(import.meta.url);
const ADAPTERS = resolve(import.meta.dirname, "../adapters");
const PRELOAD = join(ADAPTERS, "public-origin.cjs");

const tempRoots: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
    for (const c of children) c.kill("SIGKILL");
    for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
});

process.env.KNEXT_PUBLIC_ORIGIN_NO_AUTOINSTALL = "1";
// biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
const po: any = require(PRELOAD);
delete process.env.KNEXT_PUBLIC_ORIGIN_NO_AUTOINSTALL;

const HOSTS = ["app.example.com", "www.example.com", "localhost:3000"];

describe("public-origin — allowlist parsing", () => {
    it("reads KNEXT_PUBLIC_ORIGINS", () => {
        expect(po.PUBLIC_ORIGINS_ENV).toBe("KNEXT_PUBLIC_ORIGINS");
    });

    it("unset or empty means no allowlist", () => {
        expect(po.parsePublicOrigins(undefined)).toEqual({
            hosts: [],
            invalid: [],
        });
        expect(po.parsePublicOrigins("")).toEqual({ hosts: [], invalid: [] });
        expect(po.parsePublicOrigins(" , ")).toEqual({
            hosts: [],
            invalid: [],
        });
    });

    it("accepts bare hosts and http(s) origins, lower-cased, scheme and trailing slash stripped", () => {
        expect(
            po.parsePublicOrigins(
                " App.Example.com ,https://www.example.com/, http://localhost:3000",
            ),
        ).toEqual({
            hosts: ["app.example.com", "www.example.com", "localhost:3000"],
            invalid: [],
        });
    });

    it("drops anything that is not a plain host[:port] — and says which", () => {
        const bad = [
            "evil.com/path",
            "user@app.example.com",
            "*.example.com",
            "ftp://app.example.com",
            "https://",
            "app.example.com:0",
            "app.example.com:99999",
            "app.example.com?x=1",
            "app example.com",
            "0.0.0.0",
            "[::]",
            "-bad.example.com",
            // other spellings of the same wildcard bind address
            "[::0]",
            "[0:0:0:0:0:0:0:0]",
            "[0000::]:8080",
            "https://[::0]",
            "0",
            "0x0",
            "00.0.0.0",
            "[::ffff:0.0.0.0]",
        ];
        const parsed = po.parsePublicOrigins(
            ["app.example.com", ...bad].join(","),
        );
        expect(parsed.hosts).toEqual(["app.example.com"]);
        expect(parsed.invalid).toEqual(bad);
    });

    it("keeps a bracketed IPv6 literal with a port", () => {
        expect(po.parsePublicOrigins("[2001:db8::1]:8443").hosts).toEqual([
            "[2001:db8::1]:8443",
        ]);
    });
});

describe("public-origin — Location rewrite rule", () => {
    const rewrite = (
        value: unknown,
        headers: Record<string, string | string[] | undefined> = {},
    ) => po.rewriteLocation(value, headers, HOSTS);

    it("rewrites a 0.0.0.0 bind origin, keeping path, query and fragment verbatim", () => {
        expect(rewrite("http://0.0.0.0:8080/article/one?x=1&y=%2F#top")).toBe(
            "https://app.example.com/article/one?x=1&y=%2F#top",
        );
        expect(rewrite("http://0.0.0.0:3000")).toBe("https://app.example.com");
        expect(rewrite("HTTP://0.0.0.0/x")).toBe("https://app.example.com/x");
    });

    it("rewrites an IPv6 wildcard bind origin", () => {
        expect(rewrite("http://[::]:8080/x")).toBe("https://app.example.com/x");
    });

    it("rewrites every spelling of a wildcard bind origin", () => {
        for (const origin of [
            "http://[::0]:8080",
            "http://[0:0:0:0:0:0:0:0]",
            "http://[0000::]:80",
            "http://0:3000",
            "http://0x0:3000",
            "http://00.0.0.0",
            "http://[::ffff:0.0.0.0]:8080",
        ]) {
            expect({ origin, out: rewrite(`${origin}/a?b=1`) }).toEqual({
                origin,
                out: "https://app.example.com/a?b=1",
            });
        }
    });

    it("leaves every non-wildcard origin alone", () => {
        for (const value of [
            "/relative/path",
            "relative",
            "http://localhost:3000/x",
            "https://other.example.org/x",
            "http://127.0.0.1:8080/x",
            "http://0.0.0.0.evil.com/x",
            "http://0.0.0.0evil.com/x",
            "http://user@0.0.0.0:8080/x",
            "http://[::1]:8080/x",
            "//0.0.0.0:8080/x",
            "",
        ]) {
            expect(rewrite(value)).toBe(value);
        }
    });

    it("an allowlisted X-Forwarded-Host wins", () => {
        expect(
            rewrite("http://0.0.0.0:8080/x", {
                "x-forwarded-host": "www.example.com",
                host: "app.example.com",
            }),
        ).toBe("https://www.example.com/x");
    });

    it("an allowlisted Host is used when X-Forwarded-Host is absent or not allowlisted", () => {
        expect(
            rewrite("http://0.0.0.0:8080/x", { host: "www.example.com" }),
        ).toBe("https://www.example.com/x");
        expect(
            rewrite("http://0.0.0.0:8080/x", {
                "x-forwarded-host": "evil.com",
                host: "www.example.com",
            }),
        ).toBe("https://www.example.com/x");
        expect(
            rewrite("http://0.0.0.0:8080/x", { host: "localhost:3000" }),
        ).toBe("https://localhost:3000/x");
    });

    it("matches host names case-insensitively and emits the allowlisted spelling", () => {
        expect(
            rewrite("http://0.0.0.0:8080/x", { host: "WWW.Example.COM" }),
        ).toBe("https://www.example.com/x");
    });

    it("an attacker host — in either header, in any shape — falls back to the first allowlisted entry", () => {
        const attacks = [
            "evil.com",
            "app.example.com.evil.com",
            "app.example.com:6666",
            "app.example.com@evil.com",
            "evil.com, app.example.com",
            "https://evil.com",
            "app.example.com/evil",
            "app.example.com\r\nset-cookie: x=1",
            "",
        ];
        for (const evil of attacks) {
            expect(
                rewrite("http://0.0.0.0:8080/x", {
                    "x-forwarded-host": evil,
                    host: evil,
                }),
            ).toBe("https://app.example.com/x");
        }
    });

    it("takes the first X-Forwarded-Host token, and only if it is allowlisted", () => {
        expect(
            rewrite("http://0.0.0.0:8080/x", {
                "x-forwarded-host": "www.example.com, evil.com",
            }),
        ).toBe("https://www.example.com/x");
        expect(
            rewrite("http://0.0.0.0:8080/x", {
                "x-forwarded-host": ["www.example.com"],
            }),
        ).toBe("https://www.example.com/x");
    });

    it("honours X-Forwarded-Proto only when it is exactly http or https; anything else is https", () => {
        expect(
            rewrite("http://0.0.0.0:8080/x", { "x-forwarded-proto": "http" }),
        ).toBe("http://app.example.com/x");
        expect(
            rewrite("http://0.0.0.0:8080/x", {
                "x-forwarded-proto": " HTTPS ",
            }),
        ).toBe("https://app.example.com/x");
        for (const bad of [
            "javascript",
            "ftp",
            "https, http",
            "http, https",
            "data",
            "gopher",
            "",
        ]) {
            expect(
                rewrite("http://0.0.0.0:8080/x", { "x-forwarded-proto": bad }),
            ).toBe("https://app.example.com/x");
        }
    });

    it("no header outside the allowlist ever reaches the rewritten origin", () => {
        const allowedOrigins = new Set(
            HOSTS.flatMap((h) => [`http://${h}`, `https://${h}`]),
        );
        const hostValues = [
            "evil.com",
            "app.example.com:1",
            "www.example.com",
            "WWW.EXAMPLE.COM",
            "x\r\ny",
        ];
        const protoValues = [
            "http",
            "https",
            "evil",
            "javascript:alert(1)//",
            undefined,
        ];
        for (const xfh of [...hostValues, undefined]) {
            for (const host of [...hostValues, undefined]) {
                for (const proto of protoValues) {
                    const out = rewrite("http://0.0.0.0:8080/p", {
                        "x-forwarded-host": xfh,
                        host,
                        "x-forwarded-proto": proto,
                    });
                    expect(out.endsWith("/p")).toBe(true);
                    expect(allowedOrigins.has(out.slice(0, -2))).toBe(true);
                }
            }
        }
    });

    it("with no allowlist (env unset) nothing is rewritten", () => {
        expect(
            po.rewriteLocation(
                "http://0.0.0.0:8080/x",
                { host: "app.example.com" },
                [],
            ),
        ).toBe("http://0.0.0.0:8080/x");
    });

    it("rewrites each element of an array-valued Location", () => {
        expect(rewrite(["http://0.0.0.0:8080/x"])).toEqual([
            "https://app.example.com/x",
        ]);
    });
});

// ── Behaviour: the preload on a real node:http server, under Node and Bun ─────

const tmp = mkdtempSync(join(tmpdir(), "knext-public-origin-"));
tempRoots.push(tmp);

/** Writes a Location every way a server can; `via` picks the API. */
const FIXTURE = join(tmp, "fixture-server.cjs");
writeFileSync(
    FIXTURE,
    `
const http = require('node:http');
const server = http.createServer((req, res) => {
  // What Next's base-server does before any handler runs: default the
  // forwarded headers on the LIVE request. The rule must read what arrived.
  req.headers['x-forwarded-host'] ??= req.headers.host;
  req.headers['x-forwarded-proto'] ??= 'http';
  const u = new URL(req.url, 'http://fixture');
  const loc = u.searchParams.get('loc');
  switch (u.searchParams.get('via')) {
    case 'setHeader': res.statusCode = 307; res.setHeader('Location', loc); return res.end();
    case 'setHeaderArray': res.statusCode = 307; res.setHeader('location', [loc]); return res.end();
    case 'appendHeader': res.statusCode = 307; res.appendHeader('location', loc); return res.end();
    case 'writeHead': res.writeHead(302, { Location: loc }); return res.end();
    case 'writeHeadMsg': res.writeHead(302, 'Found', { location: loc }); return res.end();
    case 'writeHeadFlat': res.writeHead(302, ['Location', loc]); return res.end();
    // A Location set through a path the preload's setHeader hook cannot see.
    case 'bypass': http.OutgoingMessage.prototype.setHeader.call(res, 'Location', loc); res.writeHead(302); return res.end();
    case 'varyBefore': res.setHeader('Vary', 'Accept-Encoding'); res.setHeader('Location', loc); res.writeHead(302); return res.end();
    case 'varyAfter': res.setHeader('Location', loc); res.setHeader('Vary', 'Accept'); res.writeHead(302); return res.end();
    case 'varyHead': res.setHeader('Vary', 'Accept'); res.writeHead(302, { Location: loc, Vary: 'Cookie' }); return res.end();
    case 'varyStar': res.setHeader('Location', loc); res.setHeader('Vary', '*'); res.writeHead(302); return res.end();
    default: res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok');
  }
});
server.listen(0, '0.0.0.0', () => process.stdout.write('LISTENING ' + server.address().port + '\\n'));
`,
);

interface Booted {
    port: number;
    out: () => string;
    err: () => string;
    stop: () => void;
}

function boot(
    bin: string,
    env: Record<string, string | undefined>,
): Promise<Booted> {
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith("KNEXT_PUBLIC_ORIGIN"))
            childEnv[k] = v;
    }
    for (const [k, v] of Object.entries(env)) {
        if (v !== undefined) childEnv[k] = v;
    }
    const child = spawn(bin, ["--require", PRELOAD, FIXTURE], {
        env: childEnv as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let out = "";
    let err = "";
    child.stdout?.on("data", (d) => {
        out += d;
    });
    child.stderr?.on("data", (d) => {
        err += d;
    });
    return new Promise((resolvePort, reject) => {
        const timer = setTimeout(
            () =>
                reject(
                    new Error(
                        `fixture never listened\nstdout:${out}\nstderr:${err}`,
                    ),
                ),
            15_000,
        );
        child.on("exit", (code) => {
            clearTimeout(timer);
            reject(
                new Error(
                    `fixture exited ${code}\nstdout:${out}\nstderr:${err}`,
                ),
            );
        });
        child.stdout?.on("data", () => {
            const m = /LISTENING (\d+)/.exec(out);
            if (m) {
                clearTimeout(timer);
                resolvePort({
                    port: Number(m[1]),
                    out: () => out,
                    err: () => err,
                    stop: () => child.kill("SIGKILL"),
                });
            }
        });
    });
}

/** GET with exact header control (fetch would rewrite Host); returns the Location. */
function locationOf(
    port: number,
    via: string,
    loc: string,
    headers: Record<string, string> = {},
): Promise<string | undefined> {
    return new Promise((done, fail) => {
        const req = httpRequest(
            {
                host: "127.0.0.1",
                port,
                path: `/?via=${via}&loc=${encodeURIComponent(loc)}`,
                headers,
            },
            (res) => {
                res.resume();
                res.on("end", () => done(res.headers.location));
            },
        );
        req.on("error", fail);
        req.end();
    });
}

/** GET returning the raw response headers. */
function headersOf(
    port: number,
    via: string,
    loc: string,
    headers: Record<string, string> = {},
): Promise<Record<string, string | string[] | undefined>> {
    return new Promise((done, fail) => {
        const req = httpRequest(
            {
                host: "127.0.0.1",
                port,
                path: `/?via=${via}&loc=${encodeURIComponent(loc)}`,
                headers,
            },
            (res) => {
                res.resume();
                res.on("end", () => done(res.headers));
            },
        );
        req.on("error", fail);
        req.end();
    });
}

const RUNTIMES: Array<[string, string | undefined]> = [
    ["node", NODE_BIN],
    ["bun", BUN_BIN],
];

const VIAS = [
    "setHeader",
    "setHeaderArray",
    "appendHeader",
    "writeHead",
    "writeHeadMsg",
    "writeHeadFlat",
    "bypass",
];

for (const [name, bin] of RUNTIMES) {
    if (!bin) {
        throw new Error(
            `cannot locate the ${name} executable; this suite runs under bun test, so both must exist`,
        );
    }
    describe(`public-origin — behaviour under ${name}`, () => {
        it("rewrites a wildcard-bind Location written through every response API", async () => {
            const b = await boot(bin, {
                KNEXT_PUBLIC_ORIGINS: "app.example.com,www.example.com",
            });
            try {
                for (const via of VIAS) {
                    expect({
                        via,
                        loc: await locationOf(
                            b.port,
                            via,
                            "http://0.0.0.0:8080/a?b=1",
                        ),
                    }).toEqual({
                        via,
                        loc: "https://app.example.com/a?b=1",
                    });
                }
                expect(b.out()).toContain(
                    "PUBLIC_ORIGINS:app.example.com,www.example.com",
                );
            } finally {
                b.stop();
            }
        });

        it("rewrites a Location that bypassed setHeader, at writeHead", async () => {
            const b = await boot(bin, {
                KNEXT_PUBLIC_ORIGINS: "app.example.com",
            });
            try {
                expect(
                    await locationOf(b.port, "bypass", "http://0.0.0.0:8080/a"),
                ).toBe("https://app.example.com/a");
            } finally {
                b.stop();
            }
        });

        it("marks a rewritten redirect Vary on the headers the origin depends on, keeping any existing Vary", async () => {
            const b = await boot(bin, {
                KNEXT_PUBLIC_ORIGINS: "app.example.com",
            });
            const norm = (v: unknown) =>
                String(v)
                    .split(",")
                    .map((t) => t.trim().toLowerCase())
                    .sort();
            const want = ["x-forwarded-host", "host", "x-forwarded-proto"];
            try {
                for (const via of [
                    "setHeader",
                    "appendHeader",
                    "writeHead",
                    "bypass",
                ]) {
                    const h = await headersOf(
                        b.port,
                        via,
                        "http://0.0.0.0:8080/a",
                    );
                    expect({ via, vary: norm(h.vary) }).toEqual({
                        via,
                        vary: [...want].sort(),
                    });
                }
                // Existing Vary is kept, whether set before, after, or via writeHead.
                for (const [via, kept] of [
                    ["varyBefore", ["accept-encoding"]],
                    ["varyAfter", ["accept"]],
                    ["varyHead", ["accept", "cookie"]],
                ] as const) {
                    const h = await headersOf(
                        b.port,
                        via,
                        "http://0.0.0.0:8080/a",
                    );
                    expect({ via, vary: norm(h.vary) }).toEqual({
                        via,
                        vary: [...want, ...kept].sort(),
                    });
                }
                // `Vary: *` already covers everything.
                const star = await headersOf(
                    b.port,
                    "varyStar",
                    "http://0.0.0.0:8080/a",
                );
                expect(star.vary).toBe("*");
            } finally {
                b.stop();
            }
        });

        it("adds no Vary when the Location was not rewritten", async () => {
            const b = await boot(bin, {
                KNEXT_PUBLIC_ORIGINS: "app.example.com",
            });
            try {
                for (const via of ["setHeader", "writeHead", "bypass"]) {
                    const h = await headersOf(
                        b.port,
                        via,
                        "https://other.example.org/a",
                    );
                    expect({ via, vary: h.vary }).toEqual({
                        via,
                        vary: undefined,
                    });
                }
                expect(
                    (await headersOf(b.port, "default", "x")).vary,
                ).toBeUndefined();
            } finally {
                b.stop();
            }
        });

        it("leaves a non-wildcard Location untouched", async () => {
            const b = await boot(bin, {
                KNEXT_PUBLIC_ORIGINS: "app.example.com",
            });
            try {
                for (const via of VIAS) {
                    expect(
                        await locationOf(
                            b.port,
                            via,
                            "https://other.example.org/a",
                        ),
                    ).toBe("https://other.example.org/a");
                    expect(await locationOf(b.port, via, "/relative")).toBe(
                        "/relative",
                    );
                }
            } finally {
                b.stop();
            }
        });

        it("uses an allowlisted forwarded host and proto from the request", async () => {
            const b = await boot(bin, {
                KNEXT_PUBLIC_ORIGINS: "app.example.com,www.example.com",
            });
            try {
                expect(
                    await locationOf(
                        b.port,
                        "setHeaderArray",
                        "http://0.0.0.0:8080/a",
                        {
                            "X-Forwarded-Host": "www.example.com",
                            "X-Forwarded-Proto": "http",
                        },
                    ),
                ).toBe("http://www.example.com/a");
                expect(
                    await locationOf(
                        b.port,
                        "writeHead",
                        "http://0.0.0.0:8080/a",
                        { Host: "www.example.com" },
                    ),
                ).toBe("https://www.example.com/a");
            } finally {
                b.stop();
            }
        });

        it("an attacker host and proto fall back to the first allowlisted origin", async () => {
            const b = await boot(bin, {
                KNEXT_PUBLIC_ORIGINS: "app.example.com,www.example.com",
            });
            try {
                for (const via of VIAS) {
                    expect(
                        await locationOf(b.port, via, "http://0.0.0.0:8080/a", {
                            Host: "evil.com",
                            "X-Forwarded-Host": "evil.com",
                            "X-Forwarded-Proto": "javascript",
                        }),
                    ).toBe("https://app.example.com/a");
                }
            } finally {
                b.stop();
            }
        });

        it("with KNEXT_PUBLIC_ORIGINS unset nothing changes and nothing is announced", async () => {
            const b = await boot(bin, {});
            try {
                for (const via of VIAS) {
                    expect(
                        await locationOf(b.port, via, "http://0.0.0.0:8080/a"),
                    ).toBe("http://0.0.0.0:8080/a");
                }
                expect(b.out()).not.toContain("PUBLIC_ORIGINS");
                expect(b.err()).not.toContain("PUBLIC_ORIGINS");
            } finally {
                b.stop();
            }
        });

        it("invalid entries are dropped with a warning; all-invalid installs nothing", async () => {
            const b = await boot(bin, {
                KNEXT_PUBLIC_ORIGINS: "evil.com/path",
            });
            try {
                expect(
                    await locationOf(
                        b.port,
                        "setHeader",
                        "http://0.0.0.0:8080/a",
                    ),
                ).toBe("http://0.0.0.0:8080/a");
                expect(b.err()).toContain("evil.com/path");
            } finally {
                b.stop();
            }
        });
    });
}

// ── Wiring: every standalone launch path loads it ─────────────────────────────

describe("public-origin — every standalone launch path loads it", () => {
    it("node-server.ts preloads it unconditionally (node AND uncompiled bun children)", () => {
        const src = readFileSync(join(ADAPTERS, "node-server.ts"), "utf8");
        const at = src.indexOf('"public-origin.cjs"');
        expect(at).toBeGreaterThan(-1);
        const bunGate = src.indexOf("if (process.versions.bun)");
        expect(bunGate).toBeGreaterThan(-1);
        expect(at).toBeLessThan(bunGate);
        expect(src).toMatch(
            /preloadArgs\.push\(\s*"--require",\s*publicOriginPreload\s*\)/,
        );
    });

    it("the compiled standalone executable embeds it in its preload list", () => {
        const src = readFileSync(
            join(ADAPTERS, "standalone-compile.mjs"),
            "utf8",
        );
        const m = /const PRELOAD_NAMES = \[([^\]]*)\]/.exec(src);
        expect(m).not.toBeNull();
        expect(m?.[1]).toContain('"public-origin.cjs"');
    });

    it("ships in dist as a CommonJS entry", () => {
        const tsup = readFileSync(
            resolve(import.meta.dirname, "../../tsup.config.ts"),
            "utf8",
        );
        expect(tsup).toContain(
            "'adapters/public-origin': 'src/adapters/public-origin.cjs'",
        );
    });
});
