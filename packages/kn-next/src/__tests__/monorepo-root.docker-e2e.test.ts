// @vitest-environment node
//
// monorepo-root.docker-e2e — a REAL workspace monorepo through the SHIPPED
// `knext build`, with the tracing root set explicitly above the app.
//
// ── What this proves ────────────────────────────────────────────────────────
//
// The fixture (`fixtures/monorepo-workspace`) is a root package.json with
// `workspaces`, a shared package, and an app (`apps/web`) that imports the
// shared package and reads a file the shared package owns. Its next.config sets
// `outputFileTracingRoot` and `turbopack.root` to the workspace root, so Next
// writes `.next/standalone/apps/web/server.js` and traces the workspace file to
// `.next/standalone/packages/shared/note.txt`, OUTSIDE the app directory.
//
//   1. `knext build` succeeds on that layout (it used to stop with an error that
//      called it unsupported), and compiles the bytecode executable from the
//      NESTED server.
//   2. The nested `server.js` starts under node and serves a page that uses the
//      shared package and reads the traced workspace file. That file only exists
//      if the traced files outside the app dir were packaged where Next put them.
//   3. The compiled executable, placed beside the nested server exactly as the
//      image places it, serves the same page.
//   4. The supervisor (the image's ENTRYPOINT) starts the nested server from
//      STANDALONE_SERVER_PATH, on node and on bun.
//   5. The ACCIDENTAL half: the same app with its explicit root removed, so Next
//      infers the workspace root from the lockfile, still FAILS `knext build`
//      with the real cause. Nested mode is enabled by explicit config only.
//
// The image run for this layout is `monorepo-root-image.docker-e2e.test.ts`.
//
// ── Discipline ──────────────────────────────────────────────────────────────
//   - NO SKIP PATH: a missing bun is a FAILURE. Excluded from the fast lane by
//     the `.docker-e2e.test.ts` suffix; run by the `standalone-drain-bun-image`
//     CI job, which has bun, node and a built @getknext/core.
//   - Every temp dir goes through the `tempRoots` registry (D9 pairing).
//   - Servers are stopped by handle, never by name.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStandaloneExecutable } from "../cli/standalone-exec-build";
import { hostSmokeArch } from "../cli/vinext-build";
import {
    freePorts,
    knextBuild,
    PKG_ROOT,
    type RunningServer,
    type StagedMonorepo,
    stageMonorepo,
    startServer,
    stopServer,
    waitForOk,
} from "./monorepo-fixture";

const tempRoots: string[] = [];
const servers: RunningServer[] = [];

function newRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knext-monorepo-")));
    tempRoots.push(root);
    return root;
}

