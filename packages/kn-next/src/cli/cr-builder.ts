/**
 * cr-builder.ts — NextApp CR renderer (no bun / no cluster side-effects)
 *
 * This module is intentionally free of any bun/shell imports so it can be
 * tested under vitest/Node and imported by deploy.ts without coupling the
 * CR-rendering logic to the exec layer.
 *
 * ADR-0001: the CLI's job is build → push → apply the NextApp CR.
 * The operator reconciles everything else (ksvc, SA, PVC, KafkaSource).
 */

import YAML from "yaml";
import type { KnativeNextConfig } from "../config";

/**
 * Builds a NextApp CR object from a KnativeNextConfig and a resolved image ref.
 * The image MUST be digest-pinned (the operator enforces this at reconcile time).
 *
 * Invariants preserved (A1-cli discipline):
 * - scale-to-zero: scaling.minScale defaults to 0
 * - bytecode cache: cache.enableBytecodeCache=true when provider=redis
 * - NODE_COMPILE_CACHE wiring: operator reads cache.enableBytecodeCache
 */
export function buildNextAppCRObject(
    config: KnativeNextConfig,
    image: string,
    namespace: string,
): Record<string, unknown> {
    // Scaling — preserve minScale:0 (scale-to-zero invariant)
    const minScale = config.scaling?.minScale ?? 0;
    const maxScale = config.scaling?.maxScale ?? 10;
    const scaling = {
        minScale,
        maxScale,
        ...(config.scaling ? {} : {}),
    };

    // Resources — from config.scaling (legacy field names match ResourcesSpec)
    const resources =
        config.scaling?.cpuRequest ||
        config.scaling?.memoryRequest ||
        config.scaling?.cpuLimit ||
        config.scaling?.memoryLimit
            ? {
                  cpuRequest: config.scaling.cpuRequest ?? "250m",
                  memoryRequest: config.scaling.memoryRequest ?? "512Mi",
                  cpuLimit: config.scaling.cpuLimit ?? "1000m",
                  memoryLimit: config.scaling.memoryLimit ?? "1Gi",
              }
            : undefined;

    // Storage spec
    const storage = config.storage
        ? {
              provider: config.storage.provider,
              bucket: config.storage.bucket,
              ...(config.storage.region
                  ? { region: config.storage.region }
                  : {}),
              ...(config.storage.endpoint
                  ? { endpoint: config.storage.endpoint }
                  : {}),
          }
        : undefined;

    // Cache spec — enable bytecode cache when Redis is configured
    // (operator uses cache.enableBytecodeCache to provision PVC + NODE_COMPILE_CACHE)
    const cache = config.cache
        ? {
              provider: config.cache.provider,
              url: config.cache.provider === "redis" ? config.cache.url : "",
              ...(config.cache.provider === "redis" && config.cache.keyPrefix
                  ? { keyPrefix: config.cache.keyPrefix }
                  : {}),
              // Enable bytecode cache by default when Redis is available —
              // this is what triggers the PVC + NODE_COMPILE_CACHE env var in the operator
              enableBytecodeCache: config.cache.provider === "redis",
          }
        : undefined;

    // Revalidation spec
    const revalidation =
        config.queue && config.queue.provider === "kafka"
            ? {
                  queue: "kafka",
                  kafkaBrokerUrl: config.queue.brokerUrl,
              }
            : undefined;

    // Secrets spec — map SecretsConfig → SecretsSpec
    const secrets = config.secrets
        ? {
              ...(config.secrets.envFrom?.length
                  ? { envFrom: config.secrets.envFrom }
                  : {}),
              ...(config.secrets.envMap
                  ? {
                        envMap: Object.fromEntries(
                            Object.entries(config.secrets.envMap).map(
                                ([k, v]) => [
                                    k,
                                    {
                                        secretName: v.name,
                                        secretKey: v.key ?? k,
                                    },
                                ],
                            ),
                        ),
                    }
                  : {}),
          }
        : undefined;

    // Observability spec — thread RUM (#94) into spec.observability.rum.
    // RUM requires observability.enabled; default OFF when no rum block.
    const observability = config.observability?.enabled
        ? {
              enabled: true,
              ...(config.observability.rum?.enabled
                  ? {
                        rum: {
                            enabled: true,
                            // sampleRate is authored as a number (config.ts) for
                            // ergonomics, but the NextApp CRD types
                            // observability.rum.sampleRate as a STRING (env vars
                            // are strings anyway). Emit it as a string so
                            // `kubectl apply` passes OpenAPI validation. (#94)
                            ...(typeof config.observability.rum.sampleRate ===
                            "number"
                                ? {
                                      sampleRate: String(
                                          config.observability.rum.sampleRate,
                                      ),
                                  }
                                : {}),
                        },
                    }
                  : {}),
          }
        : undefined;

    // Runtime
    const runtime = config.runtime ?? undefined;

    const spec: Record<string, unknown> = {
        image,
        scaling,
        ...(resources ? { resources } : {}),
        ...(storage ? { storage } : {}),
        ...(cache ? { cache } : {}),
        ...(revalidation ? { revalidation } : {}),
        ...(config.secrets ? { secrets } : {}),
        ...(observability ? { observability } : {}),
        ...(config.healthCheckPath
            ? { healthCheckPath: config.healthCheckPath }
            : {}),
        ...(runtime ? { runtime } : {}),
    };

    return {
        apiVersion: "apps.kn-next.dev/v1alpha1",
        kind: "NextApp",
        metadata: {
            name: config.name,
            namespace,
        },
        spec,
    };
}

