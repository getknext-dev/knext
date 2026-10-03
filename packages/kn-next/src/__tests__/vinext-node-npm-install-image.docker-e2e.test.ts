// @vitest-environment node
//
// vinext-node-npm-install-image.docker-e2e — #1864: a vinext × node scaffold
// installed the way `knext create` actually tells every user to install it
// (`partingLine()`: `npm install`, unconditionally — `--runtime node` apps
// included) must build and serve, with sharp able to load inside the alpine
// image.
//
// ── Why this is a SEPARATE suite from vinext-node-image.docker-e2e ────────
//
// That sibling suite proves the same image recipe with `bun install --linker
// isolated`, which writes a `bun.lock` — the ONE lockfile format
// `findLockfile`/`readLockfilePackages` (`native-integrity.ts`) could read
// before #1864. A `--runtime node` app has the least reason of any knext
// scaffold to also have bun on PATH (that is the whole point of choosing
// `node`), so the realistic install for it is `knext create`'s own documented
// `npm install` — and that path was never exercised end-to-end through a real
// `docker build` until this file. Reusing the sibling's single shared
// `beforeAll` would have meant threading a second installer through five
// containers' worth of unrelated SIGTERM/compile-cache state; a dedicated
// suite keeps the two installers' proofs independent and the failure, when
// there is one, names itself.
//
// ── What this proves ───────────────────────────────────────────────────────
//
// 1. The SAME fixture + SAME shipped templates
//    (`vinext-node-image.docker-e2e`'s `fixtures/vinext-node-app`,
//    `renderScaffold`, `stageVinextNodeDockerfile`) build with `npm install`
//    in place of `bun install` — proving the template/recipe, not a second
//    copy of it. The fixture's own committed `bun.lock` is deleted from the
//    throwaway copy FIRST, so nothing but `npm install`'s own
//    `package-lock.json` is on disk — the exact repro condition (#1864:
//    "Could not load the sharp module using the linuxmusl-x64 runtime").
// 2. The SHIPPED `stageSharpForVinextNode` (what `knext build` runs) stages
//    the image-target (`linuxmusl-x64`) sharp addon by reading that
//    `package-lock.json` — the #1864 fix. Before it, this throws a
//    `UsageError` right here, before docker ever runs.
// 3. `docker build` succeeds (the bake's own `require('sharp')` would crash
//    the build, not just the runtime, per the node entry's direct-pass) and
//    the running container serves `GET /` 200.
// 4. `/_next/image` actually RESIZES, through the image — the same proof
//    `vinext-node-image.docker-e2e` uses, repeated here against the
//    npm-installed tree: a passthrough (sharp missing/failed to load) would
//    serve the source PNG byte-for-byte.
//
// ── Discipline mirrored from the sibling suite ─────────────────────────────
//
//   - NO SKIP PATH. Missing docker, npm, or an unbuilt @getknext/core is a
//     FAILURE, never a skip.
//   - UNIQUE per-run image/container names (epoch label) + afterAll cleanup,
//     and a sweep of anything an earlier crashed run leaked.
//   - The fixture is copied to a throwaway dir; it is never built in place.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderScaffold } from "../cli/create";
import { stageVinextNodeDockerfile } from "../cli/runtime-image";
import { stageSharpForVinextNode } from "../cli/vinext-build";
import { assertNodePresetOutput } from "../cli/vinext-node-build";

// packages/kn-next/src/__tests__ -> package root (../..)
const PKG_ROOT = resolve(__dirname, "..", "..");
// The SAME fixture `vinext-node-image.docker-e2e.test.ts` uses — proving the
// same template/recipe, not a second copy of it.
const FIXTURE_SRC = join(__dirname, "fixtures", "vinext-node-app");

const PLATFORM = "linux/amd64";

const RUN_ID = randomBytes(4).toString("hex");
const CONTAINER = `knext-vinext-node-npm-e2e-${RUN_ID}`;
const IMAGE = `knext-vinext-node-npm-e2e:${RUN_ID}`;

