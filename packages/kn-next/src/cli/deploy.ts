#!/usr/bin/env node
/**
 * kn-next CLI — Knative Next.js Deployment Automation
 *
 * Usage:
 *   npx kn-next deploy [options]
 *
 * ADR-0001: The operator is the single source of truth for cluster state.
 * This CLI's job is strictly: build → push → apply the NextApp CR.
 *
 * What was removed (A1-cli):
 * - kubectl apply of raw Knative Service manifests (was deploy.ts:176)
 * - kubectl apply of infrastructure manifests (was deploy.ts:153)
 * - generateKnativeManifest / generateInfrastructure calls
 *
 * The operator reconciles everything from the NextApp CR.
 */

import { readFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_BUILDER_ID } from "../adapters/artifact-contract";
import type { KnativeNextConfig } from "../config";
import {
    getAssetPrefix,
    hasStorage,
    NO_STORAGE_MODE_NOTICE,
    reclaimBuildPrefix,
    uploadAssets,
    verifyBuiltImageLockstep,
    verifyVinextStaticPrefix,
} from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import {
    assertCompiledArtifactFresh,
    compileArtifactForDeploy,
} from "./build-artifact";
import {
    renderNextAppCR,
    resolveDigest,
    validateCRImageRef,
} from "./cr-builder";
import {
    formatStrayPositional,
    formatUnknownCommand,
    resolveInvocation,
} from "./dispatch";
import { isEntrypoint, runCapture, runInherit } from "./exec";
import { runAssetGC } from "./gc";
import { CLI_HELP } from "./help";
import { assertNoPlaceholders } from "./placeholder-preflight";
import { runProjectBuild } from "./project-build";
import {
    dockerBuildxArgs,
    isKnownGoodTemplateDockerfile,
    selectRuntimeImage,
    stageStandaloneBuildContext,
} from "./runtime-image";
import { captureKubectl } from "./schema/kubectl-capture";
import {
    formatPreflightFailure,
    preflightCRSchema,
    preflightImageRef,
} from "./schema/preflight";
import {
    handleConfigNotFound,
    handleUsageError,
    loadConfig,
    resolveKubeContext,
    UsageError,
    withKubeContext,
} from "./shared";
import { requireBuildContext } from "./tracing-root";

const log = createLogger({ module: "deploy" });

interface DeployOptions {
    registry?: string;
    bucket?: string;
    tag?: string;
    namespace: string;
    /** kubectl context to target (#978); undefined ⇒ ambient current-context. */
    context?: string;
    skipBuild: boolean;
    skipUpload: boolean;
    /**
     * #1283: opt out of the post-build image lock-step check
     * (`verifyBuiltImageLockstep`) for an app-dockerfile recipe whose layout
     * does not match either shipped convention (`/app/server` or
     * `/app/.output/server/index.mjs`) — the check would otherwise fail
     * closed on EVERY deploy with `asset-prefix-not-embedded`, for a layout
     * reason rather than a real lock-step break. Documented risk: skipping it
     * means the CLI can no longer catch a broken ASSET_PREFIX/
     * NEXT_DEPLOYMENT_ID lock-step before the cluster write.
     */
    skipImageLockstepCheck: boolean;
    dryRun: boolean;
    /**
     * #1063: a pre-built, digest-pinned image ref to deploy AS-IS. When set the
     * CLI SKIPS `docker buildx build … --push` (and the post-push digest
     * resolution) entirely and applies the NextApp CR pointing at this image —
     * the path for a user who already has a digest-pinned image or has no
     * working buildx. Must contain `@sha256:` (the operator's admission webhook
     * rejects a tag-only ref). IMPLIES `--skip-build` AND `--skip-upload`: the
     * image is the source of truth for both its server and its baked static
     * assets, so re-building/uploading under a fresh BUILD_ID would 404 at
     * runtime (ADR-0011 lock-step). See the fail-fast block in `deploy()`.
     */
    image?: string;
}

/**
 * Synchronously write to stdout (fd 1). Unlike process.stdout.write (async on a
 * pipe) this is guaranteed flushed before process.exit(), so `--help`/`--version`
 * output is never truncated when the bin's stdout is a pipe (issue #68).
 */
function writeStdoutSync(text: string): void {
    writeSync(1, text);
}

/**
 * Reads the CLI version from the package manifest. Works from both the source
 * layout (src/cli/deploy.ts) and the bundled layout (dist/cli/kn-next.js) —
 * package.json sits two directories up in both cases.
 */
function getCliVersion(): string {
    try {
        const here = fileURLToPath(import.meta.url);
        const pkgPath = resolve(here, "..", "..", "..", "package.json");
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
            version?: string;
        };
        return pkg.version ?? "0.0.0";
    } catch {
        return "0.0.0";
    }
}

