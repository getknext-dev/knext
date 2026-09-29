/**
 * The in-process request-body byte cap for the Next.js standalone server
 * (`adapters/request-body-cap.cjs`) — ADR-0044 Option C on the node + bun
 * standalone targets.
 *
 * Behavioural half: a real `node:http` server is booted in a CHILD process with
 * the preload loaded exactly the way the runtime loads it (`--require` / `-r`),
 * under BOTH Node and Bun, and driven over raw sockets so the test controls the
 * framing (declared `Content-Length`, chunked with none, exactly-at-limit). The
 * fixture handler buffers its body the way a route handler's `await req.json()`
 * does and reports on stdout whether it STARTED and whether it COMPLETED, which
 * is what proves "no partial processing" rather than just a status code.
 *
 * Wiring half: the preload is only a control if every standalone launch path
 * loads it — the node-server supervisor (node + uncompiled bun), the compiled
 * standalone executable's embedded preload list, and the published dist entry.
 */

import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BUN_BIN, NODE_BIN } from "../../../../tests/helpers/runtime-binaries";

// Each case boots a child process and may wait out a refused connection's
// bounded linger, so the 5s default is too tight on a loaded CI runner.
setDefaultTimeout(30_000);

const require = createRequire(import.meta.url);
const ADAPTERS = resolve(import.meta.dirname, "../adapters");
const PRELOAD = join(ADAPTERS, "request-body-cap.cjs");
const REPO = resolve(import.meta.dirname, "../../../..");