const LABEL_KEY = "dev.knext.test";
const LABEL = `${LABEL_KEY}=vinext-node-npm-e2e`;
const EPOCH_LABEL_KEY = `${LABEL_KEY}.epoch`;
const EPOCH_LABEL = `${EPOCH_LABEL_KEY}=${Date.now()}`;
const LEAK_AGE_MS = 2 * 60 * 60 * 1000;

/** The templates the node cell ships, rendered exactly as `knext create` would. */
const RENDERED_TEMPLATES = [
    "vite.config.ts",
    "knext-node-entry.mjs",
    "knext-bun-entry.mjs",
    "runtime-contract.mjs",
    ".dockerignore",
] as const;

/**
 * Packages the node server entry imports that the fixture does NOT declare
 * itself (mirrors the sibling suite): taken from the rendered `knext create`
 * package.json, never from the fixture, so a template that forgets to
 * declare one fails here, not in a user's repo.
 */
const ENTRY_RUNTIME_DEPS = ["srvx", "sharp"] as const;

const TEST_IMAGE = join(FIXTURE_SRC, "public", "test-image.png");

let workDir = "";
let appDir = "";
let port = 0;
let npmInstallLog = "";
let dockerBuildLog = "";

function run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeout?: number } = {},
) {
    return spawnSync(cmd, args, {
        cwd: opts.cwd,
        encoding: "utf8",
        timeout: opts.timeout ?? 600_000,
    });
}

async function freePort(): Promise<number> {
    return new Promise<number>((res, rej) => {
        const srv = createServer();
        srv.on("error", rej);
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            if (addr && typeof addr === "object") {
                const p = addr.port;
                srv.close(() => res(p));
            } else {
                srv.close(() => rej(new Error("no port")));
            }
        });
    });
}

function sweepLeakedArtifacts() {
    const listed = run(
        "docker",
        [
            "ps",
            "--all",
            "--filter",
            `label=${LABEL}`,
            "--format",
            `{{.ID}} {{.Label "${EPOCH_LABEL_KEY}"}}`,
        ],
        { timeout: 60_000 },
    );
    if (listed.status === 0) {
        for (const line of listed.stdout.split("\n")) {
            const [id, epoch] = line.trim().split(/\s+/);
            const startedAt = Number(epoch);
            if (!id || !Number.isFinite(startedAt)) continue;
            if (Date.now() - startedAt > LEAK_AGE_MS) {
                run("docker", ["rm", "--force", id], { timeout: 60_000 });
            }
        }
    }
    run(
        "docker",
        [
            "image",
            "prune",
            "--force",
            "--all",
            "--filter",
            `label=${LABEL}`,
            "--filter",
            "until=2h",
        ],
        { timeout: 120_000 },
    );
}

function logsOf(container: string): string {
    const logs = run("docker", ["logs", container], { timeout: 60_000 });
    return `${logs.stdout}\n${logs.stderr}`;
}

