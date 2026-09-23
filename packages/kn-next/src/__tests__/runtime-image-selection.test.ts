/**
 * runtime-image-selection — the CLI-selection wiring for ADR-0055.
 *
 * ADR-0055 ships two runtime image shapes: the vinext single-executable image
 * (`templates/app/Dockerfile.hbs`, scaffolded by `kn-next create`) and the
 * node/bun STANDALONE runtime image (`templates/runtime-standalone/`,
 * deliberately kept OUT of scaffold-emission by the #1177 increment). This
 * suite pins the wiring that selects between them at build/deploy time:
 *
 *   - vinext (build absent or "vinext")  -> the scaffolded app Dockerfile,
 *     no `--target` (single-stage).
 *   - turbopack (standalone shape)       -> the staged standalone template,
 *     `--target standalone-bun` (runtime bun) or `standalone-node` (default).
 *
 * The selection lives at BUILD/DEPLOY time, not create time: `config.build` is
 * authoritative there, it can change after `create`, and `deploy` reads a fixed
 * build context — so the standalone Dockerfile is STAGED into that context only
 * for the standalone target, leaving the vinext scaffold coherent.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    dockerBuildxArgs,
    dockerignoreExcludes,
    type RuntimeImageConfig,
    runtimeStandaloneTemplateDir,
    STANDALONE_DOCKERFILE_NAME,
    selectRuntimeImage,
    stageStandaloneBuildContext,
    VINEXT_NODE_DOCKERFILE_NAME,
} from "../cli/runtime-image";

const _tmpDirs: string[] = [];
function tmp(): string {
    const dir = mkdtempSync(join(tmpdir(), "knext-runtime-image-"));
    _tmpDirs.push(dir);
    return dir;
}
// D9 (#880): a mkdtemp with no paired removal leaks a directory per run.
afterAll(() => {
    for (const dir of _tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("selectRuntimeImage — target selection by (build, runtime)", () => {
    it("vinext (build absent) -> the scaffolded app Dockerfile, no --target", () => {
        const sel = selectRuntimeImage({}, "/app");
        expect(sel.kind).toBe("app-dockerfile");
        expect(sel.dockerfile).toBe(join("/app", "Dockerfile"));
        expect(sel.target).toBeUndefined();
    });

    it("vinext (build explicitly 'vinext') -> app Dockerfile, no --target", () => {
        const sel = selectRuntimeImage({ build: "vinext" }, "/app");
        expect(sel.kind).toBe("app-dockerfile");
        expect(sel.dockerfile).toBe(join("/app", "Dockerfile"));
        expect(sel.target).toBeUndefined();
    });

    it("vinext ignores config.runtime — it has no standalone stages", () => {
        // A vinext app that also carries runtime:'bun' must NOT get a
        // standalone --target; the single executable IS the server.
        const sel = selectRuntimeImage(
            { build: "vinext", runtime: "bun" },
            "/app",
        );
        expect(sel.kind).toBe("app-dockerfile");
        expect(sel.dockerfile).toBe(join("/app", "Dockerfile"));
        expect(sel.target).toBeUndefined();
    });

    it("vinext + runtime node -> the vinext-node Dockerfile, no --target (#1260)", () => {
        // The node cell ships `.output` under node with a baked V8 compile
        // cache — NOT the single-exec Dockerfile, whose CMD is a compiled
        // binary this cell never builds.
        const sel = selectRuntimeImage(
            { build: "vinext", runtime: "node" },
            "/app",
        );
        expect(sel.kind).toBe("app-dockerfile");
        expect(sel.dockerfile).toBe(join("/app", VINEXT_NODE_DOCKERFILE_NAME));
        expect(VINEXT_NODE_DOCKERFILE_NAME).toBe("Dockerfile.vinext-node");
        expect(sel.target).toBeUndefined();
    });

    it("turbopack + runtime bun -> staged standalone Dockerfile, --target standalone-bun", () => {
        const sel = selectRuntimeImage(
            { build: "turbopack", runtime: "bun" },
            "/app",
        );
        expect(sel.kind).toBe("standalone");
        expect(sel.dockerfile).toBe(join("/app", "Dockerfile.standalone"));
        expect(sel.target).toBe("standalone-bun");
    });

    it("turbopack + runtime node -> --target standalone-node", () => {
        const sel = selectRuntimeImage(
            { build: "turbopack", runtime: "node" },
            "/app",
        );
        expect(sel.kind).toBe("standalone");
        expect(sel.target).toBe("standalone-node");
    });

    it("turbopack + runtime absent -> standalone-node (node is the runtime default)", () => {
        const sel = selectRuntimeImage({ build: "turbopack" }, "/app");
        expect(sel.kind).toBe("standalone");
        expect(sel.target).toBe("standalone-node");
    });

    it("webpack + runtime bun -> staged standalone Dockerfile, --target standalone-bun (#1219)", () => {
        // webpack reuses the turbopack selection path entirely — it is
        // selected by artifact SHAPE (next-standalone), not by builder id.
        const sel = selectRuntimeImage(
            { build: "webpack", runtime: "bun" },
            "/app",
        );
        expect(sel.kind).toBe("standalone");
        expect(sel.dockerfile).toBe(join("/app", "Dockerfile.standalone"));
        expect(sel.target).toBe("standalone-bun");
    });

    it("webpack + runtime absent -> standalone-node (#1219)", () => {
        const sel = selectRuntimeImage({ build: "webpack" }, "/app");
        expect(sel.kind).toBe("standalone");
        expect(sel.target).toBe("standalone-node");
    });

    it("an unrecognised build id THROWS rather than silently building the standalone recipe (cr-1181 #3, fail-closed)", () => {
        // A caller reading `kn-next.config.ts` at runtime is not TS-checked
        // against `BuilderId` — a config file can carry any string. A future
        // builder id (e.g. a compiled `+exec` shape) must not silently select
        // the `.next/standalone` recipe just because it isn't literally
        // "vinext"; it must be recognised by the artifact contract or refused.
        // `config.build` is read from `kn-next.config.ts` at runtime, so it
        // is not TS-checked against `BuilderId` there — simulate that with
        // `unknown`, not `any`.
        const unrecognisedConfig = {
            build: "bun-exec",
        } as unknown as RuntimeImageConfig;
        expect(() => selectRuntimeImage(unrecognisedConfig, "/app")).toThrow(
            /unrecognised|unknown/i,
        );
    });
});

describe("dockerBuildxArgs — the buildx argv the CLI runs", () => {
    const base = {
        taggedRef: "reg/app:tag",
        metadataFilePath: "/ctx/.output/buildx-metadata.json",
        buildContext: "/ctx",
    };

    it("vinext: no --target, -f points at the app Dockerfile (UNCHANGED shape)", () => {
        const argv = dockerBuildxArgs({
            ...base,
            dockerfile: "/app/Dockerfile",
        });
        expect(argv).toEqual([
            "docker",
            "buildx",
            "build",
            "--platform",
            "linux/amd64",
            "-f",
            "/app/Dockerfile",
            "-t",
            "reg/app:tag",
            "--push",
            "--metadata-file",
            "/ctx/.output/buildx-metadata.json",
            "/ctx",
        ]);
    });

    it("standalone: injects --target with the stage name, keeps context last", () => {
        const argv = dockerBuildxArgs({
            ...base,
            dockerfile: "/app/Dockerfile.standalone",
            target: "standalone-bun",
        });
        const i = argv.indexOf("--target");
        expect(i).toBeGreaterThan(-1);
        expect(argv[i + 1]).toBe("standalone-bun");
        expect(argv.filter((a) => a === "--target")).toHaveLength(1);
        // The context is still the last token.
        expect(argv[argv.length - 1]).toBe("/ctx");
        // -f still names the standalone Dockerfile.
        expect(argv[argv.indexOf("-f") + 1]).toBe("/app/Dockerfile.standalone");
    });

    it("standalone-node target is passed verbatim", () => {
        const argv = dockerBuildxArgs({
            ...base,
            dockerfile: "/app/Dockerfile.standalone",
            target: "standalone-node",
        });
        expect(argv[argv.indexOf("--target") + 1]).toBe("standalone-node");
    });

    it("standalone-node with a custom healthCheckPath passes it as --build-arg KNEXT_HEALTH_CHECK_PATH (#1264 follow-up)", () => {
        // The bake warms a hardcoded /api/health unless the app's configured
        // healthCheckPath is threaded through as a build-arg — an app with a
        // custom path and no /api/health route would otherwise fail the BUILD.
        const argv = dockerBuildxArgs({
            ...base,
            dockerfile: "/app/Dockerfile.standalone",
            target: "standalone-node",
            healthCheckPath: "/healthz",
        });
        const i = argv.indexOf("--build-arg");
        expect(i).toBeGreaterThan(-1);
        expect(argv[i + 1]).toBe("KNEXT_HEALTH_CHECK_PATH=/healthz");
    });

    it("no healthCheckPath configured -> no --build-arg (the Dockerfile's own /api/health default applies)", () => {
        const argv = dockerBuildxArgs({
            ...base,
            dockerfile: "/app/Dockerfile.standalone",
            target: "standalone-node",
        });
        expect(argv).not.toContain("--build-arg");
    });

    it("standalone-bun target ignores healthCheckPath — the bun stage never boots/warms the server to bake a cache", () => {
        const argv = dockerBuildxArgs({
            ...base,
            dockerfile: "/app/Dockerfile.standalone",
            target: "standalone-bun",
            healthCheckPath: "/healthz",
        });
        expect(argv).not.toContain("--build-arg");
    });

    it("vinext (no target) ignores healthCheckPath — no bake in that image build", () => {
        const argv = dockerBuildxArgs({
            ...base,
            dockerfile: "/app/Dockerfile",
            healthCheckPath: "/healthz",
        });
        expect(argv).not.toContain("--build-arg");
    });
});

describe("stageStandaloneBuildContext — stages a BOOTABLE standalone build context", () => {
    it("writes Dockerfile.standalone (both runtime stages, digest-pinned) verbatim from the template", () => {
        const ctx = tmp();
        const { dockerfile } = stageStandaloneBuildContext({
            cwd: ctx,
            buildContext: ctx,
        });
        expect(dockerfile).toBe(join(ctx, "Dockerfile.standalone"));
        const text = readFileSync(dockerfile, "utf8");
        // Both --target stages present.
        expect(text).toMatch(/AS standalone-bun\b/);
        expect(text).toMatch(/AS standalone-node\b/);
        // Digest-pinned bases (reused from the repo's pins).
        expect(text).toContain("oven/bun:1.4.0-alpine@sha256:");
        expect(text).toContain("node:22-alpine@sha256:");
        // The staged file is byte-identical to the source template.
        const template = readFileSync(
            join(runtimeStandaloneTemplateDir(), "Dockerfile.standalone.hbs"),
            "utf8",
        );
        expect(text).toBe(template);
    });

    it("writes knext-standalone-entry.mjs into the build context root (the COPY source the Dockerfile names)", () => {
        const ctx = tmp();
        stageStandaloneBuildContext({ cwd: ctx, buildContext: ctx });
        const entry = join(ctx, "knext-standalone-entry.mjs");
        expect(existsSync(entry)).toBe(true);
        expect(readFileSync(entry, "utf8")).toMatch(
            /import\(\s*["']@getknext\/core\/internal\/node-server["']\s*\)/,
        );
    });

    it("writes knext-compile-cache-bake.mjs into the build context root — the COPY source the standalone-node bake RUN step needs (#1264)", () => {
        const ctx = tmp();
        stageStandaloneBuildContext({ cwd: ctx, buildContext: ctx });
        const bake = join(ctx, "knext-compile-cache-bake.mjs");
        expect(existsSync(bake)).toBe(true);
        // Not a spawn-then-signal driver: it imports the standalone server
        // itself, so the process that compiled it is the one that flushes.
        expect(readFileSync(bake, "utf8")).toContain(
            "process.env.STANDALONE_SERVER_PATH",
        );
    });

    it("stages the entry at the build-context root even when it differs from cwd", () => {
        // COPY sources resolve against the build CONTEXT, not cwd, so the entry
        // must land in the context — otherwise `COPY knext-standalone-entry.mjs`
        // fails and the image is unbuildable.
        const ctx = tmp();
        const cwd = join(ctx, "apps", "web");
        mkdirSync(cwd, { recursive: true });
        const { dockerfile } = stageStandaloneBuildContext({
            cwd,
            buildContext: ctx,
        });
        expect(dockerfile).toBe(join(cwd, "Dockerfile.standalone"));
        expect(existsSync(join(ctx, "knext-standalone-entry.mjs"))).toBe(true);
    });

    it("aborts on an unsubstituted {{ }} placeholder left in the ENTRY SHIM, not just the Dockerfile (cr-1181 #4, both-halves guard)", () => {
        // The Dockerfile text gets the `{{`-placeholder assertion; the entry
        // shim was `copyFileSync`'d unchecked. A leftover mustache in the
        // shim must abort staging exactly like a leftover mustache in the
        // Dockerfile does — not ship a broken entry silently.
        const templateDir = tmp();
        const dockerfileText = readFileSync(
            join(runtimeStandaloneTemplateDir(), "Dockerfile.standalone.hbs"),
            "utf8",
        );
        writeFileSync(
            join(templateDir, "Dockerfile.standalone.hbs"),
            dockerfileText,
            "utf8",
        );
        writeFileSync(
            join(templateDir, "knext-standalone-entry.mjs.hbs"),
            "import('@getknext/core/internal/node-server')({{ broken }});\n",
            "utf8",
        );
        writeFileSync(
            join(templateDir, "knext-compile-cache-bake.mjs.hbs"),
            "process.env.STANDALONE_SERVER_PATH;\n",
            "utf8",
        );
        const ctx = tmp();
        expect(() =>
            stageStandaloneBuildContext({
                cwd: ctx,
                buildContext: ctx,
                templateDir,
            }),
        ).toThrow(/\{\{/);
        // And it must not have written a broken entry into the context.
        expect(existsSync(join(ctx, "knext-standalone-entry.mjs"))).toBe(false);
    });

    it("throws when the installed package is missing templates/runtime-standalone/ (no Dockerfile.standalone.hbs or entry shim)", () => {
        // A broken/partial install (or a templateDir override pointed at the
        // wrong package root) must abort staging with a clear message, not
        // silently write nothing or throw an unrelated ENOENT from readFileSync.
        const emptyTemplateDir = tmp();
        const ctx = tmp();
        expect(() =>
            stageStandaloneBuildContext({
                cwd: ctx,
                buildContext: ctx,
                templateDir: emptyTemplateDir,
            }),
        ).toThrow(/template not found/);
        // Nothing must have been staged into the context.
        expect(existsSync(join(ctx, STANDALONE_DOCKERFILE_NAME))).toBe(false);
    });

    it("throws when only the Dockerfile.standalone.hbs exists but the entry shim is missing", () => {
        // Both files are required; a half-present template dir must still be
        // treated as broken, not staged with a missing COPY source.
        const templateDir = tmp();
        writeFileSync(
            join(templateDir, "Dockerfile.standalone.hbs"),
            "FROM scratch\n",
            "utf8",
        );
        const ctx = tmp();
        expect(() =>
            stageStandaloneBuildContext({
                cwd: ctx,
                buildContext: ctx,
                templateDir,
            }),
        ).toThrow(/template not found/);
    });

    it("aborts on an unsubstituted {{ }} placeholder left in the DOCKERFILE itself, not just the entry shim", () => {
        // The entry-shim {{ }} guard is covered above (cr-1181 #4); this pins
        // the ORIGINAL Dockerfile-side assertion the comment describes — a
        // leftover mustache in Dockerfile.standalone.hbs must also abort, and
        // must not silently ship a Dockerfile with a raw template variable in
        // it (which would fail the docker build with a confusing error, not
        // this one).
        const templateDir = tmp();
        writeFileSync(
            join(templateDir, "Dockerfile.standalone.hbs"),
            "FROM {{ base }} AS standalone-node\n",
            "utf8",
        );
        writeFileSync(
            join(templateDir, "knext-standalone-entry.mjs.hbs"),
            "import('@getknext/core/internal/node-server')();\n",
            "utf8",
        );
        writeFileSync(
            join(templateDir, "knext-compile-cache-bake.mjs.hbs"),
            "process.env.STANDALONE_SERVER_PATH;\n",
            "utf8",
        );
        const ctx = tmp();
        expect(() =>
            stageStandaloneBuildContext({
                cwd: ctx,
                buildContext: ctx,
                templateDir,
            }),
        ).toThrow(/Dockerfile\.standalone\.hbs contains an unsubstituted/);
        // Nothing must have been written into the context on failure.
        expect(existsSync(join(ctx, "knext-standalone-entry.mjs"))).toBe(false);
        expect(existsSync(join(ctx, "Dockerfile.standalone"))).toBe(false);
    });

    it("writes a per-Dockerfile .dockerignore that keeps the standalone closure IN the context", () => {
        const ctx = tmp();
        stageStandaloneBuildContext({ cwd: ctx, buildContext: ctx });
        const ignorePath = join(ctx, "Dockerfile.standalone.dockerignore");
        expect(existsSync(ignorePath)).toBe(true);
        const content = readFileSync(ignorePath, "utf8");
        // The COPY sources the standalone image needs must NOT be excluded — the
        // exact hazard the template header warns about (the vinext .dockerignore
        // excludes all of .next and node_modules).
        for (const needed of [
            ".next/standalone",
            ".next/standalone/server.js",
            ".next/static",
            "public",
            "node_modules/@getknext/core",
            "knext-standalone-entry.mjs",
        ]) {
            expect(
                dockerignoreExcludes(content, needed),
                `standalone .dockerignore must NOT exclude ${needed}`,
            ).toBe(false);
        }
        // Secrets still excluded (defense-in-depth, matches the app ignore).
        for (const secret of [".env", ".env.local", "kubeconfig"]) {
            expect(
                dockerignoreExcludes(content, secret),
                `standalone .dockerignore must still exclude ${secret}`,
            ).toBe(true);
        }
    });
});

describe("dockerignoreExcludes — the evaluator the staging guard relies on", () => {
    it("last-match-wins with negation (re-include beats a prior exclude)", () => {
        const content = ".next\n!.next/standalone\n";
        // parent excluded, child re-included -> child kept
        expect(dockerignoreExcludes(content, ".next/standalone")).toBe(false);
        // a sibling not re-included is still excluded
        expect(dockerignoreExcludes(content, ".next/cache")).toBe(true);
    });

    it("a bare directory pattern excludes everything under it", () => {
        const content = "node_modules\n";
        expect(dockerignoreExcludes(content, "node_modules")).toBe(true);
        expect(
            dockerignoreExcludes(content, "node_modules/@getknext/core"),
        ).toBe(true);
    });

    it("comments and blank lines are ignored", () => {
        const content = "# a comment\n\n.env\n";
        expect(dockerignoreExcludes(content, ".env")).toBe(true);
        expect(dockerignoreExcludes(content, "src")).toBe(false);
    });

    it("wildcard patterns match (.env.*)", () => {
        const content = ".env.*\n";
        expect(dockerignoreExcludes(content, ".env.local")).toBe(true);
        expect(dockerignoreExcludes(content, ".environment")).toBe(false);
    });
});
