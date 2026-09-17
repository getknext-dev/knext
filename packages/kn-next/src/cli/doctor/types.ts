/**
 * Shared types and constants for `kn-next doctor` (#1055 decomposition).
 *
 * The doctor command was one 1912-line file; it is now a thin orchestrator
 * (`../doctor.ts`) over the spine modules here + `./checks/*`. This module holds
 * ONLY declarations — no logic — so every check module can depend on it without
 * a cycle.
 */

import type { KnativeNextConfig } from "../../config";

/** The ingress class net-kourier actually registers a reconciler for (#208). */
export const KOURIER_INGRESS_CLASS = "kourier.ingress.networking.knative.dev";

/**
 * Ports Knative serving's queue-proxy (or its data path) owns on every
 * revision pod (#951). An app's METRICS_PORT override must never land on any
 * of them. 9091 is CONDITIONAL — queue-proxy binds it for its user-metrics
 * server only when the request-metrics protocol is prometheus — while the
 * rest are bound unconditionally. Shared with metrics-port-lockstep.test.ts
 * so the doctor check and the cross-file port guard cannot disagree on what
 * "queue-proxy-owned" means.
 */
export const QUEUE_PROXY_OWNED_PORTS: ReadonlySet<number> = new Set([
    8012, 8013, 8022, 8112, 9090, 9091,
]);

/** The one CONDITIONALLY-bound member of {@link QUEUE_PROXY_OWNED_PORTS}. */
export const QUEUE_PROXY_USER_METRICS_PORT = 9091;

export const OPERATOR_NAMESPACE = "kn-next-operator-system";
export const NEXTAPP_CRD = "nextapps.apps.kn-next.dev";
export const KSVC_CRD = "services.serving.knative.dev";

export const SKIP_UNREACHABLE = "cluster unreachable — check skipped";

/**
 * User-facing walkthrough for pulling from a private registry (#952): create
 * the dockerconfigjson Secret, attach it to the app ServiceAccount, redeploy.
 */
export const PRIVATE_REGISTRY_DOCS_URL =
    "https://knext.dev/docs/private-registries";

/**
 * Minimum kubectl CLIENT version for which `--validate=strict` is meaningful.
 *
 * WHY 1.25 and not 1.27: `kn-next deploy` passes `--validate=strict` explicitly
 * on the NextApp CR apply, and the STRING form of that flag
 * (`strict|warn|ignore`) only exists from kubectl **v1.25** — that same release
 * also made `strict` kubectl's default. On v1.24 and older `--validate` is a
 * boolean, so the flag value we pass is not understood: the deploy cannot
 * assert strict validation at all. (Server-side field validation went GA in
 * apiserver 1.27, but it is on-by-default from 1.25 as beta, and the apiserver
 * is the cluster's business, not the client's — this check is deliberately
 * scoped to the LOCAL binary, the part knext can observe read-only.)
 */
export const MIN_STRICT_VALIDATION_KUBECTL = { major: 1, minor: 25 } as const;

export interface KubectlResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}

/**
 * Injectable kubectl runner. NEVER throws — failures come back as ok:false so
 * every check can degrade gracefully. Production spawns kubectl with
 * shell:false (CLI-58); tests stub it with canned outputs.
 */
export type KubectlFn = (args: readonly string[]) => KubectlResult;

/** Outcome of the pull-secret-less registry manifest probe (#198). */
export type ProbeOutcome = "ok" | "auth-required" | "not-found" | "unreachable";

export type ManifestProbeFn = (image: string) => Promise<ProbeOutcome>;

/**
 * "error" (#230) = the probe itself failed (network/TLS/credentials), NOT a
 * cluster-state fact — distinct from "fail" so consumers (human + --json) can
 * tell "the CRD is missing" apart from "the probe could not reach the CRD".
 */
export type CheckStatus = "pass" | "warn" | "fail" | "skip" | "error";

export interface CheckResult {
    id: string;
    title: string;
    status: CheckStatus;
    detail: string;
    /** One-line repair hint (e.g. "credentials failed — re-authenticate and retry"). */
    hint?: string;
}

export interface DoctorReport {
    checks: CheckResult[];
    /**
     * 1 iff any check hard-FAILed or ERRORed (#230: an errored probe means the
     * preflight could not verify the cluster). WARN/SKIP never fail it.
     */
    exitCode: 0 | 1;
}

