/**
 * kn-next runtime-image — selects and stages the runtime image per build target
 * (ADR-0055 CLI-selection wiring).
 *
 * knext ships two runtime image shapes:
 *
 *   - the **vinext single-executable** image (`templates/app/Dockerfile.hbs`),
 *     scaffolded into every app by `kn-next create`. The binary IS the server;
 *     the operator leaves the container command nil and kubelet runs the image's
 *     own CMD.
 *   - the **node/bun standalone** runtime image (`templates/runtime-standalone/`,
 *     ADR-0055). `next build` emits `.next/standalone`, and the image's
 *     ENTRYPOINT is a supervisor entry (`knext-standalone-entry.mjs` importing
 *     `@getknext/core/internal/node-server`) that spawns the real Next
 *     `server.js` as a child so it can drain it on SIGTERM.
 *
 * WHY THE SELECTION LIVES HERE (build/deploy time), NOT AT `create` time.
 *
 * The runtime axis is decided by `config.build` (`turbopack` -> standalone;
 * absent/`vinext` -> single executable) and, for the standalone shape,
 * `config.runtime` (`bun`/`node`). Both are read from `kn-next.config.ts` and
 * can change AFTER an app is scaffolded, while `deploy` builds from a fixed
 * build context. The #1177 increment deliberately kept the standalone template
 * OUT of `templates/app/` (which `kn-next create` walks with no allowlist)
 * precisely so a not-yet-selectable recipe is never emitted into — and never
 * built by — a vinext-default app. So the standalone Dockerfile is STAGED into
 * the build context here, only when the standalone target is selected, leaving
 * the scaffolded vinext app coherent.
 *
 * ADR-0001: this module writes files into the local build context only. It never
 * touches the cluster.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILDERS, DEFAULT_BUILDER_ID } from "../adapters/artifact-contract";
import { packageRoot } from "./create";

/** The Docker build `--target` for each standalone runtime. */
export type StandaloneTarget = "standalone-bun" | "standalone-node";

/** The minimal config surface the selection reads. */
export interface RuntimeImageConfig {
    build?: "turbopack" | "vinext";
    runtime?: "bun" | "node";
}

export interface RuntimeImageSelection {
    /**
     * `app-dockerfile` — the scaffolded vinext `Dockerfile` (single stage).
     * `standalone`      — the staged ADR-0055 standalone template.
     */
    kind: "app-dockerfile" | "standalone";
    /** Absolute path passed to `docker buildx build -f`. */
    dockerfile: string;
    /**
     * The `--target` stage, for the standalone multi-stage Dockerfile. Absent
     * for the single-stage vinext `Dockerfile`.
     */
    target?: StandaloneTarget;
}

/** `<package>/templates/runtime-standalone` — the ADR-0055 image recipe. */
export function runtimeStandaloneTemplateDir(): string {
    return join(packageRoot(), "templates", "runtime-standalone");
}

/**
 * The name the staged standalone Dockerfile takes in the build context. NOT
 * `Dockerfile`: the scaffolded app already carries a vinext `Dockerfile`, and
 * clobbering it would corrupt the app for a subsequent vinext build. A distinct
 * name also lets BuildKit pick up the per-Dockerfile `.dockerignore` below.
 */
export const STANDALONE_DOCKERFILE_NAME = "Dockerfile.standalone";

/**
 * Select the runtime image for a build.
 *
 * vinext (the ADR-0048 default — an absent `build` means vinext) uses the
 * scaffolded single-stage `Dockerfile` and NO `--target`; `config.runtime` is
 * irrelevant there (the compiled binary is the server). The standalone shape
 * (`build: turbopack`) uses the staged multi-stage template with the
 * `--target` matching `config.runtime` (`node` is the runtime default).
 *
 * Selection is keyed off the artifact contract's `emits` shape
 * (`artifact-contract.ts`), NOT off "anything that isn't literally 'vinext'".
 * `config.build` is read from `kn-next.config.ts` at runtime, so it is not
 * TS-checked against `BuilderId` — an unrecognised id (e.g. a future
 * compiled `+exec` builder that emits a shape this module has never staged
 * a recipe for) THROWS here rather than silently building the
 * `.next/standalone` recipe for it. Fail-closed, per cr-1181 finding #3.
 */