async function waitForHealth(container: string, p: number) {
    const deadline = Date.now() + 180_000;
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${p}/api/health`);
            if (res.ok) return;
        } catch {
            // not listening yet
        }
        const running = run(
            "docker",
            ["inspect", container, "--format", "{{.State.Running}}"],
            { timeout: 60_000 },
        );
        const died = running.status === 0 && running.stdout.trim() === "false";
        if (died || Date.now() > deadline) {
            throw new Error(
                `${container} never served /api/health (${died ? "it exited" : "timed out"}).\nlogs:\n${logsOf(container)}`,
            );
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

beforeAll(async () => {
    // 1. Prerequisites are REQUIRED, never skipped around. Deliberately npm,
    //    not bun — this suite's whole point is the installer knext create
    //    actually tells every user to run.
    const docker = run(
        "docker",
        ["version", "--format", "{{.Server.Version}}"],
        { timeout: 60_000 },
    );
    if (docker.status !== 0) {
        throw new Error(
            `docker is required by this suite and is not usable: ${docker.stderr || docker.error?.message}`,
        );
    }
    const npm = run("npm", ["--version"], { timeout: 60_000 });
    if (npm.status !== 0) {
        throw new Error(
            `npm is required by this suite and is not usable: ${npm.stderr || npm.error?.message}`,
        );
    }
    const optimizer = join(
        PKG_ROOT,
        "dist",
        "adapters",
        "vinext-image-optimizer.js",
    );
    if (!existsSync(optimizer)) {
        throw new Error(
            `${optimizer} missing — build @getknext/core before this suite ` +
                "(locally: `bun run --filter @getknext/core build`, after lib and db).",
        );
    }

    sweepLeakedArtifacts();

    // 2. A throwaway app: the SAME fixture the sibling suite uses, the SAME
    //    shipped templates, rendered.
    workDir = mkdtempSync(join(tmpdir(), "knext-vinext-node-npm-"));
    appDir = join(workDir, "app");
    cpSync(FIXTURE_SRC, appDir, { recursive: true });
    // THE repro condition: delete the fixture's own committed bun.lock, so
    // nothing but npm's OWN package-lock.json is on disk once installed.
    // Leaving it would silently exercise the bun.lock path this suite is not
    // testing and certify nothing about #1864.
    rmSync(join(appDir, "bun.lock"), { force: true });

    const rendered = renderScaffold({
        name: "vinext-node-npm-fixture",
        version: "0.0.0",
        builder: "vinext",
    });
    for (const rel of RENDERED_TEMPLATES) {
        const text = rendered.get(rel);
        if (text === undefined) {
            throw new Error(
                `the scaffold no longer renders ${rel} — update this suite`,
            );
        }
        writeFileSync(join(appDir, rel), text, "utf8");
    }
    const staged = stageVinextNodeDockerfile({ cwd: appDir });
    if (!staged.staged) {
        throw new Error(
            "stageVinextNodeDockerfile wrote nothing into a fresh app",
        );
    }

    // 2b. Same injection as the sibling suite: only the entry's OWN runtime
    //     deps, from the rendered `knext create` package.json.
    const templatePkg = JSON.parse(rendered.get("package.json") ?? "{}") as {
        dependencies?: Record<string, string>;
    };
    const fixturePkgPath = join(appDir, "package.json");
    const fixturePkg = JSON.parse(readFileSync(fixturePkgPath, "utf8")) as {
        dependencies: Record<string, string>;
    };
    for (const name of ENTRY_RUNTIME_DEPS) {
        const version = templatePkg.dependencies?.[name];
        if (version !== undefined) fixturePkg.dependencies[name] = version;
    }
    writeFileSync(fixturePkgPath, `${JSON.stringify(fixturePkg, null, 2)}\n`);

    // 3. Install with NPM — the #1864 condition. No isolated linker (npm has
    //    none); @getknext/core is never declared here (same as the sibling
    //    fixture), so npm never tries to resolve it from the registry — it is
    //    linked to THIS checkout right after install, below.
    const install = run("npm", ["install"], {
        cwd: appDir,
        timeout: 300_000,
    });
    npmInstallLog = `${install.stdout}\n${install.stderr}`;
    if (install.status !== 0) {
        throw new Error(`fixture npm install failed:\n${npmInstallLog}`);
    }
    if (!existsSync(join(appDir, "package-lock.json"))) {
        throw new Error(
            "npm install produced no package-lock.json — this suite cannot " +
                "prove the #1864 fix without it.",
        );
    }
    mkdirSync(join(appDir, "node_modules", "@getknext"), { recursive: true });
    symlinkSync(
        PKG_ROOT,
        join(appDir, "node_modules", "@getknext", "core"),
        "dir",
    );

    // 4. The app's own build — vite picks the preset from knext.config.ts.
    const build = run("npm", ["run", "build"], {
        cwd: appDir,
        timeout: 600_000,
    });
    if (build.status !== 0) {
        throw new Error(
            `fixture "vite build" failed:\n${build.stdout}\n${build.stderr}`,
        );
    }
    assertNodePresetOutput(appDir);

    // 4b. THE FIX (#1864): stages sharp's linuxmusl-x64 addon by reading
    //     npm's package-lock.json — the shipped function `knext build` runs.
    //     Before the fix, `findLockfile` never finds `package-lock.json` and
    //     this throws, failing the suite right here with a clear UsageError
    //     rather than letting a broken image reach `docker build`.
    const sharpStaged = stageSharpForVinextNode(appDir, { arch: "linux-x64" });
    if (!sharpStaged.staged) {
        throw new Error(
            "stageSharpForVinextNode reported nothing staged for a fixture that declares sharp",
        );
    }

    // 5. The image, from the staged recipe.
    const image = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--progress",
            "plain",
            "--file",
            staged.dockerfile,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--tag",
            IMAGE,
            appDir,
        ],
        { timeout: 900_000 },
    );
    dockerBuildLog = `${image.stdout}\n${image.stderr}`;
    if (image.status !== 0) {
        throw new Error(`docker build failed:\n${dockerBuildLog}`);
    }

    port = await freePort();
    const started = run(
        "docker",
        [
            "run",
            "--detach",
            "--name",
            CONTAINER,
            "--label",
            LABEL,
            "--label",
            EPOCH_LABEL,
            "--platform",
            PLATFORM,
            "--publish",
            `${port}:3000`,
            IMAGE,
        ],
        { timeout: 120_000 },
    );
    if (started.status !== 0) {
        throw new Error(
            `docker run ${CONTAINER} failed:\n${started.stdout}\n${started.stderr}`,
        );
    }
    await waitForHealth(CONTAINER, port);
}, 1_800_000);

afterAll(() => {
    run("docker", ["rm", "--force", CONTAINER], { timeout: 60_000 });
    run("docker", ["rmi", "--force", IMAGE], { timeout: 60_000 });
    if (workDir) rmSync(workDir, { recursive: true, force: true });
}, 120_000);

describe("#1864 vinext × node builds and serves when installed with npm", () => {
    it("npm install produced a package-lock.json and no bun.lock reached the image build", () => {
        expect(existsSync(join(appDir, "package-lock.json"))).toBe(true);
        expect(existsSync(join(appDir, "bun.lock"))).toBe(false);
        // Sanity: the install really ran (would be empty/absent on a crash
        // this suite's own throw already catches, but belt-and-suspenders).
        expect(npmInstallLog.length).toBeGreaterThan(0);
    });

    it(".output/nitro.json says node-server", () => {
        const nitroJson = JSON.parse(
            readFileSync(join(appDir, ".output", "nitro.json"), "utf8"),
        ) as { preset?: unknown };
        expect(nitroJson.preset).toBe("node-server");
    });

    it("the docker build log shows the bake ran (no undersized-cache abort)", () => {
        expect(dockerBuildLog).toContain("compile cache baked");
    });

    it("GET / is 200 and serves the fixture's page", async () => {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body.length).toBeGreaterThan(0);
    });
});

describe("#1864 /_next/image resizes through the npm-installed image", () => {
    const SOURCE_BYTES = statSync(TEST_IMAGE).size;

    it("a webp-negotiated request is smaller than the source and decodes as webp", async () => {
        const res = await fetch(
            `http://127.0.0.1:${port}/_next/image?url=%2Ftest-image.png&w=32&q=75`,
            { headers: { accept: "image/webp" } },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/webp");
        const bytes = await res.arrayBuffer();
        // A passthrough (sharp missing/failed to load — exactly #1864's
        // defect) would serve the source PNG byte-for-byte: same size, same
        // content-type. A real resize is a two-orders-of-magnitude shrink on
        // this fixture (same margin the sibling suite asserts).
        expect(bytes.byteLength).toBeLessThan(SOURCE_BYTES / 10);
        expect(bytes.byteLength).toBeGreaterThan(0);
    });
});
