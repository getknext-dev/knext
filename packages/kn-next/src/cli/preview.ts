#!/usr/bin/env node

/**
 * kn-next preview — per-PR ephemeral preview environments (issue #91).
 *
 * Usage:
 *   kn-next preview deploy  --pr <n> --branch <ref> [-n <namespace>]
 *   kn-next preview destroy --pr <n>                [-n <namespace>]
 *
 * MODEL (ADR-0013): a preview is EPHEMERAL. It is a fresh build deployed under a
 * NEW NextApp CR named `<app>-pr-<n>`. Because the asset prefix, ksvc URL, and the
 * operator's external-cleanup finalizer are ALL scoped by the CR name, a preview
 * gets an isolated `<app>-pr-<n>/` asset prefix, a distinct ksvc URL, and on delete
 * the finalizer reaps exactly that prefix — no operator changes, no TTL timer
 * (the PR-close event is the single teardown authority).
 *
 * ADR-0001 (operator = single source of truth): this CLI emits INTENT only. It
 * applies the `nextapp` CR and deletes the `nextapp` CR — it NEVER writes ksvc /
 * Knative Route / `kn` directly. The operator reconciles preview overrides
 * (max-scale=1, min-scale=0, 30s retention, environment=preview / pr-id labels)
 * from spec.preview.
 *
 * #92/#93 interaction: a preview is its own build-id with its own `<app>-pr-<n>/`
 * asset prefix and its own `apps.kn-next.dev/build-id` revision label, so prod's
 * deploy-time GC (scoped to prod's `<app>/`) never touches it and a preview can't
 * skew prod. We do NOT emit spec.traffic on a preview (single revision, max-scale=1).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { KnativeNextConfig } from "../config";
import { getAssetPrefix } from "../utils/asset-upload";
import { createLogger } from "../utils/logger";
import {
    renderNextAppCR,
    resolveDigest,
    validateCRImageRef,
} from "./cr-builder";
import { isEntrypoint, runCapture, runInherit, runQuiet } from "./exec";
import { loadConfig } from "./shared";

const log = createLogger({ module: "preview" });

/**
 * DNS-1123 label: lowercase alphanumerics and hyphens, must start/end with an
 * alphanumeric, max 63 chars. A NextApp name becomes a ksvc / k8s object name, so
 * it must satisfy this — a long app name + `-pr-<n>` suffix can overflow 63 chars.
 */
const DNS_1123_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Derive the preview NextApp name `<app>-pr-<n>` from the app name + PR number. */
export function derivePreviewName(appName: string, prId: string): string {
    return `${appName}-pr-${prId}`;
}

/**
 * Validate that a derived preview name is a legal DNS-1123 label of <=63 chars.
 * Throws (before any cluster write) so an over-long app name aborts loudly.
 */
export function validatePreviewName(name: string): void {
    if (name.length > 63) {
        throw new Error(
            `Preview name "${name}" is ${name.length} chars — exceeds the 63-char ` +
                `DNS-1123 limit for a Kubernetes object name. Shorten the app name.`,
        );
    }
    if (!DNS_1123_RE.test(name)) {
        throw new Error(
            `Preview name "${name}" is not a valid DNS-1123 label ` +
                `(lowercase alphanumerics + hyphens, must start/end alphanumeric).`,
        );
    }
}

/** Injectable exec boundary so tests assert the EXACT argv without shelling out. */
export type PreviewExec = (argv: readonly string[]) => void;
/** Injectable capture boundary (returns stdout) for the status.url read-back. */
export type PreviewCapture = (argv: readonly string[]) => string;
/**
 * BuildAndPush builds + pushes the preview image and returns a digest-pinned ref.
 * Receives the derived preview NAME (so the image repo path is preview-scoped) and
 * the config already overridden to that name. Injected in tests to bypass docker.
 */
export type PreviewBuildAndPush = (
    previewName: string,
    config: KnativeNextConfig,
    branch: string,
) => Promise<string>;

export interface PreviewDeployOptions {
    prId: string;
    branch: string;
    namespace: string;
}

export interface PreviewDeployDeps {
    apply: PreviewExec;
    capture: PreviewCapture;
    buildAndPush: PreviewBuildAndPush;
}