/**
 * Renders a NextApp CR as a YAML string.
 * Pure function — no I/O, no shell calls.
 */
export function renderNextAppCR(
    config: KnativeNextConfig,
    image: string,
    namespace: string,
): string {
    const crObject = buildNextAppCRObject(config, image, namespace);
    return YAML.stringify(crObject);
}

/**
 * ExecFn is the exec-boundary type injected into digest-resolution and deploy helpers.
 * Takes an ARGV array (string[]) — never a shell string — to prevent command injection.
 * In production this spawns the process directly (no shell); in tests it is a spy.
 * The return value is cast to string — callers use `.trim()` on the result.
 */
export type ExecFn = (argv: string[]) => Promise<unknown>;

/**
 * IMAGE_REF_RE is the strict allowlist for image reference characters.
 * Only characters safe in a registry image ref are allowed:
 *   alphanumerics, dot, hyphen, underscore, colon, slash, at-sign.
 * Anything else (semicolons, backticks, dollar signs, spaces, etc.) is
 * a shell metacharacter and indicates a malformed or malicious ref.
 */
const IMAGE_REF_RE = /^[A-Za-z0-9._:/@-]+$/;

/**
 * validateTaggedRef validates that an image ref contains only characters
 * safe to pass to docker (no shell metacharacters).
 *
 * This is defense-in-depth: even though ExecFn takes an ARGV array (no shell),
 * we reject obviously malformed refs early so the error is clear.
 *
 * @param ref - the image ref to validate (e.g. "registry/name:tag")
 * @throws    - if the ref contains characters outside [A-Za-z0-9._:/@-]
 */
export function validateTaggedRef(ref: string): void {
    if (!IMAGE_REF_RE.test(ref)) {
        throw new Error(
            `Image ref "${ref}" contains invalid characters. ` +
                `Only [A-Za-z0-9._:/@-] are allowed. ` +
                `Shell metacharacters (;, \`, $, spaces, etc.) are not permitted.`,
        );
    }
}

/**
 * ReadFileFn reads a file synchronously and returns its content as a string.
 * Injected so tests can spy without touching the real filesystem.
 * In production: `(p) => require('node:fs').readFileSync(p, 'utf-8')`
 */
export type ReadFileFn = (path: string) => string;

/**
 * validateCRImageRef mirrors the operator's validateImageRef rule (ADR-0001 / A1-digest).
 *
 * ACCEPT:  image contains "@sha256:" — digest-pinned
 * REJECT:  everything else (tag-only, :latest, bare name)
 *
 * Throws with a message containing "@sha256:" so callers / tests can match it.
 */
export function validateCRImageRef(image: string): void {
    if (image.includes("@sha256:")) {
        return;
    }
    throw new Error(
        `Image ref "${image}" is not digest-pinned. ` +
            `The operator requires a ref containing @sha256: ` +
            `(e.g. registry/name:tag@sha256:<hash>). ` +
            `Use resolveDigest() after pushing to obtain the pinned ref.`,
    );
}