function parseCliArgs(): DeployOptions {
    let values: {
        registry?: string;
        bucket?: string;
        tag?: string;
        namespace?: string;
        context?: string;
        "skip-build"?: boolean;
        "skip-upload"?: boolean;
        "skip-image-lockstep-check"?: boolean;
        "dry-run"?: boolean;
        image?: string;
        help?: boolean;
        version?: boolean;
    };
    let positionals: string[];
    try {
        ({ values, positionals } = parseArgs({
            options: {
                registry: { type: "string", short: "r" },
                bucket: { type: "string", short: "b" },
                tag: { type: "string", short: "t" },
                namespace: { type: "string", short: "n", default: "default" },
                context: { type: "string" },
                "skip-build": { type: "boolean", default: false },
                "skip-upload": { type: "boolean", default: false },
                "skip-image-lockstep-check": {
                    type: "boolean",
                    default: false,
                },
                "dry-run": { type: "boolean", default: false },
                image: { type: "string" },
                help: { type: "boolean", short: "h", default: false },
                version: { type: "boolean", short: "v", default: false },
            },
            strict: true,
            allowPositionals: true,
        }));
    } catch (err) {
        // Node's own parse failure (`ERR_PARSE_ARGS_UNKNOWN_OPTION`) is still a
        // user typo — `kn-next --skip-buildd` — so it gets the same message
        // treatment as ours instead of a serialised Error with a stack.
        // `create.ts` already did this; the deploy path did not.
        throw new UsageError(`${(err as Error).message} (see kn-next --help)`);
    }

    if (values.version) {
        // Resolve version from the package manifest without bundling it inline,
        // so the published version is always the source of truth.
        writeStdoutSync(`${getCliVersion()}\n`);
        process.exit(0);
    }

    if (values.help) {
        // Write help synchronously to fd 1 — NOT via the async pino-pretty
        // transport (flushed after process.exit, swallowing output) and NOT via
        // process.stdout.write (async on a pipe, truncated by process.exit).
        // fs.writeSync(1, …) is guaranteed flushed before exit, so `npx kn-next
        // --help | cat` works under plain node (issue #68).
        writeStdoutSync(CLI_HELP);
        process.exit(0);
    }

    // ADR-0046: reject a stray positional on the default deploy path.
    //
    // `resolveInvocation` only guards the FIRST token, so before this check
    // `kn-next deploy cleanup`, `kn-next --namespace prod cleanup` and
    // `kn-next -- cleanup` all ran a DEPLOY with the verb silently swallowed —
    // "deploy to prod" when the user typed a teardown. The leading explicit
    // `deploy` is the one positional this path legitimately sees (the bin's
    // dispatcher resolved it and fell through to here); everything after it is
    // a mistake. Help/version are handled above, so `kn-next --help extra`
    // still prints help rather than this error — deliberate: help is never an
    // error, and nothing destructive follows it.
    const stray = (
        positionals[0] === "deploy" ? positionals.slice(1) : positionals
    )[0];
    if (stray !== undefined) {
        writeSync(2, formatStrayPositional(stray));
        process.exit(1);
    }

    return {
        registry: values.registry || process.env.KN_REGISTRY,
        bucket: values.bucket || process.env.KN_BUCKET,
        tag: values.tag || process.env.KN_IMAGE_TAG,
        namespace: values.namespace || process.env.KN_NAMESPACE || "default",
        context: resolveKubeContext(values.context),
        skipBuild: values["skip-build"] ?? false,
        skipUpload: values["skip-upload"] ?? false,
        skipImageLockstepCheck: values["skip-image-lockstep-check"] ?? false,
        dryRun: values["dry-run"] ?? false,
        image: values.image || process.env.KN_IMAGE,
    };
}

function applyOverrides(
    config: KnativeNextConfig,
    options: DeployOptions,
): KnativeNextConfig {
    const overridden = { ...config };

    if (options.registry) {
        overridden.registry = options.registry;
    }
    if (options.bucket) {
        if (!overridden.storage) {
            // ADR-0047: absence is a deliberate mode; silently inventing a
            // partial storage block from a flag would deploy a config the
            // validator never saw. Say what is happening instead.
            throw new UsageError(
                "--bucket overrides storage.bucket, but kn-next.config.ts has " +
                    "no `storage` block (static assets are served from the " +
                    "image). Add a full storage block to the config before " +
                    "overriding its bucket.",
            );
        }
        overridden.storage = { ...overridden.storage, bucket: options.bucket };
    }

    if (process.env.KN_REDIS_URL && overridden.cache?.provider === "redis") {
        overridden.cache = {
            ...overridden.cache,
            url: process.env.KN_REDIS_URL,
        };
    }

    return overridden;
}

/**
 * Read the LOCAL kubectl client version, or undefined if it cannot be read.
 * Read-only and local (never touches the apiserver); reuses doctor's parser and
 * threshold instead of restating them. Dynamically imported because doctor is a
 * bin-dispatched module (see the self-entry hazard note at the bottom of this
 * file) and this runs only on a failure path.
 */
async function localKubectlTooOldForStrict(): Promise<string | undefined> {
    try {
        const { parseKubectlClientVersion, supportsStrictValidation } =
            await import("./doctor");
        const parsed = parseKubectlClientVersion(
            runCapture(["kubectl", "version", "--client", "-o", "json"]),
        );
        if (!parsed || supportsStrictValidation(parsed)) return undefined;
        return parsed.display;
    } catch {
        // A probe that cannot run must not replace the real error.
        return undefined;
    }
}

/**
 * Diagnose a failed `kubectl apply` of the NextApp CR.
 *
 * The apply runs under `runInherit`, which INHERITS stdio — kubectl's stderr
 * has already streamed to the terminal and knext never sees it, so it cannot
 * classify the failure from the text (doctor's `classifyKubectlFailure` needs
 * stderr). Exactly one cause is establishable locally, and it is the one the
 * strict flag itself introduces: before kubectl 1.25 `--validate` is a BOOLEAN,
 * so `--validate=strict` fails at flag PARSING and the apply never reaches the
 * apiserver — reporting "the CRD is older than this CLI" there is backwards
 * (the CLIENT is the old part). Probe the client; when it is not the cause,
 * offer a differential and name no single one.
 */
async function describeFailedCRApply(): Promise<string> {
    const oldClient = await localKubectlTooOldForStrict();
    if (oldClient) {
        return (
            `kubectl apply of the NextApp CR FAILED, and your kubectl client (${oldClient}) is ` +
            "older than v1.25.\n" +
            "Before v1.25 `--validate` is a BOOLEAN flag, so the `--validate=strict` that " +
            "kn-next passes is rejected at flag parsing and the apply never reached the " +
            "cluster — nothing was applied and nothing was changed. This is deliberate " +
            "(fail-closed): on that client knext cannot guarantee an unknown CR field is " +
            "rejected rather than silently pruned.\n" +
            "Fix: upgrade kubectl to >= v1.25 (v1.24 is long EOL), then re-run.\n" +
            "  kubectl version --client\n" +
            "  kn-next doctor"
        );
    }
    return (
        "kubectl apply of the NextApp CR FAILED (kubectl's own error is printed above; " +
        "knext inherits its stdio and cannot read it, so it will not guess at the cause).\n" +
        'If it reads `strict decoding error: unknown field "spec…"`, the installed NextApp ' +
        "CRD is older than this CLI and does not know that field — the apply was REJECTED " +
        "(deliberately: kn-next applies with --validate=strict) rather than the field being " +
        "silently pruned. Upgrade the operator bundle to match this CLI:\n" +
        "  kubectl get crd nextapps.apps.kn-next.dev -o jsonpath='{.spec.versions[*].name}'\n" +
        "  kubectl -n kn-next-operator-system get deploy -o wide   # operator image\n" +
        'Anything else — connection refused, Unauthorized, (Forbidden), `namespaces "x" not ' +
        "found`, a YAML parse error — is an ordinary apply failure with the cause kubectl " +
        "printed; it is not a field-validation problem.\n" +
        "  kn-next doctor"
    );
}

