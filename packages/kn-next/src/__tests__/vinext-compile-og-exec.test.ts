// @vitest-environment node
//
// vinext-compile-og-exec — cluster C4 of the 2026-10-03 vinext × bun compat
// triage: `next/og`'s `ImageResponse` 500s with ENOENT inside a
// `bun build --compile --bytecode` single executable.
//
// ── Root cause (see entry-asset-anchor.mjs's docstring for the full writeup) ──
// `@vercel/og`'s `dist/index.node.js` is ESM, so it cannot reach the sidecar
// (entry-external-sidecar.mjs only redirects CommonJS entries) and stays
// BUNDLED into the executable. Bundled, its `new URL("./resvg.wasm",
// import.meta.url)` + `fs.readFileSync` reads the BUILD MACHINE's absolute
// path under `--bytecode` (measured: Bun 1.4.2 bakes a non-entry bundled
// module's `import.meta.url` as a literal build-time string, not a `$bunfs`
// path) — a path that exists on the build host and NOWHERE ELSE, so the
// shipped binary 500s wherever it actually runs.
//
// ── What this proves, and how ────────────────────────────────────────────
// 1. The fixture app (`fixtures/vinext-bun-og-app`, a trimmed `examples/bun-exec`
//    shape with one `next/og` route) is built through the REAL, SHIPPED path:
//    `buildVinextExecutable` (`vinext-build.ts`), which runs `vite build` then
//    `vinext-compile.mjs` — the same two steps `kn-next build` runs for any
//    vinext app. No docker; the compiled binary runs directly on the host.
// 2. The compiled binary is moved to a FRESH directory with the build
//    directory's `.output/server` (the sidecar nitro staged the wasm/font
//    siblings into) gone — the portability the fix exists for. Only the
//    binary and `.output/public` (static assets, unrelated to this bug) come
//    along, exactly as a Docker image would ship them.
// 3. The moved binary is booted for real and GET /api/og is asserted to
//    answer 200 with a real, decodable PNG — not merely "not 500".
//
// Mutation-proof: reverting EITHER onLoad site vinext-compile.mjs's asset-
// anchor rewrite touches (the non-entry branch, which is the one `@vercel/og`
// actually goes through) reproduces the ENOENT 500 this test was written
// against (verified by hand against the pre-fix source during development).
//
// NO SKIP PATH: a missing `bun` is a failure, not a skip — this suite needs
// nothing docker does not already need elsewhere in this package's e2e tests.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildVinextExecutable, hostSmokeArch } from "../cli/vinext-build";

const FIXTURE_SRC = join(__dirname, "fixtures", "vinext-bun-og-app");

let buildDir = "";
let shipDir = "";
let outFile = "";
let port = 0;
let serverProc: ReturnType<typeof spawn> | null = null;

function run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeout?: number } = {},
) {
    return spawnSync(cmd, args, {
        cwd: opts.cwd,
        timeout: opts.timeout ?? 120_000,
        encoding: "utf-8",
    });
}

async function freePort(): Promise<number> {
    return await new Promise((resolvePort, reject) => {
        const srv = createServer();
        srv.once("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const p = typeof addr === "object" && addr ? addr.port : 0;
            srv.close(() => resolvePort(p));
        });
    });
}

