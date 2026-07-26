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
import type { KnativeNextConfig } from "../config";
import {
    getAssetPrefix,
    reclaimBuildPrefix,
    uploadAssets,
} from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import {
    renderNextAppCR,
    resolveDigest,
    validateCRImageRef,
} from "./cr-builder";
import { isEntrypoint, runCapture, runInherit, runQuiet } from "./exec";
import { runAssetGC } from "./gc";
import { loadConfig } from "./shared";

const log = createLogger({ module: "deploy" });

interface DeployOptions {
    registry?: string;
    bucket?: string;
    tag?: string;
    namespace: string;
    skipBuild: boolean;
    skipUpload: boolean;
    dryRun: boolean;
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
    const { values } = parseArgs({
        options: {
            registry: { type: "string", short: "r" },
            bucket: { type: "string", short: "b" },
            tag: { type: "string", short: "t" },
            namespace: { type: "string", short: "n", default: "default" },
            "skip-build": { type: "boolean", default: false },
            "skip-upload": { type: "boolean", default: false },
            "dry-run": { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
            version: { type: "boolean", short: "v", default: false },
        },
        strict: true,
        allowPositionals: true,
    });

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
        writeStdoutSync(
            `${[
                "kn-next deploy — build → push → apply NextApp CR",
                "",
                "Commands:",
                "  deploy (default)  build → push → apply the NextApp CR",
                "  db bind           bind an existing Postgres Secret to the NextApp CR",
                "  db migrate        apply pending migrations against the writer, once",
                "  doctor            cluster-prereq preflight (read-only; --json)",
                "  status            show the NextApp's honest conditions (read-only; --json, --watch)",
                "  rollback          pin traffic to a prior Knative Revision (--to, --canary)",
                "  gc                reap old _next/static/<build-id>/ asset prefixes (skew-protection GC)",
                "",
                "Options:",
                "  -r, --registry  Container registry (overrides config)",
                "  -b, --bucket    Storage bucket (overrides config)",
                "  -t, --tag       Image tag (default: timestamp)",
                "  -n, --namespace Kubernetes namespace (default: default)",
                "  --skip-build    Skip next build step",
                "  --skip-upload   Skip asset upload step",
                "  --dry-run       Print the NextApp CR without applying it",
                "  -h, --help      Show this help",
                "  -v, --version   Print the kn-next version",
            ].join("\n")}\n`,
        );
        process.exit(0);
    }

    return {
        registry: values.registry || process.env.KN_REGISTRY,
        bucket: values.bucket || process.env.KN_BUCKET,
        tag: values.tag || process.env.KN_IMAGE_TAG,
        namespace: values.namespace || process.env.KN_NAMESPACE || "default",
        skipBuild: values["skip-build"] ?? false,
        skipUpload: values["skip-upload"] ?? false,
        dryRun: values["dry-run"] ?? false,
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
 * The deploy orchestrator: build → upload assets → push image → apply the
 * NextApp CR (ADR-0001: operator is the single source of truth). Exported at
 * the MODULE level (not a package `exports` subpath) so the sibling
 * deploy-orchestrator.test.ts can pin its failure/skip/skew branches
 * hermetically against mocked seams. It is invoked by the entry dispatcher
 * below when run as the `kn-next`/`kn-next deploy` bin.
 */
export async function deploy() {
    const options = parseCliArgs();

    log.info({ dryRun: options.dryRun }, "kn-next deploy");

    // Load config with validation
    const baseConfig = await loadConfig();
    const config = applyOverrides(baseConfig, options);

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

    if (!options.skipBuild) {
        const assetPrefix = getAssetPrefix(config);
        process.env.ASSET_PREFIX = assetPrefix;
        log.info(
            { assetPrefix, buildId },
            "Running next build (output:standalone)...",
        );
        runQuiet(["npm", "run", "build"]);
        log.info(
            "Next.js build complete — standalone output in .next/standalone/",
        );

        // Defect-A guard: fail LOUDLY if `.next/BUILD_ID` is not the deploy tag.
        // `_next/static/<BUILD_ID>/` is the upload prefix the GC prunes by; if Next
        // ever ignores `generateBuildId` and falls back to a random nanoid, the GC
        // would silently match nothing and the "just-deployed build is protected"
        // guarantee would break. Better to abort the deploy than ship that.
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

    const imageTag = buildId;
    // taggedRef is the mutable push target — used for docker build/push only.
    // The operator-facing CR image ref MUST be digest-pinned (see resolveDigest below).
    const taggedRef = `${config.registry}/${config.name}:${imageTag}`;

    log.info(
        { image: taggedRef },
        "Image tag resolved (will be digest-pinned after push)",
    );

    // imageRef is what we put in the CR — starts as taggedRef for dry-run,
    // then replaced with the @sha256:-pinned ref after a real push.
    let imageRef = taggedRef;

    if (!options.dryRun) {
        const tasks: Promise<void>[] = [];

        // v6-P2 (ADR-0011): track whether the asset upload actually COMPLETED,
        // so that if the concurrent docker push rejects we can tell the
        // upload-succeeded-then-push-failed leg (orphaned _next/static/<id>/
        // prefix to reclaim) from an upload-failed leg (nothing uploaded).
        let uploadSucceeded = false;
        let uploadPromise: Promise<void> | undefined;

        if (!options.skipUpload) {
            log.info("Running parallel tasks: asset upload + Docker build");
            uploadPromise = (async () => {
                await uploadAssets(config);
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

        log.info("Building & pushing Docker image");
        tasks.push(
            (async () => {
                const repoRoot = resolve(process.cwd(), "../..");
                // --metadata-file writes the buildx result JSON (includes containerimage.digest).
                // ARGV array, no shell — taggedRef etc. arrive as single tokens.
                runInherit([
                    "docker",
                    "buildx",
                    "build",
                    "--platform",
                    "linux/amd64",
                    "-f",
                    `${process.cwd()}/Dockerfile`,
                    "-t",
                    taggedRef,
                    "--push",
                    "--metadata-file",
                    metadataFilePath,
                    repoRoot,
                ]);
                log.info("Docker image built and pushed");
            })(),
        );

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
            if (!options.skipUpload && uploadPromise) {
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
    // `kubectl apply` this CLI issues does the same (preview.ts, loadtest.ts);
    // the argv guard in cr-apply-strict-validation.test.ts scans for new ones.
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
        runInherit([
            "kubectl",
            "apply",
            "--validate=strict",
            "-f",
            crPath,
            "-n",
            options.namespace,
        ]);
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
    const result = runCapture([
        "kubectl",
        "get",
        "nextapp",
        config.name,
        "-n",
        options.namespace,
        "-o",
        "jsonpath={.status.url}",
    ]);
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
    if (!options.skipUpload) {
        try {
            const res = runAssetGC(config, options.namespace, buildId);
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
if (isEntrypoint(import.meta.url)) {
    const sub = process.argv[2];
    try {
        if (sub === "doctor") {
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
        } else {
            await deploy();
        }
    } catch (err) {
        const label =
            sub === "db"
                ? "db command failed"
                : sub === "doctor"
                  ? "doctor failed"
                  : sub === "status"
                    ? "status failed"
                    : sub === "rollback"
                      ? "rollback failed"
                      : sub === "gc"
                        ? "gc failed"
                        : "Deployment failed";
        log.fatal({ err }, label);
        process.exit(1);
    }
}