/**
 * #314 (T6) PRUNE PREFLIGHT — the FIRST cluster-touching step of a deploy, and
 * it runs before `next build`, before `uploadAssets` and before the push.
 *
 * WHY THE ORDER IS PART OF THE FIX. Before this, `uploadAssets` ran at
 * deploy.ts:332 and the CR apply at :500 — so since #547 a skew-affected apply
 * hard-failed AFTER the assets were already in the bucket, orphaning
 * `_next/static/<build-id>/` for a build that never became a revision. GC
 * reclaims it, so this was waste rather than corruption, but the user's first
 * experience of the new hard failure was "it failed *and* it wrote things."
 *
 * WHY IT COSTS NO NEW PERMISSION (docs/SPRINT_2.md D-3). The verdict is a
 * server-side `--dry-run=server --validate=strict` apply, which needs
 * `create`/`patch` on `nextapps` in the target namespace — precisely what the
 * real apply below needs. No kubeconfig can deploy but not preflight, so
 * failing hard here can only fail a deploy that was going to fail anyway. The
 * schema READS (OpenAPI v3, then the CRD) are diagnosis only: they name the
 * field, and their failure degrades the message, never the verdict.
 *
 * The preflight CR differs from the applied CR in exactly one value — the image
 * ref, which cannot exist before the push (see `preflightImageRef`). The
 * apiserver validates the FIELD SET, which is identical.
 */
async function runPrunePreflight(
    config: KnativeNextConfig,
    namespace: string,
    buildId: string,
    context?: string,
): Promise<void> {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const crPath = join(process.cwd(), ".output", "nextapp-preflight-cr.yaml");
    mkdirSync(join(process.cwd(), ".output"), { recursive: true });
    writeFileSync(
        crPath,
        renderNextAppCR(
            config,
            preflightImageRef(`${config.registry}/${config.name}:preflight`),
            namespace,
            buildId,
        ),
        "utf-8",
    );

    const outcome = preflightCRSchema(
        // #978: bind the target context into the kubectl boundary so the
        // server-side dry-run apply and the schema reads hit the cluster the
        // user named, not the ambient current-context.
        { kubectl: (argv) => captureKubectl(withKubeContext(argv, context)) },
        { crPath, namespace },
    );
    if (outcome.verdict === "ok") {
        log.info(
            { namespace },
            "CR schema preflight passed — this cluster stores every field this CLI emits",
        );
        return;
    }
    // A kubectl too old for `--validate=strict` fails at flag parsing; probe it
    // so the message blames the CLIENT rather than the CRD (that would be
    // exactly backwards, and the probe is the only cause knext can establish).
    const oldClient =
        outcome.reason === "client-too-old"
            ? await localKubectlTooOldForStrict()
            : undefined;
    throw new Error(formatPreflightFailure(outcome, { oldClient }));
}

/**
 * The deploy orchestrator: build → upload assets → push image → apply the
 * NextApp CR (ADR-0001: operator is the single source of truth). Exported at
 * the MODULE level (not a package `exports` subpath) so the sibling
 * deploy-orchestrator.test.ts can pin its failure/skip/skew branches
 * hermetically against mocked seams. It is invoked by the entry dispatcher
 * below when run as the `kn-next`/`kn-next deploy` bin.
 */