export function selectRuntimeImage(
    config: RuntimeImageConfig,
    cwd: string,
): RuntimeImageSelection {
    const build = config.build ?? DEFAULT_BUILDER_ID;
    const builder = BUILDERS.find((b) => b.id === build);
    if (!builder) {
        throw new Error(
            `selectRuntimeImage: unrecognised build id '${build}' — known ` +
                `builders are ${BUILDERS.map((b) => b.id).join(", ")}. Refusing ` +
                "to guess a runtime image recipe for it.",
        );
    }
    if (builder.emits !== "next-standalone") {
        // vinext (emits a nitro output, run in-process) uses the scaffolded
        // single-stage `Dockerfile` — the compiled binary IS the server.
        return { kind: "app-dockerfile", dockerfile: join(cwd, "Dockerfile") };
    }
    // Standalone shape (`next-standalone`). `runtime` defaults to node (config.ts).
    const target: StandaloneTarget =
        config.runtime === "bun" ? "standalone-bun" : "standalone-node";
    return {
        kind: "standalone",
        dockerfile: join(cwd, STANDALONE_DOCKERFILE_NAME),
        target,
    };
}

/**
 * Build the `docker buildx build` argv. Extracted (and shared by `deploy` and
 * `preview`) so the target-selection wiring is unit-testable without docker on
 * PATH. The vinext argv is byte-identical to what these commands ran before
 * ADR-0055; the standalone argv adds exactly one `--target <stage>`.
 */
export function dockerBuildxArgs(opts: {
    taggedRef: string;
    metadataFilePath: string;
    buildContext: string;
    dockerfile: string;
    target?: StandaloneTarget;
}): string[] {
    const argv = [
        "docker",
        "buildx",
        "build",
        "--platform",
        "linux/amd64",
        "-f",
        opts.dockerfile,
    ];
    if (opts.target) {
        argv.push("--target", opts.target);
    }
    argv.push(
        "-t",
        opts.taggedRef,
        "--push",
        "--metadata-file",
        opts.metadataFilePath,
        opts.buildContext,
    );
    return argv;
}

/**
 * The per-Dockerfile `.dockerignore` for the standalone build.
 *
 * BuildKit reads `<dockerfile>.dockerignore` in preference to the context's
 * `.dockerignore`, so this scopes the ignore to the standalone build WITHOUT
 * touching the vinext app's own `.dockerignore` (which excludes `.next` and
 * `node_modules` wholesale — correct for vinext, fatal for standalone).
 *
 * It keeps the standalone COPY closure IN the context (`.next/standalone`,
 * `.next/static`, `public`, `node_modules/@getknext/core`, the staged entry
 * shim) while still excluding secrets and VCS — the same secret-first ordering
 * as the app `.dockerignore`. It does NOT exclude `node_modules` or `.next`
 * wholesale. NOTE this is a safety choice, not a BuildKit limitation: BuildKit
 * CAN re-include a child under an excluded parent via a `!` negation (this
 * module's own test below proves `.next` + `!.next/standalone` re-includes the
 * child) — an earlier version of this comment claimed otherwise, which is
 * false. The reason to still exclude neither wholesale is that a
 * `node_modules` + `!node_modules/@getknext/core` pair here has NOT been
 * proven against a real `docker buildx build` (only against the evaluator
 * below), and a wrong proof would silently drop the COPY source and yield an
 * unbuildable image. Correctness over context size here — trimming to just the
 * needed subtrees is a follow-up, gated on a real buildx proof, not the
 * evaluator alone.
 */
export function standaloneDockerignore(): string {
    return `# knext standalone runtime build context (ADR-0055) — per-Dockerfile ignore.
#
# BuildKit reads this in preference to the app .dockerignore, so it scopes the
# ignore to the standalone build only. It deliberately does NOT exclude
# node_modules or .next wholesale (the app .dockerignore does): the standalone
# image COPYs .next/standalone, .next/static, public and node_modules/@getknext/core
# straight out of the context, and a targeted exclude+re-include pair for those
# has not yet been proven against a real docker buildx build. Secrets and VCS
# are still excluded.

# Secrets and local credentials.
.env
.env.*
!.env.example
*.pem
*.key
*.p12
.npmrc
.netrc
kubeconfig
.kube/

# Version control and CI.
.git
.gitignore
.github
.gitlab-ci.yml

# Build scratch that the standalone image never COPYs.
.next/cache
.output
.vinext
dist
build
*.tsbuildinfo
knext-exec*

# Test, coverage and editor noise.
coverage
.nyc_output
*.log
.DS_Store
.idea
.vscode
*.swp

# Docker's own files.
Dockerfile*
.dockerignore
docker-compose*.yml
`;
}