/** What the LOCAL kubeconfig says, before any network I/O (finding 1c). */
export type KubeconfigState =
    | { kind: "absent"; searched: readonly string[] }
    | { kind: "no-current-context"; path: string }
    | { kind: "has-current-context" };

export type KubeconfigInspectFn = () => KubeconfigState;

export interface DoctorDeps {
    kubectl: KubectlFn;
    probeImage: ManifestProbeFn;
    /**
     * Local kubeconfig inspector (finding 1c) — lets the reachability gate
     * tell "you don't have a cluster connected yet" apart from a flake.
     * Defaults to the real file-reading inspector; tests inject fixtures.
     */
    inspectKubeconfig?: KubeconfigInspectFn;
    /**
     * Loads the kn-next.config.ts in the CURRENT directory, or undefined when
     * there is none (or it fails to load) — feeds the local static-asset-mode
     * check (ADR-0047). Defaults to the real cwd loader; tests inject.
     */
    loadAppConfig?: () => Promise<KnativeNextConfig | undefined>;
    /**
     * TOTAL time budget for the app-image pullability probes (#952) — the
     * whole fan-out, not per image, so many dead registries cannot stall
     * doctor. Images the budget cuts off report "not verified", never a
     * pass. Defaults to 30s; tests inject 0 to pin the exhausted path.
     */
    appImageProbeBudgetMs?: number;
}

/**
 * Classification of a failed kubectl invocation (#230, P3).
 *
 * "not-found"  — the apiserver answered and said the resource is absent: a
 *                cluster-state FACT, kept as today's FAIL path.
 * "network"    — the probe never got an answer (refused / TLS / i/o timeout).
 * "auth"       — credentials failed (exec plugin, expired token, Unauthorized).
 * "forbidden"  — authenticated but authorization denied (RBAC): the apiserver
 *                answered, the resource may well exist — reporting "not found"
 *                here would lie to a restricted user who merely lacks get/list.
 * "unknown"    — anything ambiguous: callers keep today's behavior.
 *
 * Known residual (accepted): RBAC that denies *discovery* surfaces as
 * `error: the server doesn't have a resource type "<kind>"` — byte-identical
 * to a genuinely absent CRD — so it still classifies "not-found". Conservative
 * stderr matching cannot distinguish the two from stderr alone; fixing it
 * would need an out-of-band probe (e.g. `kubectl auth can-i`).
 */
export type KubectlFailureClass =
    | "not-found"
    | "network"
    | "auth"
    | "forbidden"
    | "unknown";

export interface InfraFailure {
    /** Detail line: failure class + a bounded stderr excerpt. */
    detail: string;
    /** One-line repair hint for the human table / JSON consumers. */
    hint: string;
}

export interface NoClusterDiagnosis {
    detail: string;
    hint: string;
}

/**
 * CNI NetworkPolicy-enforcement classification (#744).
 *
 * The operator reconciles a default-on NetworkPolicy, but enforcement is the
 * CNI's job — flannel (OKE GA, OrbStack) ships no NetworkPolicy controller,
 * so there the policy is declarative only. Even "enforced" is a CEILING: it
 * says an enforcing agent is running, not that policies apply to this
 * namespace. The operator carries the same signature table
 * (internal/controller/netpol_enforcement.go) into the NextApp's
 * NetworkPolicyEnforced status condition — keep the two in sync when adding
 * a CNI.
 */
export type CNIEnforcement = "enforced" | "likely-unenforced" | "unknown";

export interface DaemonSetRef {
    namespace: string;
    name: string;
    /**
     * status.numberReady > 0 — at least one agent pod is running. A matched
     * agent with no running pod is inert, and must never yield "enforced".
     */
    ready: boolean;
}

export interface DeploymentJson {
    metadata?: { name?: string };
    spec?: { template?: { spec?: { containers?: { image?: string }[] } } };
    status?: { readyReplicas?: number; replicas?: number };
}

/**
 * The mutable context threaded through the check modules. `skipAll` is set by
 * the cluster gate; `operatorImage` is set by the operator check and consumed
 * by the operator-image check — the one inter-check data dependency, made
 * explicit here rather than left as a closure variable.
 */
export interface CheckContext {
    deps: DoctorDeps;
    kubectl: KubectlFn;
    skipAll: boolean;
    operatorImage?: string;
}