export async function deploy() {
    const options = parseCliArgs();

    // Load config with validation FIRST, then announce. Announcing first meant
    // a user in a directory with no kn-next.config.ts saw "kn-next deploy"
    // printed after the "there is no config here" guidance (pino's transport is
    // async, so the banner lands last) — a confusing tail on an otherwise clean
    // message (UX ledger 1b).
    const baseConfig = await loadConfig();

    log.info({ dryRun: options.dryRun }, "kn-next deploy");

    // #1283 round 3: announce the opt-out at warn on every deploy that uses
    // it — same discipline as ADR-0047's NO_STORAGE_MODE_NOTICE — so skipping
    // the lock-step check is never silent.
    if (options.skipImageLockstepCheck) {
        log.warn(
            "--skip-image-lockstep-check: skipping the post-build ASSET_PREFIX/" +
                "build-id lock-step check against the pushed image. If this " +
                "deploy's Dockerfile rebuilds in-image and the lock-step is " +
                "actually broken (ADR-0011 — skew protection, asset GC), this " +
                "deploy will NOT catch it before the cluster write.",
        );
    }

    const config = applyOverrides(baseConfig, options);

    // UX ledger row 4 (4b): fail fast on `<...>` placeholder values BEFORE any
    // build step, upload, or cluster access — the scaffold's `ghcr.io/<your-user>`
    // used to flow silently into a multi-minute `next build` and die at the
    // image push. Scanned on the EFFECTIVE config: a --registry override
    // legitimately rescues a placeholder file, and a placeholder typed AS the
    // override is still caught. Throws through the UsageError family, so the
    // dispatcher renders it as a plain message, never a FATAL dump.
    assertNoPlaceholders(config);

    // #1063: a pre-built image is the SOURCE OF TRUTH for both the server and
    // the static assets baked into it. Its server serves `_next/static/<baked
    // BUILD_ID>/`, and knext cannot know that baked id from outside the image.
    // Re-running `next build` + `uploadAssets` under a FRESH build id
    // (`--tag` or `${Date.now()}`) would upload assets to
    // `_next/static/<new-id>/` — a prefix the deployed server never references
    // — so every static request 404s at runtime with no error at deploy time.
    // `NEXT_DEPLOYMENT_ID` cannot move the baked prefix. So `--image` IMPLIES
    // `--skip-build` AND `--skip-upload`: the image self-serves its assets, and
    // the build/upload/GC asset path (which exists to keep upload-prefix ==
    // served-prefix == deploy tag, ADR-0011) is turned off wholesale rather
    // than run with a guaranteed-mismatched id. Validated here (fail-fast,
    // before `next build`), mirroring the operator's admission webhook — a
    // tag-only ref throws with an `@sha256:` message.
    if (options.image) {
        validateCRImageRef(options.image);
        if (options.registry) {
            log.warn(
                { registry: options.registry, image: options.image },
                "Ignoring --registry: --image is a fully-qualified, digest-pinned " +
                    "ref, so nothing is built or pushed and the registry override " +
                    "has no effect.",
            );
        }
        options.skipBuild = true;
        options.skipUpload = true;
        log.info(
            { image: options.image },
            "Deploying a pre-built image (--image) — skipping next build, docker " +
                "build/push and asset upload; the image self-serves its baked " +
                "static assets (ADR-0011 build-id lock-step).",
        );
    }

    if (!hasStorage(config)) {
        // ADR-0047 condition 1: announce the image-served static mode at info
        // on EVERY deploy (dry-run included) — a dropped or mistyped `storage`
        // block must never look identical to a deliberate choice.
        log.info(NO_STORAGE_MODE_NOTICE);
        // An ASSET_PREFIX inherited from the environment would bake bucket
        // URLs into HTML that nothing uploads to. The mode's guarantee is
        // relative asset paths, so clear it before `next build` reads it.
        delete process.env.ASSET_PREFIX;
    }

    // #93 skew protection (ADR-0011): pin this deploy's BUILD_ID. We export
    // NEXT_DEPLOYMENT_ID = the deploy tag BEFORE `next build`. next.config reads it
    // BOTH as `deploymentId` (Next appends `?dpl=<id>` to asset/RSC requests) AND,
    // crucially (defect-A fix), as `generateBuildId: () => NEXT_DEPLOYMENT_ID` so
    // `.next/BUILD_ID` == this tag — otherwise BUILD_ID would be a random nanoid
    // and the `_next/static/<id>/` upload prefix would NOT match the tag the GC
    // prunes by. Reusing the image tag keeps build-id, image, and static prefix in
    // lock-step. MUST be set BEFORE `next build`.
    const buildId = options.tag || `${Date.now()}`;
    process.env.NEXT_DEPLOYMENT_ID = buildId;

    // T2d: the deploy's id wins over a colliding `env.NEXT_DEPLOYMENT_ID` in
    // the user's config (it is a fact about the artifact, not a preference) —
    // but never silently, because the user wrote it expecting it to take.
    if (
        config.env?.NEXT_DEPLOYMENT_ID !== undefined &&
        config.env.NEXT_DEPLOYMENT_ID !== buildId
    ) {
        log.warn(
            { configured: config.env.NEXT_DEPLOYMENT_ID, buildId },
            "Ignoring env.NEXT_DEPLOYMENT_ID from kn-next.config: this deploy's " +
                "build id is the authority (it is what the assets are namespaced " +
                "under and what the operator stamps on the revision). Remove it " +
                "from the config, or set the deploy --tag instead.",
        );
    }

    // The resolved build target (#1183/ADR-0058: an absent `build` means
    // turbopack — the standalone shape — since v1.0; ADR-0048 originally made
    // it vinext). Resolved once here because the lock-step guard below reads
    // a DIFFERENT artifact per target — `.next/BUILD_ID` for standalone, the
    // `.output/public/_next/static/<id>/` prefix for vinext.
    const resolvedBuild = config.build ?? DEFAULT_BUILDER_ID;

    // #644: resolve the Docker build context HERE, in the same before-any-side-
    // effect phase as the prune preflight. "Which directory does Next trace
    // from?" is answerable at t=0 from the filesystem — deferring it into the
    // docker task meant a user with no lockfile paid for a full `next build`,
    // and on --skip-build the asset upload had already started, leaving the
    // orphaned `_next/static/<id>/` prefix T6 exists to avoid. Purely local: no
    // cluster call, so a dry run resolves it too (and thus reports it).
    const buildContext = requireBuildContext(process.cwd());

    // #314 (T6): the prune preflight, BEFORE any side effect (see the block
    // comment on runPrunePreflight). A dry run makes no cluster calls at all.
    if (!options.dryRun) {
        await runPrunePreflight(
            config,
            options.namespace,
            buildId,
            options.context,
        );
    }

    if (!options.skipBuild) {
        if (hasStorage(config)) {
            const assetPrefix = getAssetPrefix(config);
            process.env.ASSET_PREFIX = assetPrefix;
            log.info(
                { assetPrefix, buildId },
                "Running next build (output:standalone)...",
            );
        } else {
            log.info(
                { buildId },
                "Running next build (output:standalone; assets served from the image — no assetPrefix)...",
            );
        }
        // UX ledger row 4 (4c): the seam translates a deps-not-installed failure
        // (`next: command not found`, exit 127) into plain npm-install guidance.
        // requireEsm gates the vinext ESM preflight (vinext target only).
        // Reads `resolvedBuild`, not a hardcoded fallback — an absent `build`
        // no longer means vinext (#1183, DEFAULT_BUILDER_ID is "turbopack").
        runProjectBuild({
            requireEsm: resolvedBuild === "vinext",
        });
        log.info(
            "Next.js build complete — standalone output in .next/standalone/",
        );

        // Defect-A guard, STANDALONE leg: fail LOUDLY if `.next/BUILD_ID` is not
        // the deploy tag. `_next/static/<BUILD_ID>/` is the upload prefix the GC
        // prunes by; if Next ever ignores `generateBuildId` and falls back to a
        // random nanoid, the GC would silently match nothing and the
        // "just-deployed build is protected" guarantee would break. Better to
        // abort the deploy than ship that.
        //
        // The ENOENT-warn-skip below is scoped to THIS leg on purpose: a
        // turbopack app that writes no BUILD_ID is a shape we do not control.
        // The vinext leg — which NEVER writes this file, so it warn-skipped on
        // every single deploy — is checked separately, and loudly, below.
        if (resolvedBuild !== "vinext") {
            try {
                const builtId = readFileSync(
                    join(process.cwd(), ".next", "BUILD_ID"),
                    "utf-8",
                ).trim();
                if (builtId !== buildId) {
                    throw new Error(
                        `.next/BUILD_ID "${builtId}" != deploy tag "${buildId}". ` +
                            "Skew-protection asset retention requires BUILD_ID == NEXT_DEPLOYMENT_ID " +
                            "(check next.config generateBuildId).",
                    );
                }
            } catch (err) {
                // Only swallow a missing-file error (e.g. an app that does not write it);
                // a real mismatch above must propagate and fail the deploy.
                const code = (err as NodeJS.ErrnoException)?.code;
                if (code !== "ENOENT") throw err;
                log.warn(
                    ".next/BUILD_ID not found — skipping build-id lock-step check",
                );
            }
        }

        // #1339 review finding #1 (jev 0.90, BLOCKER): the staged Dockerfile
        // for the standalone-bun target (the DEFAULT since #1183) and for
        // vinext both do an UNCONDITIONAL `COPY` of a compiled executable
        // that only `kn-next build` used to produce — `deploy` ran the
        // project build above and stopped there, so its docker build either
        // failed the COPY (no such file) or ran a STALE binary left over
        // from an earlier `kn-next build` in this checkout. Shares the EXACT
        // compile step `kn-next build` uses (build-artifact.ts). Runs here,
        // UNCONDITIONALLY, only on the fresh-build leg — never gated on
        // "does a binary already exist" — so it always recompiles from the
        // tree the project build just produced and staleness cannot occur on
        // THIS path by construction. The `--skip-build` leg below instead
        // fails closed via `assertCompiledArtifactFresh`, since nothing
        // rebuilds anything there.
        compileArtifactForDeploy(config, process.cwd());
    } else {
        // `--skip-build`: nothing above ran, so nothing recompiled the exec
        // either. Fail closed rather than silently shipping whatever happens
        // to be sitting in the checkout — missing or stale, both loud.
        assertCompiledArtifactFresh(config, process.cwd());
    }

    // T2a — the SAME lock-step guarantee on the vinext leg, where the built id
    // is the static namespace `.output/public/_next/static/<id>/` rather than a
    // `.next/BUILD_ID` file. Three things make this its own block:
    //
    //  - It has NO skip path. vinext writes no BUILD_ID, so the standalone
    //    guard above hit ENOENT and warn-skipped on EVERY vinext deploy — a
    //    control reporting success while inert, in the exact place ADR-0011's
    //    guarantee lives.
    //  - It runs even under `--skip-build`. That is the case that silently
    //    orphans assets today: a `.output` built under an EARLIER tag gets
    //    uploaded under that earlier prefix, which the GC then reaps out from
    //    under the revision this deploy is about to create.
    //  - It asks the SAME question the #892 marker write asks
    //    (`verifyVinextStaticPrefix`), so marker key ≡ protection key ≡ image
    //    tag ≡ CR spec.buildId is true by construction, not by two call sites
    //    happening to agree.
    //
    // SCOPED TO DEPLOYS THAT ACTUALLY UPLOAD (review round 2). What this
    // protects is the correspondence between the uploaded asset PREFIX and the
    // key the GC resolves from a revision label. In ADR-0047's no-storage mode
    // nothing is uploaded, there are no remote prefixes, and the GC never runs
    // — so there is no correspondence to break, and aborting a deploy over the
    // NAME of a directory inside the image would be a hard failure protecting
    // nothing. Same for `--skip-upload`. This is a scope, not a skip: wherever
    // the subject exists, every branch below aborts.
    const uploadsAssets = hasStorage(config) && !options.skipUpload;
    if (resolvedBuild === "vinext" && uploadsAssets) {
        const prefix = verifyVinextStaticPrefix(process.cwd(), buildId);
        if (!prefix.ok) {
            const found = prefix.siblings.length
                ? `found: ${prefix.siblings.join(", ")}`
                : "the directory is empty";
            // Just the varying diagnostic — the fixed sentence stays INSIDE
            // each throw below, so `cli-dispatch-contract`'s allowlist can
            // anchor on message TEXT rather than on the variable name. An
            // anchor naming the variable would pre-legitimise any future plain
            // throw in this file that reused it.
            const detail =
                `.output/public/_next/static/${buildId}/ does not exist ` +
                `(${prefix.reason}; ${found})`;
            // With --skip-build this is a user mistake with a one-word fix, so
            // it renders as a message rather than a FATAL stack dump: the
            // build that produced `.output` ran under a different tag, and
            // dropping the flag rebuilds it under this one.
            if (options.skipBuild) {
                throw new UsageError(
                    `${detail}. Skew-protection asset retention requires the ` +
                        "static prefix to BE the deploy tag. You passed " +
                        "--skip-build, so .output is whatever an earlier build " +
                        "left behind — drop --skip-build to rebuild it under " +
                        `"${buildId}", or deploy with the tag that .output was ` +
                        "built under.",
                );
            }
            throw new Error(
                `${detail}. Skew-protection asset retention requires the ` +
                    "static prefix to BE the deploy tag — check next.config " +
                    "`generateBuildId: () => process.env.NEXT_DEPLOYMENT_ID " +
                    "|| null`.",
            );
        }
    }

    const imageTag = buildId;
    // taggedRef is the mutable push target — used for docker build/push only.
    // The operator-facing CR image ref MUST be digest-pinned (see resolveDigest below).
    const taggedRef = `${config.registry}/${config.name}:${imageTag}`;

    // #1063: with `--image` the CR points at the pre-built, already-validated
    // digest-pinned ref (see the fail-fast block above, where --image also
    // forced skip-build + skip-upload). Otherwise imageRef starts as taggedRef
    // for dry-run and is replaced with the @sha256:-pinned ref after a real
    // push (below).
    let imageRef: string;
    if (options.image) {
        imageRef = options.image;
    } else {
        log.info(
            { image: taggedRef },
            "Image tag resolved (will be digest-pinned after push)",
        );
        imageRef = taggedRef;
    }

    if (!options.dryRun) {
        const tasks: Promise<void>[] = [];

        // v6-P2 (ADR-0011): track whether the asset upload actually COMPLETED,
        // so that if the concurrent docker push rejects we can tell the
        // upload-succeeded-then-push-failed leg (orphaned _next/static/<id>/
        // prefix to reclaim) from an upload-failed leg (nothing uploaded).
        let uploadSucceeded = false;
        let uploadPromise: Promise<void> | undefined;

        if (!options.skipUpload && hasStorage(config)) {
            log.info("Running parallel tasks: asset upload + Docker build");
            uploadPromise = (async () => {
                // The build id is PASSED, not rediscovered: it is what the
                // `.knext-build` marker is keyed on, and the staging code
                // re-verifies the prefix before writing it (#892).
                await uploadAssets(config, buildId);
                uploadSucceeded = true;
                log.info("Assets uploaded");
            })();
            tasks.push(uploadPromise);
        }

        // Write buildx metadata to a temp file so resolveDigest can read
        // containerimage.digest directly — no extra docker inspect round-trip.
        const metadataFilePath = join(
            process.cwd(),
            ".output",
            "buildx-metadata.json",
        );

        // #1063: with --image there is nothing to build or push; the CR already
        // points at the pre-built digest-pinned ref. The asset upload above is
        // orthogonal and still runs unless --skip-upload was passed.
        if (!options.image) {
            log.info("Building & pushing Docker image");
            tasks.push(
                (async () => {
                    // #644: `buildContext` was resolved in the preflight above —
                    // Next's file-tracing root, NOT a fixed `../..`. That hardcode
                    // assumed an `apps/<name>` layout and pointed outside the
                    // project for a flat repo, which is what `kn-next create`
                    // produces. Nothing is inferred at this point.
                    const repoRoot = buildContext;
                    // ADR-0055: select the runtime image by (build, runtime). The
                    // vinext shape uses the scaffolded single-stage Dockerfile
                    // (argv unchanged); the standalone shape (the default since
                    // #1183) stages the ADR-0055 multi-stage template into the
                    // context and picks a `--target`.
                    const selection = selectRuntimeImage(config, process.cwd());
                    if (selection.kind === "standalone") {
                        stageStandaloneBuildContext({
                            cwd: process.cwd(),
                            buildContext: repoRoot,
                        });
                        log.info(
                            { target: selection.target },
                            "Staged the standalone runtime image (ADR-0055)",
                        );
                    }
                    // --metadata-file writes the buildx result JSON (includes containerimage.digest).
                    // ARGV array, no shell — taggedRef etc. arrive as single tokens.
                    runInherit(
                        dockerBuildxArgs({
                            taggedRef,
                            metadataFilePath,
                            buildContext: repoRoot,
                            dockerfile: selection.dockerfile,
                            target: selection.target,
                            healthCheckPath: config.healthCheckPath,
                            bakesCompileCache: selection.bakesCompileCache,
                            // #1283: app-dockerfile (in-image-build) recipes
                            // never see the host env's NEXT_DEPLOYMENT_ID /
                            // ASSET_PREFIX — pass them as build-args.
                            // `dockerBuildxArgs` itself scopes both to
                            // `!target` (app-dockerfile), so passing them
                            // unconditionally here is a no-op for standalone.
                            buildId,
                            assetPrefix: hasStorage(config)
                                ? getAssetPrefix(config)
                                : undefined,
                        }),
                    );
                    log.info("Docker image built and pushed");

                    // #1283: prove the lock-step against the ACTUAL pushed
                    // image, not the Dockerfile's source text — a Dockerfile
                    // can declare `ARG NEXT_DEPLOYMENT_ID`/`ARG ASSET_PREFIX`
                    // and still never pass them into its build step. Scoped
                    // (round 2, review): app-dockerfile + vinext + uploads —
                    // AND NOT a byte-identical, unmodified copy of a shipped
                    // template. The scaffolded `Dockerfile`/
                    // `Dockerfile.vinext-node` `COPY` host-built artifacts —
                    // the host build already had both env vars before either
                    // compiled or was copied, so there is nothing here for
                    // this check to catch on an unmodified template, and
                    // paying a `docker cp` on every such deploy (this ran on
                    // EVERY vinext+storage deploy in round 1, file-manager
                    // included, and reds — see the guard's own doc comment in
                    // asset-upload.ts) would be pure overhead.
                    // `--skip-image-lockstep-check` is the documented escape
                    // for a custom Dockerfile whose server layout does not
                    // match either shipped convention.
                    if (
                        selection.kind === "app-dockerfile" &&
                        resolvedBuild === "vinext" &&
                        uploadsAssets &&
                        !options.skipImageLockstepCheck &&
                        !isKnownGoodTemplateDockerfile(selection.dockerfile)
                    ) {
                        const imageCheck = verifyBuiltImageLockstep({
                            taggedRef,
                            expectedId: buildId,
                            assetPrefix: hasStorage(config)
                                ? getAssetPrefix(config)
                                : undefined,
                        });
                        if (!imageCheck.ok) {
                            const detail =
                                imageCheck.reason ===
                                "asset-prefix-not-embedded"
                                    ? "the pushed image's server artifact " +
                                      "(app/server, or app/.output/server/index.mjs) " +
                                      "does not reference the configured " +
                                      "ASSET_PREFIX — the Dockerfile did not pass " +
                                      "the build-arg into its build step, or this " +
                                      "Dockerfile's server layout does not match " +
                                      "either shipped convention (pass " +
                                      "--skip-image-lockstep-check if the latter)"
                                    : imageCheck.reason ===
                                        "image-extract-failed"
                                      ? "could not extract /app from the pushed " +
                                        "image (docker create/cp failed) — the " +
                                        "image may not be pushed/pullable, or " +
                                        "docker create needs linux/amd64 support"
                                      : `the pushed image's static namespace does ` +
                                        `not match this deploy's tag "${buildId}" ` +
                                        `(${imageCheck.reason}${
                                            imageCheck.reason ===
                                                "prefix-missing" &&
                                            imageCheck.siblings.length
                                                ? `; found: ${imageCheck.siblings.join(", ")}`
                                                : ""
                                        })`;
                            throw new Error(
                                `In-image build lock-step check failed: ${detail}. ` +
                                    "The Dockerfile must declare `ARG NEXT_DEPLOYMENT_ID` " +
                                    "/ `ARG ASSET_PREFIX` and pass both into its build " +
                                    "step's env (see apps/file-manager/Dockerfile for a " +
                                    "worked example) — ADR-0011's build-id lock-step " +
                                    "(skew protection, asset GC) requires the image's " +
                                    "baked static prefix to BE the deploy tag.",
                            );
                        }
                    }
                })(),
            );
        }

        try {
            await Promise.all(tasks);
        } catch (err) {
            // Partial-failure atomicity (v6-P2, ADR-0011). Promise.all rejects
            // on the FIRST failure (correctly: the CR apply below is never
            // reached — no partial deploy, ADR-0001 preserved). But if the
            // upload already SUCCEEDED and the push is what failed, its
            // _next/static/<buildId>/ prefix is now orphaned. Confirm the leg by
            // awaiting the upload's settlement (not the fast-fail race), then
            // reclaim EXACTLY this run's own unique prefix.
            //
            // Best-effort + LOUD: the reclaim must NEVER mask the original push
            // failure — we log the cleanup outcome, then RETHROW the original
            // error so the deploy still fails loudly (non-zero) and the CR apply
            // is never reached. We do NOT call runAssetGC / pruneOldBuilds here:
            // those classify the FULL remote build set and, on a failure path
            // with no traffic to consult, could reap a concurrently-deploying
            // build's not-yet-live assets — an ADR-0011
            // over-keep-never-over-delete violation. reclaimBuildPrefix targets
            // only this run's unique BUILD_ID (== NEXT_DEPLOYMENT_ID == the
            // deploy tag, per the skew-guard lock-step), which — because this
            // deploy aborts before apply — can never be a live/pinned build or a
            // concurrent deploy's id. (Symmetric leg — upload rejects, push
            // succeeds — leaves an orphaned image TAG: registry GC's authority,
            // OUT OF SCOPE here.)
            if (!options.skipUpload && uploadPromise && hasStorage(config)) {
                try {
                    await uploadPromise;
                } catch {
                    // Upload itself failed → nothing was uploaded to reclaim.
                }
                if (uploadSucceeded) {
                    try {
                        reclaimBuildPrefix(config, buildId);
                    } catch (cleanupErr) {
                        log.warn(
                            { cleanupErr },
                            "Orphan asset-prefix reclaim failed (non-fatal) — " +
                                "the deploy still fails on the original error below",
                        );
                    }
                }
            }
            throw err;
        }

        // Resolve the real content-digest after push so the CR image ref is pinned.
        // PRIMARY: read containerimage.digest from the buildx metadata file (no extra I/O).
        // FALLBACK: docker inspect --format '{{index .RepoDigests 0}}' (if metadata missing).
        // The operator's validateImageRef rejects any ref without @sha256:.
        //
        // #1063: skipped for --image — the pre-built ref was already validated
        // as digest-pinned above and nothing was pushed to resolve a digest for.
        if (!options.image) {
            log.info({ taggedRef }, "Resolving @sha256: digest...");
            // ExecFn takes an ARGV array — no shell, no injection risk (CLI-58).
            // runCapture spawns via execFileSync with shell:false, so each element
            // is a separate, uninterpreted argv token — never concatenated into sh.
            const execFn = async (argv: string[]): Promise<string> =>
                runCapture(argv);
            const readFileFn = (p: string) => readFileSync(p, "utf-8");
            imageRef = await resolveDigest(
                taggedRef,
                execFn,
                metadataFilePath,
                readFileFn,
            );
            log.info({ imageRef }, "Digest-pinned image ref resolved");

            // Guard: fail fast if digest resolution produced a non-pinned ref.
            validateCRImageRef(imageRef);
        }
    }

    // Render the NextApp CR from config + resolved image. Pass the buildId (== the
    // deploy tag == .next/BUILD_ID, #93) so the operator stamps the
    // `apps.kn-next.dev/build-id` revision label the asset GC resolves against.
    // The operator reconciles all cluster resources from this CR.
    // In dry-run mode imageRef is the mutable tag (acceptable for preview only).
    const crYaml = renderNextAppCR(
        config,
        imageRef,
        options.namespace,
        buildId,
    );
    const crPath = join(process.cwd(), ".output", "nextapp-cr.yaml");

    if (options.dryRun) {
        log.info("Dry run — NextApp CR (not applied):");
        // Print to stdout so callers can capture or display it
        process.stdout.write(crYaml);
        log.info("Dry run complete — no cluster changes made");
        return;
    }

    // Write CR to .output/ and apply it — only CR apply, operator handles the rest.
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(process.cwd(), ".output"), { recursive: true });
    writeFileSync(crPath, crYaml, "utf-8");

    log.info({ cr: crPath }, "Applying NextApp CR to cluster...");
    // `--validate=strict` is passed EXPLICITLY, not inherited. Every other
    // `kubectl apply` this CLI issues does the same (preview.ts, loadtest.ts).
    // The argv guard in cr-apply-strict-validation.test.ts scans the `*.ts`
    // files directly inside `src/cli/` (top level, no recursion — that is where
    // all three live) and fails on any quoted `apply` verb it cannot match to a
    // parsed argv carrying the flag, so a new site cannot slip through silently.
    //
    // Measured on a live cluster (server-side dry-run, structural CRD): with
    // strict validation the apiserver REJECTS a field the CRD does not know
    // (`Error from server (BadRequest): ... strict decoding error: unknown
    // field "…"`), while `--validate=ignore` accepts the object and PRUNES the
    // field silently. Take a field this CLI really emits and that an older CRD
    // plausibly predates: a pruned `spec.database.roSecretRef` means the
    // operator never binds DATABASE_URL_RO, so `getDbRO()` falls back to the
    // writer pool (packages/db/src/index.ts) and staleness-tolerant reads run
    // on the read-WRITE primary credential — a least-privilege downgrade on a
    // CR that still reports Ready=True.
    //
    // kubectl's own default has been `strict` since 1.25, so the common case
    // was already protected — but only by an EXTERNAL BINARY'S DEFAULT. Two
    // vectors take that away (and only two: this CLI spawns kubectl through
    // execFile with `shell: false`, so an interactive shell alias is never in
    // the path, and kubectl exposes no kubeconfig key or env var for
    // `--validate`): a kubectl older than 1.25, or a wrapper/shim binary NAMED
    // `kubectl` on PATH. Asserting the flag makes the guarantee knext's for the
    // argv knext controls — a shim appending `--validate=ignore` still wins,
    // because pflag takes the LAST occurrence of a string flag.
    // `kn-next doctor` reports when the local client is too old for the flag to
    // mean anything.
    try {
        runInherit(
            withKubeContext(
                [
                    "kubectl",
                    "apply",
                    "--validate=strict",
                    "-f",
                    crPath,
                    "-n",
                    options.namespace,
                ],
                options.context,
            ),
        );
    } catch (err) {
        // Never swallow a failed apply — but do not name a cause knext cannot
        // establish. `runInherit` INHERITS stdio, so kubectl's stderr went
        // straight to the terminal and is not available here; doctor's
        // `classifyKubectlFailure` needs that text, so it cannot help. The one
        // cause this CLI can establish on its own is the failure the strict
        // flag itself introduces (see below), so probe for that and otherwise
        // hand the user a differential rather than a confident wrong answer.
        throw new Error(await describeFailedCRApply(), { cause: err });
    }

    // Wait briefly for the operator to begin reconciling, then read the URL.
    const result = runCapture(
        withKubeContext(
            [
                "kubectl",
                "get",
                "nextapp",
                config.name,
                "-n",
                options.namespace,
                "-o",
                "jsonpath={.status.url}",
            ],
            options.context,
        ),
    );
    log.info(
        { url: result.replace(/'/g, "") },
        "Deployment submitted — operator is reconciling",
    );

    // #93 skew-protection retention GC (ADR-0011). Reap old `_next/static/<id>/`
    // prefixes that are outside the retain window AND not currently serving
    // traffic. The whole chain (status.currentTraffic → resolve each live
    // revision's `apps.kn-next.dev/build-id` label → live set, with the
    // fail-safe over-keep skip) lives in runAssetGC — shared verbatim with the
    // standalone `kn-next gc` subcommand so the e2e_gc suite proves THIS exact
    // wiring. Everything against the cluster is READ-ONLY (ADR-0001).
    // Best-effort: a GC failure never fails a deploy that has already shipped.
    if (!options.skipUpload && hasStorage(config)) {
        try {
            const res = runAssetGC(
                config,
                options.namespace,
                buildId,
                undefined,
                undefined,
                false,
                options.context,
            );
            if (!res.pruned) {
                log.warn(
                    {
                        liveRevisions: res.liveRevisions,
                        skipReason: res.skipReason,
                        pinnedRevision: res.pinnedRevision,
                    },
                    "Asset retention GC skipped (fail-safe, over-keep — see skipReason)",
                );
            }
        } catch (err) {
            log.warn({ err }, "Asset retention GC skipped (non-fatal)");
        }
    }
}

// Run only when invoked directly as the entry (not when imported, e.g. in tests).
// The bin doubles as a tiny subcommand dispatcher: `kn-next doctor`,
// `kn-next status`, `kn-next db bind` and `kn-next rollback` route to their own
// modules; everything else (including the historical bare `kn-next` /
// `kn-next deploy`) runs the deploy flow.
//
// SELF-ENTRY HAZARD (#263, canonical note — observed live in PR #262 with gc.ts):
// this dispatcher is the ONLY sanctioned `isEntrypoint(import.meta.url)` entry
// for bin-dispatched modules. If a dispatched module carries its own self-entry
// block and any bundling change inlines it into this bin (e.g. a dynamic import
// becoming static, or a tsup entry-list edit), `import.meta.url` inside the
// inlined module equals the BIN's URL — the block fires at module load and
// hijacks every subcommand. Therefore: bin-dispatched modules (status, doctor,
// db-bind, db-migrate, rollback, gc) must NOT carry self-entry blocks. The only
// other sanctioned self-entry modules are the documented directly-runnable
// entries (build/cleanup/preview — docs-site cli.mdx; preview.yml runs
// dist/cli/preview.js), each with its OWN tsup entry so it is never inlined
// here. Enforced by cli-node-runtime.test.ts ("self-entry blocks exist ONLY in
// sanctioned entry modules").
//
// `build` and `cleanup` are now BOTH bin-dispatched (below) and directly-
// runnable entries carrying self-entry blocks. That combination is safe for
// exactly the reason above: each has its OWN tsup entry, so it emits as its own
// dist file and cannot be inlined here — pinned by cli-node-runtime.test.ts,
// which asserts dist/cli/{build,cleanup}.js exist AND that this bin's bundle
// does not contain their bodies. They are dispatched because README and the
// docs site tell users to run them, and until now `kn-next cleanup` fell
// through to the DEPLOY path — a teardown command that deploys (UX ledger 1d).
if (isEntrypoint(import.meta.url)) {
    // ADR-0046: a bare `kn-next` and a flags-only `kn-next --skip-build` still
    // deploy (the advertised front door), but an unrecognised FIRST TOKEN is an
    // error rather than a silent deploy — `kn-next celanup` must not ship a
    // deployment. The allowlist comes from the same COMMAND_GROUPS list that
    // renders --help, so there is exactly one verb set.
    const invocation = resolveInvocation(process.argv[2]);
    if (invocation.kind === "unknown") {
        writeSync(2, formatUnknownCommand(invocation.input));
        process.exit(1);
    }
    const sub = invocation.kind === "verb" ? invocation.verb : undefined;
    try {
        if (sub === "create") {
            const { createMain } = await import("./create");
            process.exit(await createMain(process.argv.slice(3)));
        } else if (sub === "init-ci") {
            // ADR-0049 stage 1. Writes files only — the client applies the RBAC
            // themselves, because knext holding their cluster credential is
            // exactly what stage 1 exists to avoid.
            const { initCiMain } = await import("./ci/init-ci-cmd");
            process.exit(await initCiMain(process.argv.slice(3)));
        } else if (sub === "doctor") {
            const { doctorMain } = await import("./doctor");
            process.exit(await doctorMain(process.argv.slice(3)));
        } else if (sub === "status") {
            const { statusMain } = await import("./status");
            process.exit(await statusMain(process.argv.slice(3)));
        } else if (sub === "db") {
            const { dbMain } = await import("./db-bind");
            await dbMain(process.argv.slice(3));
        } else if (sub === "rollback") {
            const { rollbackMain } = await import("./rollback");
            process.exit(await rollbackMain(process.argv.slice(3)));
        } else if (sub === "gc") {
            const { gcMain } = await import("./gc");
            process.exit(await gcMain(process.argv.slice(3)));
        } else if (sub === "build") {
            const { buildMain } = await import("./build");
            process.exit(await buildMain(process.argv.slice(3)));
        } else if (sub === "cleanup") {
            const { cleanupMain } = await import("./cleanup");
            process.exit(await cleanupMain(process.argv.slice(3)));
        } else if (sub === "validate") {
            // UX ledger row 4 (4a): config load + schema checks + placeholder
            // preflight, no cluster access. Routed through validate-cmd.ts —
            // validate.ts stays the load-time validation library (see the module
            // header there for why the verb entry is a separate file).
            const { validateMain } = await import("./validate-cmd");
            process.exit(await validateMain(process.argv.slice(3)));
        } else {
            await deploy();
        }
    } catch (err) {
        // "There is no kn-next.config.ts here" is an EXPECTED state — the user
        // is in the wrong directory, or has not wired the app up yet. Print
        // directions and leave; a FATAL line with a serialised Error (message,
        // stack, bundler chunk paths) reads as "the tool is broken" to the
        // Next.js developer this CLI is for (UX ledger 1b). Note there is no
        // --json variant to honour here: the only verbs with a machine-readable
        // mode are `doctor` (loads no config) and `status` (loads it only when
        // the file exists), so neither can reach this branch.
        if (handleConfigNotFound(err)) {
            process.exit(1);
        }
        // A usage mistake (unknown flag, stray positional, unknown db
        // subcommand) is the user mis-typing — same class as the above, same
        // presentation. Falling through to log.fatal printed a serialised
        // Error with a stack frame and an absolute dist chunk path for what is
        // only a typo, which is the presentation this whole change removes.
        if (handleUsageError(err)) {
            process.exit(1);
        }
        const label =
            sub === "create"
                ? "create failed"
                : sub === "db"
                  ? "db command failed"
                  : sub === "doctor"
                    ? "doctor failed"
                    : sub === "status"
                      ? "status failed"
                      : sub === "rollback"
                        ? "rollback failed"
                        : sub === "gc"
                          ? "gc failed"
                          : sub === "build"
                            ? "build failed"
                            : sub === "cleanup"
                              ? "cleanup failed"
                              : sub === "validate"
                                ? "validate failed"
                                : "Deployment failed";
        log.fatal({ err }, label);
        process.exit(1);
    }
}