/**
 * Deploy a preview: derive `<app>-pr-<n>`, validate it, build+push a digest-pinned
 * image, render a NextApp CR WITH spec.preview, `kubectl apply` it, then read back
 * status.url (printed for the PR comment). Returns the status.url string.
 *
 * Exactly ONE cluster write (apply of the nextapp CR) + read-back of the nextapp's
 * status.url. NEVER touches ksvc / Route / kn (ADR-0001).
 */
export async function runPreviewDeploy(
    config: KnativeNextConfig,
    options: PreviewDeployOptions,
    deps: PreviewDeployDeps,
): Promise<string> {
    const previewName = derivePreviewName(config.name, options.prId);
    // Validate BEFORE any build/push/apply so an over-long name aborts cleanly.
    validatePreviewName(previewName);

    // Override the config name so the asset prefix, image repo path, ksvc URL, and
    // finalizer scope are all `<app>-pr-<n>`-isolated from prod.
    //
    // CRITICAL (data sovereignty + destroy-safety): also name-scope the Redis
    // keyPrefix. Asset/URL/finalizer prefixes are re-derived from `name`, but the
    // Redis `cache.keyPrefix` is a verbatim value — if copied from prod, the
    // preview would (1) read/write/poison prod's ISR/data cache (violates
    // scs-zones: a zone owns its data store, no shared database), and far worse
    // (2) on `preview destroy` the operator's finalizer CleanupCache would flush
    // `<prod-prefix>:*`, WIPING prod's Redis. Overriding keyPrefix to the preview
    // name keeps the keyspace isolated and makes teardown only ever touch the
    // preview's own keys. Only the Redis cache has a (string) keyPrefix the
    // finalizer flushes by; DynamoDB is keyed by table, so we leave it untouched.
    const previewCache: KnativeNextConfig["cache"] =
        config.cache?.provider === "redis"
            ? { ...config.cache, keyPrefix: previewName }
            : config.cache;
    const previewConfig: KnativeNextConfig = {
        ...config,
        name: previewName,
        cache: previewCache,
    };

    const imageRef = await deps.buildAndPush(
        previewName,
        previewConfig,
        options.branch,
    );
    validateCRImageRef(imageRef);

    // The build-id is the image tag (the digest-pinned ref keeps tag+digest);
    // reuse the PR id-scoped tag if the image ref carries one, else fall back.
    const buildId = extractTag(imageRef) ?? `${Date.now()}`;

    const crYaml = renderNextAppCR(
        previewConfig,
        imageRef,
        options.namespace,
        buildId,
        {
            prId: options.prId,
            branch: options.branch,
        },
    );

    const crPath = join(process.cwd(), ".output", "nextapp-preview-cr.yaml");
    mkdirSync(join(process.cwd(), ".output"), { recursive: true });
    writeFileSync(crPath, crYaml, "utf-8");

    deps.apply(["kubectl", "apply", "-f", crPath, "-n", options.namespace]);

    const url = deps
        .capture([
            "kubectl",
            "get",
            "nextapp",
            previewName,
            "-n",
            options.namespace,
            "-o",
            "jsonpath={.status.url}",
        ])
        .replace(/'/g, "")
        .trim();

    return url;
}

export interface PreviewDestroyOptions {
    prId: string;
    namespace: string;
}

/**
 * Destroy a preview: delete ONLY the `<app>-pr-<n>` NextApp CR (--ignore-not-found,
 * so re-runs are idempotent). The operator's external-cleanup finalizer reaps the
 * name-scoped asset prefix + Redis keyspace; owned children GC via ownerReferences.
 */
export function runPreviewDestroy(
    config: KnativeNextConfig,
    options: PreviewDestroyOptions,
    exec: PreviewExec = runQuiet,
): void {
    const previewName = derivePreviewName(config.name, options.prId);
    exec([
        "kubectl",
        "delete",
        "nextapp",
        previewName,
        "-n",
        options.namespace,
        "--ignore-not-found",
    ]);
}

/** Extract the `:tag` between the repo path and `@sha256:` from a pinned ref. */
function extractTag(imageRef: string): string | undefined {
    const atIdx = imageRef.indexOf("@sha256:");
    const head = atIdx >= 0 ? imageRef.slice(0, atIdx) : imageRef;
    const colonIdx = head.lastIndexOf(":");
    const slashIdx = head.lastIndexOf("/");
    if (colonIdx > slashIdx) {
        return head.slice(colonIdx + 1);
    }
    return undefined;
}

/**
 * Default production buildAndPush: mirrors deploy.ts's build → push → resolveDigest
 * path, but with the config already overridden to the preview name. Runs the real
 * `npm run build` + `docker buildx build --push` and resolves the @sha256: digest.
 */
async function defaultBuildAndPush(
    previewName: string,
    config: KnativeNextConfig,
    branch: string,
): Promise<string> {
    // Lock-step the preview tag with the PR/branch so the static prefix and the
    // image tag share an id (see deploy.ts #93 note). The tag is the build-id.
    const tag = `${previewName}-${Date.now()}`;
    process.env.NEXT_DEPLOYMENT_ID = tag;

    if (config.storage?.publicUrl) {
        process.env.ASSET_PREFIX = getAssetPrefix(config);
    }

    log.info(
        { previewName, branch },
        "Building preview (output:standalone)...",
    );
    runQuiet(["npm", "run", "build"]);

    const taggedRef = `${config.registry}/${previewName}:${tag}`;
    const metadataFilePath = join(
        process.cwd(),
        ".output",
        "buildx-metadata.json",
    );
    const repoRoot = resolve(process.cwd(), "../..");
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

    const execFn = async (argv: string[]): Promise<string> => runCapture(argv);
    const readFileFn = (p: string) => readFileSync(p, "utf-8");
    return resolveDigest(taggedRef, execFn, metadataFilePath, readFileFn);
}

interface PreviewArgs {
    command: "deploy" | "destroy";
    prId?: string;
    branch?: string;
    namespace: string;
}

/** Parse argv into preview options. First positional is the subcommand. */
export function parsePreviewArgs(argv: readonly string[]): PreviewArgs {
    const { values, positionals } = parseArgs({
        args: [...argv],
        options: {
            pr: { type: "string" },
            branch: { type: "string" },
            namespace: { type: "string", short: "n", default: "default" },
        },
        strict: true,
        allowPositionals: true,
    });
    const command = positionals[0];
    if (command !== "deploy" && command !== "destroy") {
        throw new Error(
            `kn-next preview: expected subcommand "deploy" or "destroy", got "${command ?? ""}"`,
        );
    }
    return {
        command,
        prId: values.pr,
        branch: values.branch,
        namespace: values.namespace ?? "default",
    };
}

async function preview() {
    const args = parsePreviewArgs(process.argv.slice(2));
    if (!args.prId) {
        throw new Error("kn-next preview: --pr <n> is required");
    }
    const config = await loadConfig();

    if (args.command === "destroy") {
        log.info(
            { app: config.name, pr: args.prId, namespace: args.namespace },
            "Destroying preview (deleting NextApp CR; finalizer reaps assets)...",
        );
        runPreviewDestroy(config, {
            prId: args.prId,
            namespace: args.namespace,
        });
        log.info("✨ Preview destroyed!");
        return;
    }

    if (!args.branch) {
        throw new Error("kn-next preview deploy: --branch <ref> is required");
    }

    log.info(
        { app: config.name, pr: args.prId, branch: args.branch },
        "Deploying preview (build → push → apply NextApp CR with spec.preview)...",
    );
    const url = await runPreviewDeploy(
        config,
        {
            prId: args.prId,
            branch: args.branch,
            namespace: args.namespace,
        },
        {
            apply: runInherit,
            capture: runCapture,
            buildAndPush: defaultBuildAndPush,
        },
    );

    // Print the URL to stdout (bare) so CI can capture it for the PR comment.
    process.stdout.write(`${url}\n`);
    log.info({ url }, "✨ Preview deployed — operator is reconciling");
}

// Run only when invoked directly as the entry (not when imported, e.g. in tests).
// SANCTIONED self-entry (#263): this is a DOCUMENTED directly-runnable entry
// (docs-site cli.mdx "Directly runnable entries") with its own tsup entry, so
// it is never inlined into the bin. See the hazard note atop deploy.ts's
// dispatcher before adding self-entry blocks anywhere else.
if (isEntrypoint(import.meta.url)) {
    try {
        await preview();
    } catch (err) {
        log.fatal({ err }, "Preview failed");
        process.exit(1);
    }
}