const tmp = mkdtempSync(join(tmpdir(), "knext-body-cap-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The fixture: buffers the body like `await req.json()` and reports on stdout. */
const FIXTURE = join(tmp, "fixture-server.cjs");
writeFileSync(
    FIXTURE,
    `
const http = require('node:http');
const server = http.createServer(async (req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\\n\\n');
    setTimeout(() => res.end('data: two\\n\\n'), 50);
    return;
  }
  const id = req.headers['x-id'] || '?';
  process.stdout.write('HANDLER_START ' + id + '\\n');
  const chunks = [];
  try {
    for await (const c of req) chunks.push(c);
  } catch (err) {
    process.stdout.write('HANDLER_ERROR ' + id + ' ' + (err && err.code) + '\\n');
    try { res.statusCode = 500; res.end('handler-500'); } catch {}
    return;
  }
  const n = Buffer.concat(chunks).length;
  process.stdout.write('HANDLER_DONE ' + id + ' ' + n + '\\n');
  res.end('got ' + n);
});
server.on('upgrade', (req, socket) => {
  socket.end('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: test\\r\\nConnection: Upgrade\\r\\n\\r\\n');
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('LISTENING ' + server.address().port + '\\n');
});
`,
);

interface Booted {
    port: number;
    out: () => string;
    err: () => string;
    stop: () => void;
}

const children: ChildProcess[] = [];
afterAll(() => {
    for (const c of children) c.kill("SIGKILL");
});

function boot(
    bin: string,
    env: Record<string, string | undefined>,
): Promise<Booted> {
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && k !== "KNEXT_MAX_REQUEST_BYTES") childEnv[k] = v;
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

/**
 * Write raw bytes, collect everything the server sends until it closes.
 *
 * By default the client half-closes once it has written everything — what a
 * client that FINISHED sending does. `keepOpen` leaves its side open, like a
 * client still mid-upload, which is what the linger case exercises.
 */
function raw(
    port: number,
    payload: string | Buffer,
    opts: { keepOpen?: boolean } = {},
): Promise<string> {
    return new Promise((done) => {
        const s = connect(port, "127.0.0.1", () => {
            if (opts.keepOpen) s.write(payload);
            else s.end(payload);
        });
        let got = "";
        const timer = setTimeout(() => {
            s.destroy();
            done(`${got} [timeout]`);
        }, 10_000);
        s.on("data", (d) => {
            got += d;
        });
        s.on("error", () => {});
        s.on("close", () => {
            clearTimeout(timer);
            done(got);
        });
    });
}

/**
 * A client that sends a whole large body in ONE write — still uploading when it
 * is refused — and reports the response plus any socket error. Measured on Node
 * and Bun, as server and as client: when the server tears the connection down
 * with the body still arriving, the client gets ECONNRESET/EPIPE every time
 * (and often loses the 413 itself to the reset); with the linger, never.
 */
function bigUpload(
    port: number,
    payload: string,
): Promise<{ status: string; error?: string }> {
    return new Promise((done) => {
        const s = connect(port, "127.0.0.1", () => {
            s.write(payload);
        });
        let got = "";
        let error: string | undefined;
        const timer = setTimeout(() => {
            error = "client-timeout";
            s.destroy();
        }, 15_000);
        s.on("data", (d) => {
            got += d;
        });
        s.on("error", (e: NodeJS.ErrnoException) => {
            error = e.code ?? String(e);
        });
        s.on("close", () => {
            clearTimeout(timer);
            done({ status: statusLine(got), error });
        });
    });
}

const statusLine = (response: string) => response.split("\r\n")[0] ?? "";
const bodyOf = (response: string) =>
    response.split("\r\n\r\n").slice(1).join("\r\n\r\n");
const chunk = (n: number, ch = "b") =>
    `${n.toString(16)}\r\n${ch.repeat(n)}\r\n`;

function post(id: string, len: number, extra = "") {
    return `POST /upload HTTP/1.1\r\nHost: x\r\nX-Id: ${id}\r\nContent-Length: ${len}\r\nConnection: close\r\n${extra}\r\n${"a".repeat(len)}`;
}

/** Wait for a stdout marker, briefly — the child writes asynchronously. */
async function settle(b: Booted, marker: string, ms = 2_000) {
    const until = Date.now() + ms;
    while (Date.now() < until && !b.out().includes(marker)) {
        await new Promise((r) => setTimeout(r, 20));
    }
}

const RUNTIMES: Array<[string, string | undefined]> = [
    ["node", NODE_BIN],
    ["bun", BUN_BIN],
];

for (const [name, bin] of RUNTIMES) {
    // Never a silent skip: a missing runtime is a failure, not a pass.
    if (!bin) {
        throw new Error(
            `cannot locate the ${name} executable; this suite runs under bun test, so both must exist`,
        );
    }
    describe(`request-body-cap — behaviour under ${name}`, () => {
        const CAP = 1000;

        it("a declared Content-Length over the cap is refused with 413 before the handler runs", async () => {
            const b = await boot(bin, { KNEXT_MAX_REQUEST_BYTES: String(CAP) });
            try {
                const res = await raw(b.port, post("cl-over", 5000));
                expect(statusLine(res)).toBe("HTTP/1.1 413 Payload Too Large");
                expect(res.toLowerCase()).toContain("connection: close");
                await new Promise((r) => setTimeout(r, 200));
                expect(b.out()).not.toContain("HANDLER_START cl-over");
            } finally {
                b.stop();
            }
        });

        it("a chunked body with NO Content-Length is counted and refused with 413 mid-stream", async () => {
            const b = await boot(bin, { KNEXT_MAX_REQUEST_BYTES: String(CAP) });
            try {
                const req =
                    "POST /upload HTTP/1.1\r\nHost: x\r\nX-Id: chunked-over\r\nTransfer-Encoding: chunked\r\n\r\n" +
                    chunk(800) +
                    chunk(800) +
                    chunk(800) +
                    "0\r\n\r\n";
                const res = await raw(b.port, req);
                expect(statusLine(res)).toBe("HTTP/1.1 413 Payload Too Large");
                await settle(b, "HANDLER_ERROR chunked-over");
                // No partial processing: the handler's body read REJECTED — it
                // never completed with a truncated body.
                expect(b.out()).toContain(
                    "HANDLER_ERROR chunked-over KNEXT_REQUEST_BODY_TOO_LARGE",
                );
                expect(b.out()).not.toContain("HANDLER_DONE chunked-over");
            } finally {
                b.stop();
            }
        });

        it("a body of EXACTLY the cap passes, declared or chunked", async () => {
            const b = await boot(bin, { KNEXT_MAX_REQUEST_BYTES: String(CAP) });
            try {
                const declared = await raw(b.port, post("exact", CAP));
                expect(statusLine(declared)).toBe("HTTP/1.1 200 OK");
                expect(bodyOf(declared)).toContain(`got ${CAP}`);

                const chunked = await raw(
                    b.port,
                    "POST /upload HTTP/1.1\r\nHost: x\r\nX-Id: exact-chunked\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n" +
                        chunk(600) +
                        chunk(CAP - 600) +
                        "0\r\n\r\n",
                );
                expect(statusLine(chunked)).toBe("HTTP/1.1 200 OK");
                expect(bodyOf(chunked)).toContain(`got ${CAP}`);
            } finally {
                b.stop();
            }
        });

        it("one byte over the cap is refused", async () => {
            const b = await boot(bin, { KNEXT_MAX_REQUEST_BYTES: String(CAP) });
            try {
                const res = await raw(b.port, post("plus-one", CAP + 1));
                expect(statusLine(res)).toBe("HTTP/1.1 413 Payload Too Large");
            } finally {
                b.stop();
            }
        });

        it("the default (no env) preserves a normal multi-megabyte upload and caps at 8 MiB", async () => {
            const b = await boot(bin, {});
            try {
                expect(b.out()).toContain("REQUEST_BYTE_CAP:8388608 (default)");
                // A normal upload through fetch + FormData (multipart), ~5 MiB.
                const form = new FormData();
                form.append(
                    "file",
                    new Blob([new Uint8Array(5 * 1024 * 1024)]),
                    "photo.jpg",
                );
                const ok = await fetch(`http://127.0.0.1:${b.port}/upload`, {
                    method: "POST",
                    body: form,
                });
                expect(ok.status).toBe(200);
                expect(
                    Number((await ok.text()).replace("got ", "")),
                ).toBeGreaterThan(5 * 1024 * 1024);

                const over = await raw(
                    b.port,
                    post("default-over", 8 * 1024 * 1024 + 1),
                );
                expect(statusLine(over)).toBe("HTTP/1.1 413 Payload Too Large");
            } finally {
                b.stop();
            }
        });

        it("KNEXT_MAX_REQUEST_BYTES overrides the default in both directions", async () => {
            const low = await boot(bin, { KNEXT_MAX_REQUEST_BYTES: "2000" });
            try {
                expect(low.out()).toContain("REQUEST_BYTE_CAP:2000 (env)");
                expect(
                    statusLine(await raw(low.port, post("low-ok", 1500))),
                ).toBe("HTTP/1.1 200 OK");
                expect(
                    statusLine(await raw(low.port, post("low-over", 2500))),
                ).toBe("HTTP/1.1 413 Payload Too Large");
            } finally {
                low.stop();
            }
            const high = await boot(bin, {
                KNEXT_MAX_REQUEST_BYTES: String(10 * 1024 * 1024),
            });
            try {
                const res = await raw(
                    high.port,
                    post("high-ok", 9 * 1024 * 1024),
                );
                expect(statusLine(res)).toBe("HTTP/1.1 200 OK");
            } finally {
                high.stop();
            }
        });

        it("0 uncaps deliberately and says so loudly at boot", async () => {
            const b = await boot(bin, { KNEXT_MAX_REQUEST_BYTES: "0" });
            try {
                expect(b.out()).toContain("REQUEST_BYTE_CAP:none (uncapped)");
                expect(b.err()).toContain("UNCAPPED");
                const res = await raw(
                    b.port,
                    post("uncapped", 9 * 1024 * 1024),
                );
                expect(statusLine(res)).toBe("HTTP/1.1 200 OK");
            } finally {
                b.stop();
            }
        });

        it("an invalid value keeps the default cap and warns — a typo never removes the control", async () => {
            const b = await boot(bin, { KNEXT_MAX_REQUEST_BYTES: "8MB" });
            try {
                expect(b.out()).toContain("REQUEST_BYTE_CAP:8388608 (invalid)");
                expect(b.err()).toContain("not a non-negative integer");
                const res = await raw(
                    b.port,
                    post("invalid-over", 8 * 1024 * 1024 + 1),
                );
                expect(statusLine(res)).toBe("HTTP/1.1 413 Payload Too Large");
            } finally {
                b.stop();
            }
        });

        it("a client still uploading when refused READS the 413 with no connection reset", async () => {
            const b = await boot(bin, { KNEXT_MAX_REQUEST_BYTES: String(CAP) });
            try {
                const big = 8 * 1024 * 1024;
                for (let n = 0; n < 3; n++) {
                    const declared = await bigUpload(
                        b.port,
                        `POST /upload HTTP/1.1\r\nHost: x\r\nX-Id: linger-declared\r\nContent-Length: ${big}\r\n\r\n${"a".repeat(big)}`,
                    );
                    expect(declared).toEqual({
                        status: "HTTP/1.1 413 Payload Too Large",
                        error: undefined,
                    });

                    const chunked = await bigUpload(
                        b.port,
                        "POST /upload HTTP/1.1\r\nHost: x\r\nX-Id: linger-chunked\r\nTransfer-Encoding: chunked\r\n\r\n" +
                            chunk(1024 * 1024).repeat(8) +
                            "0\r\n\r\n",
                    );
                    expect(chunked).toEqual({
                        status: "HTTP/1.1 413 Payload Too Large",
                        error: undefined,
                    });
                }
                expect(b.out()).not.toContain("HANDLER_DONE linger-chunked");
            } finally {
                b.stop();
            }
        });

        it("Upgrade requests and streaming responses pass through untouched", async () => {
            const b = await boot(bin, { KNEXT_MAX_REQUEST_BYTES: "10" });
            try {
                const up = await raw(
                    b.port,
                    "GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n",
                    { keepOpen: true },
                );
                expect(statusLine(up)).toBe("HTTP/1.1 101 Switching Protocols");

                const sse = await raw(
                    b.port,
                    "GET /stream HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
                    { keepOpen: true },
                );
                expect(statusLine(sse)).toBe("HTTP/1.1 200 OK");
                expect(sse).toContain("data: one");
                expect(sse).toContain("data: two");
            } finally {
                b.stop();
            }
        });
    });
}

describe("request-body-cap — resolver is in lockstep with the vinext entry's", () => {
    process.env.KNEXT_REQUEST_BODY_CAP_NO_AUTOINSTALL = "1";
    // biome-ignore lint/suspicious/noExplicitAny: untyped CJS runtime module
    const cjs: any = require(PRELOAD);
    delete process.env.KNEXT_REQUEST_BODY_CAP_NO_AUTOINSTALL;

    it("shares the knob name and default with the vinext runtime contract", async () => {
        const contract = await import(
            pathToFileURL(join(REPO, "apps/file-manager/runtime-contract.mjs"))
                .href
        );
        expect(cjs.MAX_REQUEST_BYTES_ENV).toBe(contract.MAX_REQUEST_BYTES_ENV);
        expect(cjs.DEFAULT_MAX_REQUEST_BYTES).toBe(
            contract.DEFAULT_MAX_REQUEST_BYTES,
        );
        expect(cjs.DEFAULT_MAX_REQUEST_BYTES).toBe(8 * 1024 * 1024);
    });

    it("resolves every value exactly as the vinext entry does", async () => {
        const contract = await import(
            pathToFileURL(join(REPO, "apps/file-manager/runtime-contract.mjs"))
                .href
        );
        const cases: Array<string | undefined> = [
            undefined,
            "",
            " ",
            "0",
            "1",
            "1000",
            " 2048 ",
            "8MB",
            "-1",
            "1.5",
            "1e9",
            "Infinity",
            "99999999999999999999",
        ];
        for (const value of cases) {
            const env = { KNEXT_MAX_REQUEST_BYTES: value };
            const mine = cjs.resolveRequestByteCap(env);
            const theirs = contract.resolveMaxRequestBytes(env);
            expect({ value, bytes: mine.bytes, source: mine.source }).toEqual({
                value,
                bytes: theirs.bytes,
                source: theirs.source,
            });
            expect(Boolean(mine.warning)).toBe(Boolean(theirs.warning));
        }
    });
});

describe("request-body-cap — every standalone launch path loads it", () => {
    it("node-server.ts preloads it unconditionally (node AND uncompiled bun children)", () => {
        const src = readFileSync(join(ADAPTERS, "node-server.ts"), "utf8");
        const at = src.indexOf('"request-body-cap.cjs"');
        expect(at).toBeGreaterThan(-1);
        // Not inside the `if (process.versions.bun)` block that guards the
        // keep-alive preload — the cap must apply to the Node child too.
        const bunGate = src.indexOf("if (process.versions.bun)");
        expect(bunGate).toBeGreaterThan(-1);
        expect(at).toBeLessThan(bunGate);
        expect(src).toMatch(
            /preloadArgs\.push\(\s*"--require",\s*requestBodyCapPreload\s*\)/,
        );
    });

    it("the compiled standalone executable embeds it in its preload list", () => {
        const src = readFileSync(
            join(ADAPTERS, "standalone-compile.mjs"),
            "utf8",
        );
        const m = /const PRELOAD_NAMES = \[([^\]]*)\]/.exec(src);
        expect(m).not.toBeNull();
        expect(m?.[1]).toContain('"request-body-cap.cjs"');
    });

    it("ships in dist as a CommonJS entry and an internal subpath", () => {
        const tsup = readFileSync(
            resolve(import.meta.dirname, "../../tsup.config.ts"),
            "utf8",
        );
        expect(tsup).toContain(
            "'adapters/request-body-cap': 'src/adapters/request-body-cap.cjs'",
        );
        const pkg = JSON.parse(
            readFileSync(
                resolve(import.meta.dirname, "../../package.json"),
                "utf8",
            ),
        );
        expect(pkg.exports["./internal/request-body-cap"]).toBe(
            "./dist/adapters/request-body-cap.cjs",
        );
    });
});
