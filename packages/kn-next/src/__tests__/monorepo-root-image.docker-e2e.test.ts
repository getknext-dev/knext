// @vitest-environment node
//
// monorepo-root-image.docker-e2e — the SHIPPED standalone runtime image for a
// workspace monorepo with an explicit tracing root, built from the files
// `knext build` stages and RUN.
//
// `monorepo-root.docker-e2e.test.ts` proves the host side: the nested server,
// the traced workspace files, the compiled executable, the supervisor. What it
// cannot prove is the Dockerfile rewrite for the nested layout, because that is
// only real once Docker resolves every COPY against the workspace-root build
// context. This suite builds the image with BOTH disk targets and boots it:
//
//   - standalone-bun: the compiled bytecode executable, placed beside the
//     nested server, serves the page that uses the shared package and reads the
//     traced workspace file (`packages/shared/note.txt`, outside the app dir);
//   - standalone-node: the same page under node, with the V8 compile cache baked
//     where the supervisor looks for it (`<server dir>/.next/compile-cache`);
//   - Next's runtime cache dir is linked to the path the operator mounts
//     writable, so a read-only root filesystem keeps working.
//
// ── Discipline (mirrors standalone-drain.docker-e2e) ────────────────────────
//   - NO SKIP PATH. Missing docker, bun or a built @getknext/core is a FAILURE.
//     Excluded from the fast lane by the `.docker-e2e.test.ts` suffix; run by the
//     `standalone-drain-bun-image` CI job (docker + bun + built core).
//   - UNIQUE per-run image/container names + afterAll cleanup, labelled so an
//     aborted run's leftovers are findable.
//   - Every temp dir goes through the `tempRoots` registry (D9 pairing).

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    freePorts,
    knextBuild,
    PKG_ROOT,
    type StagedMonorepo,
    stageMonorepo,
} from "./monorepo-fixture";

const PLATFORM = "linux/amd64";
const RUN_ID = randomBytes(4).toString("hex");
const LABEL = "dev.knext.test=monorepo-root-image-e2e";
const BUN_IMAGE = `knext-monorepo-root-e2e-bun:${RUN_ID}`;
const NODE_IMAGE = `knext-monorepo-root-e2e-node:${RUN_ID}`;
const containers: string[] = [];
const tempRoots: string[] = [];

const EXPECTED_BODY = [
    "hello from the shared workspace package",
    "traced-from-outside-the-app-dir",
];

function docker(args: string[], timeout = 600_000) {
    return spawnSync("docker", args, { encoding: "utf8", timeout });
}

let monorepo: StagedMonorepo;

beforeAll(() => {
    const info = docker(["info", "--format", "{{.ServerVersion}}"], 60_000);
    if (info.status !== 0) {
        throw new Error(
            `docker is required by this suite and is not usable: ${info.stderr}`,
        );
    }
    for (const built of [
        join(PKG_ROOT, "dist", "adapters", "node-server.js"),
        join(PKG_ROOT, "dist", "adapters", "standalone-compile.js"),
    ]) {
        if (!existsSync(built)) {
            throw new Error(
                `${built} missing — build @getknext/core before this suite ` +
                    "(CI builds it in the standalone-drain-bun-image job).",
            );
        }
    }

    const root = realpathSync(mkdtempSync(join(tmpdir(), "knext-monorepo-")));
    tempRoots.push(root);
    monorepo = stageMonorepo(root);

    // @getknext/core as a HOISTED workspace install would leave it, at the
    // workspace root, dereferenced into a real directory (the repo's own
    // workspace symlink points outside the context, which COPY cannot follow).
    // It must exist BEFORE `knext build` stages the Dockerfile: the staging
    // resolves where the context holds it.
    const core = join(monorepo.root, "node_modules", "@getknext", "core");
    mkdirSync(core, { recursive: true });
    cpSync(join(PKG_ROOT, "package.json"), join(core, "package.json"));
    cpSync(join(PKG_ROOT, "dist"), join(core, "dist"), { recursive: true });
    cpSync(
        join(PKG_ROOT, "templates", "runtime-standalone"),
        join(core, "templates", "runtime-standalone"),
        { recursive: true },
    );

    const build = knextBuild(monorepo.app);
    if (build.status !== 0) {
        throw new Error(
            `knext build failed:\n${build.stdout}\n${build.stderr}`,
        );
    }

    for (const [target, tag] of [
        ["standalone-bun", BUN_IMAGE],
        ["standalone-node", NODE_IMAGE],
    ] as const) {
        const image = docker([
            "build",
            "--platform",
            PLATFORM,
            "--target",
            target,
            "--file",
            join(monorepo.app, "Dockerfile.standalone"),
            "--label",
            LABEL,
            "--tag",
            tag,
            monorepo.root,
        ]);
        if (image.status !== 0) {
            throw new Error(
                `docker build --target ${target} failed:\n${image.stdout}\n${image.stderr}`,
            );
        }
    }
}, 1_800_000);