afterAll(async () => {
    for (const s of servers) await stopServer(s);
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

const EXPECTED_BODY = [
    "hello from the shared workspace package",
    "traced-from-outside-the-app-dir",
];

let monorepo: StagedMonorepo;
let build: { status: number | null; stdout: string; stderr: string };
let serverDir: string;

beforeAll(() => {
    monorepo = stageMonorepo(newRoot());
    build = knextBuild(monorepo.app);
    serverDir = join(monorepo.app, ".next", "standalone", "apps", "web");
}, 900_000);

async function expectPage(server: RunningServer) {
    const html = await waitForOk(server, "/");
    for (const needle of EXPECTED_BODY) expect(html).toContain(needle);
    await waitForOk(server, "/api/health");
}

describe("knext build on a workspace monorepo with an explicit tracing root", () => {
    it("exits 0 and writes the nested standalone layout with the traced workspace files", () => {
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
        const standalone = join(monorepo.app, ".next", "standalone");
        expect(existsSync(join(serverDir, "server.js"))).toBe(true);
        // The flat location is NOT where the server is.
        expect(existsSync(join(standalone, "server.js"))).toBe(false);
        // A file outside the app directory that Next traced.
        expect(
            existsSync(join(standalone, "packages", "shared", "note.txt")),
        ).toBe(true);
    });

    it("compiled the bytecode executable from the nested server and stamped it", () => {
        const exec = join(monorepo.app, "knext-standalone-exec-linux-x64");
        expect(existsSync(exec)).toBe(true);
        expect(existsSync(`${exec}.buildstamp`)).toBe(true);
    });

    it("stages the docker build context at the workspace root, with the app's path in every COPY", () => {
        const dockerfile = readFileSync(
            join(monorepo.app, "Dockerfile.standalone"),
            "utf8",
        );
        expect(dockerfile).toContain(
            "COPY apps/web/.next/standalone /app/.next/standalone",
        );
        expect(dockerfile).toContain(
            "STANDALONE_SERVER_PATH=/app/.next/standalone/apps/web/server.js",
        );
        // The shim files the Dockerfile COPYs sit at the build context root.
        expect(
            existsSync(join(monorepo.root, "knext-standalone-entry.mjs")),
        ).toBe(true);
    });
});

describe("the nested standalone server runs", () => {
    it("`node server.js` serves a page that uses the shared package and the traced workspace file", async () => {
        const [port] = await freePorts(1);
        const server = startServer("node", ["server.js"], {
            cwd: serverDir,
            port,
        });
        servers.push(server);
        await expectPage(server);
        await stopServer(server);
    }, 120_000);

    it("the compiled executable, placed beside the nested server as the image does, serves the same page", async () => {
        const exec = join(serverDir, "knext-standalone-exec");
        // The shipped executable targets linux-musl (the image); a host-arch twin
        // is what can run here. Same compile script, same bytecode verification.
        buildStandaloneExecutable({
            cwd: monorepo.app,
            arch: hostSmokeArch(),
            outFile: exec,
        });
        const [port] = await freePorts(1);
        const server = startServer(exec, [], { cwd: monorepo.app, port });
        servers.push(server);
        await expectPage(server);
        await stopServer(server);
    }, 300_000);

    for (const runtime of ["node", "bun"] as const) {
        it(`the supervisor starts the nested server from STANDALONE_SERVER_PATH on ${runtime}`, async () => {
            const [port, metricsPort] = await freePorts(2);
            // The BUILT supervisor: the file the image's ENTRYPOINT imports.
            const supervisor = join(
                PKG_ROOT,
                "dist",
                "adapters",
                "node-server.js",
            );
            expect(existsSync(supervisor), `${supervisor} missing`).toBe(true);
            const args = runtime === "bun" ? ["run", supervisor] : [supervisor];
            const server = startServer(runtime, args, {
                cwd: monorepo.app,
                port,
                env: {
                    // What the image sets as ENV.
                    STANDALONE_SERVER_PATH: join(serverDir, "server.js"),
                    METRICS_PORT: String(metricsPort),
                },
            });
            servers.push(server);
            await expectPage(server);
            await stopServer(server);
        }, 120_000);
    }
});

describe("an ACCIDENTAL parent root still fails with the real cause", () => {
    it("the same app without an explicit root: Next infers the workspace root from the lockfile, and `knext build` refuses", () => {
        const accidental = stageMonorepo(newRoot(), ({ app }) => {
            writeFileSync(
                join(app, "next.config.js"),
                `module.exports = {
  output: "standalone",
  typescript: { ignoreBuildErrors: true },
  outputFileTracingIncludes: { "/": ["../../packages/shared/note.txt"] },
};
`,
            );
        });
        const result = knextBuild(accidental.app);
        const output = `${result.stdout}\n${result.stderr}`;
        expect(result.status, output).not.toBe(0);
        // The real cause, not a blame on output: 'standalone'.
        expect(output).toMatch(/outputFileTracingRoot/);
        expect(output).toMatch(/lockfile|workspace root/i);
        // Nothing was packaged on the way to failing.
        expect(
            existsSync(join(accidental.app, "knext-standalone-exec-linux-x64")),
        ).toBe(false);
        expect(existsSync(join(accidental.app, "Dockerfile.standalone"))).toBe(
            false,
        );
    }, 600_000);
});