beforeAll(async () => {
    const bun = run("bun", ["--version"]);
    if (bun.status !== 0) {
        throw new Error(
            `'bun' is required on PATH for this suite (got: ${bun.error ?? bun.stderr})`,
        );
    }

    // The fixture is copied to a throwaway dir; it is never built in place
    // (same discipline as the other real-build suites in this package).
    buildDir = mkdtempSync(join(tmpdir(), "knext-vinext-og-build-"));
    cpSync(FIXTURE_SRC, buildDir, { recursive: true });

    const install = run("bun", ["install", "--frozen-lockfile"], {
        cwd: buildDir,
        timeout: 180_000,
    });
    if (install.status !== 0) {
        throw new Error(
            `fixture 'bun install' failed:\n${install.stdout}\n${install.stderr}`,
        );
    }

    // The real build path: `vinext-build.ts`'s `buildVinextExecutable`, which
    // runs `vite build` then `vinext-compile.mjs` — exactly what `kn-next
    // build` runs for the vinext target. Resolves to the SOURCE compile
    // script in a dev checkout (dist is not built here), so this exercises
    // the fix directly. `buildVinextExecutable` shells `npx vite build` from
    // the AMBIENT `process.cwd()` (the real CLI always runs with it already
    // set to the app dir — see `build.ts`'s `smokeCompiledBinary`, which
    // passes `cwd: process.cwd()` for exactly this reason), so the test
    // chdirs there and back rather than assuming `opts.cwd` alone is enough.
    const arch = hostSmokeArch();
    outFile = "knext-og-exec";
    const prevCwd = process.cwd();
    process.chdir(buildDir);
    try {
        buildVinextExecutable({ cwd: buildDir, arch, outFile });
    } finally {
        process.chdir(prevCwd);
    }

    const builtBinary = join(buildDir, outFile);
    if (!existsSync(builtBinary)) {
        throw new Error(`buildVinextExecutable did not produce ${builtBinary}`);
    }

    // Move to a FRESH directory with the build dir's `.output/server` (the
    // sidecar) absent — the portability this fix is about. Only the binary
    // and `.output/public` travel, as a Docker image would ship them.
    shipDir = mkdtempSync(join(tmpdir(), "knext-vinext-og-ship-"));
    cpSync(builtBinary, join(shipDir, outFile));
    mkdirSync(join(shipDir, ".output"), { recursive: true });
    cpSync(
        join(buildDir, ".output", "public"),
        join(shipDir, ".output", "public"),
        {
            recursive: true,
        },
    );

    // Prove portability for real: remove the ENTIRE build directory (not just
    // the sidecar) before booting the shipped copy, so a baked build-machine
    // path has nothing left to find.
    rmSync(buildDir, { recursive: true, force: true });

    port = await freePort();
    serverProc = spawn(resolve(shipDir, outFile), [], {
        cwd: shipDir,
        env: { ...process.env, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    serverProc.stderr?.on("data", (c) => {
        stderr += String(c);
    });

    // Wait for the server to accept connections rather than sleeping a fixed
    // amount. This fixture uses the PLAIN nitro bun preset (no knext runtime
    // entry, so no /api/health) — any HTTP response at all (any status) means
    // the listener is up; a connection error means it is not up yet.
    const deadline = Date.now() + 15_000;
    for (;;) {
        try {
            await fetch(`http://127.0.0.1:${port}/`);
            break;
        } catch {
            // not up yet
        }
        if (Date.now() > deadline) {
            throw new Error(
                `shipped binary never answered /\nstderr:\n${stderr}`,
            );
        }
        await new Promise((r) => setTimeout(r, 200));
    }
}, 300_000);

afterAll(() => {
    serverProc?.kill();
    if (buildDir) rmSync(buildDir, { recursive: true, force: true });
    if (shipDir) rmSync(shipDir, { recursive: true, force: true });
});

describe("next/og's ImageResponse survives the compiled single executable, shipped without its build dir", () => {
    it("GET /api/og is 200, not the ENOENT 500 cluster C4 names", async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/og`);
        expect(res.status).toBe(200);
    });

    it("the response is a real, decodable PNG — not an error page or empty body", async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/og`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        // PNG magic: 89 50 4E 47 0D 0A 1A 0A
        const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        expect([...bytes.slice(0, 8)]).toEqual(PNG_MAGIC);
        expect(bytes.byteLength).toBeGreaterThan(100);
    });

    it("the response declares an image content-type", async () => {
        const res = await fetch(`http://127.0.0.1:${port}/api/og`);
        expect(res.headers.get("content-type")).toMatch(/^image\//);
    });
});
