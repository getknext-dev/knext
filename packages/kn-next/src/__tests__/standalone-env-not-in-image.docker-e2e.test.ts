/**
 * #1327 — a `.env*` file the app's OWN build produced must never ship inside
 * the standalone runtime image.
 *
 * ── The mechanism, measured, not assumed ─────────────────────────────────
 *
 * `next build` (output:'standalone') copies the app's own `.env`/
 * `.env.production` straight into `.next/standalone/` as part of the
 * standalone output tree — this is Next's own behaviour, not knext's.
 * `Dockerfile.standalone.hbs` then does `COPY .next/standalone
 * /app/.next/standalone` wholesale, so whatever Next put there ships in the
 * image UNLESS the per-Dockerfile `.dockerignore` (`standaloneDockerignore()`
 * in `../cli/runtime-image.ts`) excludes it from the build context first.
 *
 * The bug: that ignore file carried the BARE `.env`/`.env.*` patterns. A bare
 * dockerignore pattern matches ONLY at the context root — the same
 * non-recursion bug #1284 already fixed for `.vinext`/`.output` — so it never
 * touched `.next/standalone/.env.production`, two directories below the
 * root. Fixed by widening the patterns to `**\/.env`/`**\/.env.*` (keeping
 * `!**\/.env.example`).
 *
 * This suite is the real proof, not a `.dockerignore`-string assertion: it
 * plants a canary `.env.production`, runs a REAL `next build`, stages the
 * REAL `stageStandaloneBuildContext()`, runs a REAL
 * `docker build --target standalone-node`, and inspects the REAL exported
 * image filesystem for the canary. `--target standalone-node` is
 * representative of BOTH shipped runtimes: `standalone-bun` reuses the exact
 * same `COPY .next/standalone /app/.next/standalone` line against the same
 * staged context (see `Dockerfile.standalone.hbs`), so the leak — and the
 * fix — does not depend on which target compiles it; the bun target's own
 * bytecode-exec compile step is orthogonal to this bug and is exercised by
 * `standalone-drain.docker-e2e.test.ts`.
 *
 * Mutation-proved during development (not re-run in CI — this suite is
 * already docker-e2e-slow): reverting `standaloneDockerignore()`'s
 * `**\/.env`/`**\/.env.*` back to the bare `.env`/`.env.*` form reproduces the
 * canary verbatim inside the exported image, at
 * `app/.next/standalone/.env.production`.
 *
 * Discipline mirrored from `standalone-drain.docker-e2e.test.ts`:
 *   - NO SKIP PATH. Missing docker or bun is a FAILURE, never a skip.
 *   - UNIQUE per-run image/container names + afterAll cleanup.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageStandaloneBuildContext } from "../cli/runtime-image";

const PKG_ROOT = resolve(__dirname, "..", "..");
const FIXTURE_SRC = join(__dirname, "fixtures", "standalone-drain-app");
const TEMPLATE_DIR = join(PKG_ROOT, "templates", "runtime-standalone");
const PLATFORM = "linux/amd64";

const RUN_ID = randomBytes(4).toString("hex");
const IMAGE = `knext-standalone-env-e2e:${RUN_ID}`;
const CONTAINER = `knext-standalone-env-e2e-${RUN_ID}`;
const CANARY_VALUE = randomBytes(12).toString("hex");
const CANARY_LINE = `KNEXT_CANARY_1327=${CANARY_VALUE}`;

const LABEL_KEY = "dev.knext.test";
const LABEL = `${LABEL_KEY}=standalone-env-e2e`;

function run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; timeout?: number; env?: NodeJS.ProcessEnv } = {},
) {
    return spawnSync(cmd, args, {
        cwd: opts.cwd,
        encoding: "utf8",
        timeout: opts.timeout ?? 600_000,
        env: opts.env,
    });
}

let workDir = "";
let exportTar = "";

beforeAll(() => {
    const docker = run(
        "docker",
        ["version", "--format", "{{.Server.Version}}"],
        {
            timeout: 60_000,
        },
    );
    if (docker.status !== 0) {
        throw new Error(
            `docker is required by this suite and is not usable: ${docker.stderr || docker.error?.message}`,
        );
    }
    const bun = run("bun", ["--version"], { timeout: 60_000 });
    if (bun.status !== 0) {
        throw new Error(
            `bun is required by this suite and is not usable: ${bun.stderr || bun.error?.message}`,
        );
    }
    if (!existsSync(join(PKG_ROOT, "dist", "adapters", "node-server.js"))) {
        throw new Error(
            `${join(PKG_ROOT, "dist", "adapters", "node-server.js")} missing — build ` +
                "@getknext/core before this suite (locally: `bun run --filter @getknext/core build`).",
        );
    }

    workDir = mkdtempSync(join(tmpdir(), "knext-standalone-env-"));
    const appDir = join(workDir, "app");
    cpSync(FIXTURE_SRC, appDir, { recursive: true });

    // Plant the canary BEFORE `next build` runs, so this proves what Next's
    // own build does with a real `.env.production`, not a hand-copied one.
    writeFileSync(join(appDir, ".env.production"), `${CANARY_LINE}\n`, "utf8");

    const install = run("bun", ["install"], { cwd: appDir, timeout: 300_000 });
    if (install.status !== 0) {
        throw new Error(
            `fixture bun install failed:\n${install.stdout}\n${install.stderr}`,
        );
    }
    // `bun test` sets NODE_ENV=test on this process, and `run()` otherwise
    // inherits it — which would make Next load `.env.test` instead of
    // `.env.production` and copy nothing, silently making this suite prove
    // nothing. Force NODE_ENV=production for the build subprocess, matching
    // the real `knext build`/`next build` deploy path (unset NODE_ENV,
    // which `next build` itself treats as production).
    const build = run("bun", ["run", "build"], {
        cwd: appDir,
        timeout: 600_000,
        env: { ...process.env, NODE_ENV: "production" },
    });
    if (build.status !== 0) {
        throw new Error(
            `fixture next build failed:\n${build.stdout}\n${build.stderr}`,
        );
    }

    const standaloneEnv = join(
        appDir,
        ".next",
        "standalone",
        ".env.production",
    );
    if (!existsSync(standaloneEnv)) {
        throw new Error(
            `precondition failed: Next's own build did not copy .env.production into ` +
                `.next/standalone — this suite would prove nothing. (${standaloneEnv})`,
        );
    }

    const ctx = join(workDir, "ctx");
    mkdirSync(ctx, { recursive: true });
    cpSync(
        join(appDir, ".next", "standalone"),
        join(ctx, ".next", "standalone"),
        {
            recursive: true,
        },
    );
    cpSync(join(appDir, ".next", "static"), join(ctx, ".next", "static"), {
        recursive: true,
    });
    mkdirSync(join(ctx, "public"), { recursive: true });
    if (existsSync(join(appDir, "public"))) {
        cpSync(join(appDir, "public"), join(ctx, "public"), {
            recursive: true,
        });
    }
    const coreDst = join(ctx, "node_modules", "@getknext", "core");
    mkdirSync(coreDst, { recursive: true });
    cpSync(join(PKG_ROOT, "package.json"), join(coreDst, "package.json"));
    cpSync(join(PKG_ROOT, "dist"), join(coreDst, "dist"), { recursive: true });

    // The shipped staging function — the same one `deploy.ts`/`preview.ts`
    // call — so a regression in its `.dockerignore` keep-list reds THIS test.
    const staged = stageStandaloneBuildContext({
        cwd: ctx,
        buildContext: ctx,
        templateDir: TEMPLATE_DIR,
    });

    const image = run(
        "docker",
        [
            "build",
            "--platform",
            PLATFORM,
            "--target",
            "standalone-node",
            "--file",
            staged.dockerfile,
            "--label",
            LABEL,
            "--tag",
            IMAGE,
            ctx,
        ],
        { timeout: 600_000 },
    );
    if (image.status !== 0) {
        throw new Error(
            `docker build failed:\n${image.stdout}\n${image.stderr}`,
        );
    }

    const created = run("docker", ["create", "--name", CONTAINER, IMAGE], {
        timeout: 60_000,
    });
    if (created.status !== 0) {
        throw new Error(
            `docker create failed:\n${created.stdout}\n${created.stderr}`,
        );
    }

    exportTar = join(workDir, "image.tar");
    const exported = spawnSync(
        "docker",
        ["export", "--output", exportTar, CONTAINER],
        {
            encoding: "utf8",
            timeout: 120_000,
        },
    );
    if (exported.status !== 0) {
        throw new Error(
            `docker export failed:\n${exported.stdout}\n${exported.stderr}`,
        );
    }
}, 900_000);

afterAll(() => {
    run("docker", ["rm", "--force", CONTAINER], { timeout: 60_000 });
    run("docker", ["rmi", "--force", IMAGE], { timeout: 60_000 });
    if (workDir) {
        rmSync(workDir, { recursive: true, force: true });
    }
});

describe("#1327 — .env* never ships inside the standalone runtime image", () => {
    it("no .env* file exists anywhere in the exported image filesystem", () => {
        const listing = spawnSync("tar", ["-tf", exportTar], {
            encoding: "utf8",
        });
        expect(listing.status).toBe(0);
        const envEntries = listing.stdout
            .split("\n")
            .filter((entry) => /(^|\/)\.env(\.|$)/.test(entry));
        expect(
            envEntries,
            `image filesystem must contain no .env* entries, found: ${envEntries.join(", ")}`,
        ).toEqual([]);
    });

    it("the canary value is not present anywhere in the exported image", () => {
        const extractDir = join(workDir, "extract");
        mkdirSync(extractDir, { recursive: true });
        const extracted = spawnSync(
            "tar",
            ["-xf", exportTar, "-C", extractDir],
            {
                encoding: "utf8",
                timeout: 120_000,
            },
        );
        expect(extracted.status).toBe(0);
        const grepped = spawnSync("grep", ["-rl", CANARY_VALUE, extractDir], {
            encoding: "utf8",
            timeout: 120_000,
        });
        // grep exit 1 = no match found anywhere — the expected, passing result.
        expect(
            grepped.status,
            `canary value found in image filesystem: ${grepped.stdout}`,
        ).toBe(1);
    }, 180_000);
});