/**
 * resolveDigestFromMetadataFile reads the buildx metadata JSON written by
 * `docker buildx build --metadata-file <path>` and extracts the
 * `containerimage.digest` field (format: `sha256:<hex>`).
 *
 * Pure / synchronous — no shell calls, no bun, fully injectable.
 *
 * @param metadataFilePath - path to the buildx metadata JSON file
 * @param readFileFn       - injected file-read fn (spy in tests, fs.readFileSync in prod)
 * @returns                - digest string, e.g. "sha256:deadbeef..."
 * @throws                 - if the file is unreadable, not valid JSON, or lacks the key
 */
export function resolveDigestFromMetadataFile(
    metadataFilePath: string,
    readFileFn: ReadFileFn,
): string {
    const raw = readFileFn(metadataFilePath);
    // Throws if raw is not valid JSON — let it propagate so callers can catch + fallback.
    const meta = JSON.parse(raw) as Record<string, unknown>;
    const digest = meta["containerimage.digest"];
    if (typeof digest !== "string" || !digest) {
        throw new Error(
            `buildx metadata at "${metadataFilePath}" has no containerimage.digest field. ` +
                `Keys present: ${Object.keys(meta).join(", ")}`,
        );
    }
    if (!digest.startsWith("sha256:")) {
        throw new Error(
            `containerimage.digest "${digest}" does not start with sha256: — ` +
                `unexpected format in buildx metadata file.`,
        );
    }
    return digest;
}

/**
 * resolveDigest resolves the real @sha256: content-digest for a just-pushed image.
 *
 * Resolution priority (CLI-58 spec):
 *   1. PRIMARY:  read `containerimage.digest` from the buildx metadata JSON file
 *                (written by `docker buildx build --metadata-file <path>`)
 *                → emits `taggedRef@sha256:<digest>` (tag + digest)
 *   2. FALLBACK: `docker inspect` via ARGV array — NO shell string, NO injection risk.
 *                taggedRef is passed as a single argv element after validateTaggedRef.
 *
 * This is intentionally bun-free: all I/O is injected via execFn / readFileFn
 * so tests run without Docker or a real filesystem.
 *
 * @param taggedRef        - mutable push target (e.g. "registry/name:timestamp")
 * @param execFn           - injected exec boundary (argv: string[]) — ARGV, never shell string
 * @param metadataFilePath - optional path to buildx --metadata-file output (PRIMARY path)
 * @param readFileFn       - optional file-read fn required when metadataFilePath is given
 * @returns                - digest-pinned ref containing "@sha256:"
 */
export async function resolveDigest(
    taggedRef: string,
    execFn: ExecFn,
    metadataFilePath?: string,
    readFileFn?: ReadFileFn,
): Promise<string> {
    // Defense-in-depth: reject refs with shell metacharacters before any exec.
    // This fires whether we take the PRIMARY or FALLBACK path.
    validateTaggedRef(taggedRef);

    // PRIMARY: metadata-file path — no shell call needed.
    if (metadataFilePath && readFileFn) {
        try {
            const digest = resolveDigestFromMetadataFile(
                metadataFilePath,
                readFileFn,
            );
            // Compose `taggedRef@sha256:<digest>` so both tag and digest are present.
            return `${taggedRef}@${digest}`;
        } catch {
            // Metadata file unavailable / corrupt — fall through to docker inspect.
        }
    }

    // FALLBACK: docker inspect via ARGV (no shell, no injection).
    // taggedRef is a validated, single element — never concatenated into a shell string.
    const raw = await execFn([
        "docker",
        "inspect",
        "--format",
        "{{index .RepoDigests 0}}",
        taggedRef,
    ]);
    const line = String(raw ?? "").trim();

    if (!line.includes("@sha256:")) {
        throw new Error(
            `Could not resolve digest for image "${taggedRef}". ` +
                `docker inspect returned: "${line}". ` +
                `Ensure the image was pushed before calling resolveDigest().`,
        );
    }

    return line;
}

/**
 * dryRunDeploy renders the NextApp CR YAML and returns it WITHOUT
 * executing any cluster or shell commands.
 *
 * @param config   - kn-next config
 * @param image    - resolved, digest-pinned image ref
 * @param namespace - target k8s namespace
 * @param execFn   - injected exec boundary (spy target in tests; never called in dry-run)
 * @returns CR YAML string
 */
export async function dryRunDeploy(
    config: KnativeNextConfig,
    image: string,
    namespace: string,
    execFn?: ExecFn,
): Promise<string> {
    // execFn is intentionally unused in dry-run mode.
    // Its presence as a parameter allows tests to spy and assert 0 calls.
    void execFn;
    return renderNextAppCR(config, image, namespace);
}