afterAll(() => {
    for (const c of containers) docker(["rm", "--force", c], 60_000);
    for (const i of [BUN_IMAGE, NODE_IMAGE])
        docker(["rmi", "--force", i], 60_000);
    for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

async function bootAndFetch(image: string, extraArgs: string[] = []) {
    const [port] = await freePorts(1);
    const name = `knext-monorepo-root-e2e-${RUN_ID}-${containers.length}`;
    const started = docker(
        [
            "run",
            "--detach",
            "--name",
            name,
            "--label",
            LABEL,
            "--platform",
            PLATFORM,
            "--publish",
            `${port}:3000`,
            ...extraArgs,
            image,
        ],
        120_000,
    );
    if (started.status !== 0) {
        throw new Error(
            `docker run failed:\n${started.stdout}\n${started.stderr}`,
        );
    }
    containers.push(name);
    const deadline = Date.now() + 90_000;
    for (;;) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            if (res.status === 200) return { name, html: await res.text() };
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline) {
            const logs = docker(["logs", name], 60_000);
            throw new Error(
                `${image} never served /:\n${logs.stdout}\n${logs.stderr}`,
            );
        }
        await new Promise((r) => setTimeout(r, 500));
    }
}

describe("the standalone image for a workspace monorepo root", () => {
    it("standalone-bun serves the page from the compiled executable beside the nested server", async () => {
        const { name, html } = await bootAndFetch(BUN_IMAGE);
        for (const needle of EXPECTED_BODY) expect(html).toContain(needle);
        const logs = docker(["logs", name], 60_000);
        const out = `${logs.stdout}\n${logs.stderr}`;
        // The supervisor spawned the executable, not a script.
        const start = out
            .split("\n")
            .find((l) => l.includes("Starting Next.js standalone server"));
        expect(start, out).toBeDefined();
        expect(start).toContain('"mode":"exec"');
        expect(start).toContain(
            "/app/.next/standalone/apps/web/knext-standalone-exec",
        );
    }, 300_000);

    it("standalone-node serves the same page, with the compile cache baked at the nested server's own .next", async () => {
        const { html } = await bootAndFetch(NODE_IMAGE);
        for (const needle of EXPECTED_BODY) expect(html).toContain(needle);
        const cache = docker([
            "run",
            "--rm",
            "--platform",
            PLATFORM,
            "--entrypoint",
            "sh",
            NODE_IMAGE,
            "-c",
            "find /app/.next/standalone/apps/web/.next/compile-cache -type f | wc -l",
        ]);
        expect(Number(cache.stdout.trim())).toBeGreaterThan(0);
    }, 300_000);

    for (const [label, image] of [
        ["standalone-bun", BUN_IMAGE],
        ["standalone-node", NODE_IMAGE],
    ] as const) {
        it(`${label}: Next's runtime cache dir resolves to the path the operator mounts writable`, () => {
            const link = docker([
                "run",
                "--rm",
                "--platform",
                PLATFORM,
                "--entrypoint",
                "sh",
                image,
                "-c",
                "readlink /app/.next/standalone/apps/web/.next/cache",
            ]);
            expect(link.stdout.trim()).toBe(
                "/app/.next/standalone/.next/cache",
            );
        }, 120_000);
    }
});