/**
 * Stage the standalone build context so `docker buildx build` yields a bootable
 * image. Writes, into the build context:
 *
 *   - `<cwd>/Dockerfile.standalone` — the ADR-0055 template, verbatim (it
 *     carries no `{{ }}` mustache; the runtime axis is a `--target`, not a
 *     variable). A leftover placeholder aborts rather than shipping a broken
 *     Dockerfile.
 *   - `<buildContext>/knext-standalone-entry.mjs` — the supervisor shim, at the
 *     context root because the Dockerfile's `COPY knext-standalone-entry.mjs`
 *     resolves against the build CONTEXT, not cwd.
 *   - `<cwd>/Dockerfile.standalone.dockerignore` — the per-Dockerfile ignore
 *     that keeps the standalone closure in the context.
 *
 * The rest of the closure (`.next/standalone`, `.next/static`, `public`,
 * `node_modules/@getknext/core`, and the supervisor's own deps stage) is
 * produced by `next build` / `npm install` and resolved by the Dockerfile's own
 * COPY/deps-stage design (#1177) — this function only guarantees the context
 * has what those COPY lines name.
 */
export function stageStandaloneBuildContext(opts: {
    cwd: string;
    buildContext: string;
    templateDir?: string;
}): { dockerfile: string } {
    const templateDir = opts.templateDir ?? runtimeStandaloneTemplateDir();
    const dockerfileSrc = join(templateDir, "Dockerfile.standalone.hbs");
    const entrySrc = join(templateDir, "knext-standalone-entry.mjs.hbs");
    if (!existsSync(dockerfileSrc) || !existsSync(entrySrc)) {
        throw new Error(
            `standalone runtime image template not found at ${templateDir} — ` +
                "the installed @getknext/core package is missing its " +
                "templates/runtime-standalone/ directory",
        );
    }

    const dockerfileText = readFileSync(dockerfileSrc, "utf8");
    const entryText = readFileSync(entrySrc, "utf8");
    // Neither template carries mustache; assert BOTH halves of the staged
    // context so a future variable is not shipped raw (renderScaffold's own
    // discipline). This used to only cover the Dockerfile — the entry shim
    // was `copyFileSync`'d unchecked (cr-1181 finding #4) — so check it with
    // the same assertion, not a bare copy.
    if (dockerfileText.includes("{{")) {
        throw new Error(
            "Dockerfile.standalone.hbs contains an unsubstituted {{ }} " +
                "placeholder — the standalone image recipe must be literal",
        );
    }
    if (entryText.includes("{{")) {
        throw new Error(
            "knext-standalone-entry.mjs.hbs contains an unsubstituted {{ }} " +
                "placeholder — the standalone supervisor shim must be literal",
        );
    }

    const dockerfile = join(opts.cwd, STANDALONE_DOCKERFILE_NAME);
    writeFileSync(dockerfile, dockerfileText, "utf8");
    writeFileSync(
        join(opts.buildContext, "knext-standalone-entry.mjs"),
        entryText,
        "utf8",
    );
    writeFileSync(
        `${dockerfile}.dockerignore`,
        standaloneDockerignore(),
        "utf8",
    );
    return { dockerfile };
}

/**
 * A minimal `.dockerignore` evaluator: does `content` exclude `path`?
 *
 * Implements the subset of Docker's rules this project relies on — comment/blank
 * lines skipped, `!` negation, last-match-wins, a bare directory pattern
 * excluding everything beneath it, and `*` globbing on a path segment. It exists
 * so the staging guard can assert BEHAVIOUR ("the standalone closure is not
 * excluded") rather than string-matching pattern prose.
 */
export function dockerignoreExcludes(content: string, path: string): boolean {
    let excluded = false;
    for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#")) continue;
        const negate = line.startsWith("!");
        const pattern = (negate ? line.slice(1) : line).replace(/\/+$/, "");
        if (matchesDockerignore(pattern, path)) {
            excluded = !negate;
        }
    }
    return excluded;
}

/** Match one dockerignore pattern against a path (exact, ancestor-dir, or glob). */
function matchesDockerignore(pattern: string, path: string): boolean {
    if (pattern === "") return false;
    if (pattern === path) return true;
    // A directory pattern excludes everything under it.
    if (path.startsWith(`${pattern}/`)) return true;
    if (pattern.includes("*")) {
        // Segment-wise glob: `.env.*` matches `.env.local`, not `.environment`.
        const re = new RegExp(
            `^${pattern
                .split("*")
                .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
                .join("[^/]*")}$`,
        );
        return re.test(path);
    }
    return false;
}
