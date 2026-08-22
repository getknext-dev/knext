#!/usr/bin/env node

/**
 * kn-next doctor — cluster-prereq preflight.
 *
 * Usage:
 *   kn-next doctor [--json]
 *
 * Runs the checks a fresh `kn-next deploy` depends on, each one field-learned
 * from a real outage:
 *   (a) NextApp CRD present + a served version
 *   (b) operator Deployment Ready in kn-next-operator-system
 *   (c) cert-manager webhook prereq (the operator bundle ships webhook certs)
 *   (d) config-network ingress-class vs the reconciler that actually serves it
 *       — #208: a KnativeServing CR declaring `kourier.knative.dev` while
 *       net-kourier serves `kourier.ingress.networking.knative.dev` makes every
 *       KIngress silently skip (routes never program, no error surfaced)
 *   (e) operator-image anonymous pullability — #198: a private ghcr package
 *       ImagePullBackOffs every fresh cluster the quickstart touches
 *   (f) Knative Serving installed
 *   (g) the LOCAL kubectl is new enough (>= v1.25) for `--validate=strict` —
 *       the flag `kn-next deploy` passes explicitly on the NextApp CR apply so
 *       a field the operator's CRD does not know is rejected, not silently
 *       pruned. Concretely, for a field the CLI emits and an older CRD may
 *       predate: a pruned `spec.database.roSecretRef` drops DATABASE_URL_RO,
 *       so `getDbRO()` falls back to the writer pool and reads run on the
 *       read-WRITE primary credential — a least-privilege downgrade on a CR
 *       that still reports Ready=True
 *
 * READ-ONLY by construction (ADR-0001): every kubectl call is a `get` or a
 * client-side `version`; the registry probe is an HTTP manifest HEAD.
 *
 * Exit-code contract:
 *   - 1 on hard FAILs (a cluster-state fact is wrong) AND on probe ERRORs
 *     (#230: the apiserver answered the reachability gate but an individual
 *     probe then failed for network/TLS/credential/RBAC reasons — the
 *     preflight could not verify the cluster, so it must not report green).
 *   - WARN/SKIP never fail the preflight; a fully-unreachable cluster keeps
 *     the documented degrade path (gate WARNs, every check SKIPs, exit 0).
 *
 * #230: probe-infrastructure failures (network timeout, TLS handshake,
 * expired exec credentials) are classified BEFORE mapping to a check result —
 * they surface as a distinct ERROR ("probe failed"), never as a false
 * "not found" cluster-state fact. The classifier is deliberately
 * conservative: only clearly-infrastructural stderr signatures reclassify;
 * anything ambiguous keeps the legacy behavior.
 *
 * Finding 1c (docs/ux/ergonomics-ledger.md): when the reachability gate
 * fails, doctor first consults the LOCAL kubeconfig — pure file reads, no
 * kubectl, no network — to tell "no cluster configured yet" (absent
 * kubeconfig / no current-context / refused dial on a local-only address)
 * apart from a genuine remote flake. The zero-k8s persona has no cluster;
 * "check network/VPN and retry" sends them in a circle.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { KnativeNextConfig } from "../config";
import { NO_STORAGE_DOCS_URL } from "../utils/asset-upload";
import { DOCS_URL } from "./help";
import { unknownEmittedFields } from "./schema/crd-schema";
import { EMITTED_CR_FIELD_PATHS } from "./schema/emitted-fields.generated";
import { readKnownCRDFields } from "./schema/preflight";
import { excerpt, loadConfig, UsageError } from "./shared";

/** The ingress class net-kourier actually registers a reconciler for (#208). */
export const KOURIER_INGRESS_CLASS = "kourier.ingress.networking.knative.dev";

const OPERATOR_NAMESPACE = "kn-next-operator-system";
const NEXTAPP_CRD = "nextapps.apps.kn-next.dev";
const KSVC_CRD = "services.serving.knative.dev";

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
}

/**
 * Default loadAppConfig: the real cwd loader. ANY failure — no config in this
 * directory, a config that does not validate — yields undefined: doctor
 * diagnoses, it must never crash on the state it is diagnosing.
 */
async function loadAppConfigOrUndefined(): Promise<
    KnativeNextConfig | undefined
> {
    try {
        return await loadConfig();
    } catch {
        return undefined;
    }
}

/** Production kubectl runner — spawnSync, shell:false, never throws. */
export function kubectlRunner(args: readonly string[]): KubectlResult {
    const r = spawnSync("kubectl", args.slice(1), {
        shell: false,
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
    });
    // args[0] is the literal "kubectl" (kept in the argv for test-stub clarity).
    return {
        ok: r.status === 0,
        stdout: (r.stdout ?? "").toString(),
        stderr: (r.stderr ?? "").toString(),
    };
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

// Deliberately conservative signature lists — over-matching across kubectl
// versions would misreport real cluster-state facts as probe errors.
const NOT_FOUND_SIGNATURES = [
    /\(NotFound\)/,
    /\bnot found\b/i,
    /doesn't have a resource type/,
];
const NETWORK_SIGNATURES = [
    /connection refused/i,
    /connection to the server .* was refused/i,
    /TLS handshake/i,
    /i\/o timeout/i,
];
const AUTH_SIGNATURES = [
    /getting credentials: exec/,
    /\(Unauthorized\)/,
    /You must be logged in to the server/,
];
// kubectl/apiserver literals only: `Error from server (Forbidden): …` and the
// apiserver Status message `<resource> is forbidden: User "u" cannot …`.
// Loose prose containing "forbidden" deliberately stays "unknown".
const FORBIDDEN_SIGNATURES = [/\(Forbidden\)/, /forbidden: User/];

/** Classify a failed kubectl call's stderr. Ambiguity → "unknown". */
export function classifyKubectlFailure(stderr: string): KubectlFailureClass {
    // A NotFound answer implies the apiserver responded — it wins so genuine
    // cluster-state facts are never reclassified as probe errors.
    if (NOT_FOUND_SIGNATURES.some((re) => re.test(stderr))) return "not-found";
    if (FORBIDDEN_SIGNATURES.some((re) => re.test(stderr))) return "forbidden";
    if (AUTH_SIGNATURES.some((re) => re.test(stderr))) return "auth";
    if (NETWORK_SIGNATURES.some((re) => re.test(stderr))) return "network";
    return "unknown";
}

interface InfraFailure {
    /** Detail line: failure class + a bounded stderr excerpt. */
    detail: string;
    /** One-line repair hint for the human table / JSON consumers. */
    hint: string;
}

/**
 * Map a failed kubectl result to an ERROR payload when (and only when) the
 * stderr carries a clearly-infrastructural signature; undefined otherwise so
 * the caller keeps its legacy (not-found / warn) branch.
 */
function infraFailure(r: KubectlResult): InfraFailure | undefined {
    const cls = classifyKubectlFailure(r.stderr);
    if (cls !== "network" && cls !== "auth" && cls !== "forbidden")
        return undefined;
    // Scrub → collapse → cap. The excerpt comes from raw kubectl stderr, so it
    // gets the same printable-ASCII whitelist as the RBAC resource token below
    // (P6c nit): drop control bytes (ANSI escapes, BEL, ...) BEFORE collapsing
    // whitespace and capping, so a detail line never re-emits terminal escape
    // sequences and control bytes never eat the 160-char budget.
    const detailExcerpt = excerpt(r.stderr.replace(/[^\x20-\x7e\s]/g, ""));
    if (cls === "forbidden") {
        // The apiserver names the denied resource in its Status message
        // (`<resource> is forbidden: …`); fall back to a generic phrase when
        // the stderr carries only the bare (Forbidden) marker. The token comes
        // from raw stderr, so sanitize it before embedding: strip
        // non-printables (ANSI escapes etc.) and cap the length — a garbled
        // stderr must never produce an escape-laden or unbounded hint line.
        const rawToken = /(\S+) is forbidden:/.exec(r.stderr)?.[1] ?? "";
        const resource =
            rawToken.replace(/[^\x21-\x7e]/g, "").slice(0, 80) ||
            "the probed resource";
        return {
            detail: `probe failed (rbac): ${detailExcerpt}`,
            hint: `insufficient RBAC — ask a cluster admin for get/list on ${resource}`,
        };
    }
    return cls === "auth"
        ? {
              detail: `probe failed (auth): ${detailExcerpt}`,
              hint: "credentials failed — re-authenticate (refresh your kubeconfig token) and retry",
          }
        : {
              detail: `probe failed (network): ${detailExcerpt}`,
              hint: "cluster connection flaked — check network/VPN and retry",
          };
}

/** What the LOCAL kubeconfig says, before any network I/O (finding 1c). */
export type KubeconfigState =
    | { kind: "absent"; searched: readonly string[] }
    | { kind: "no-current-context"; path: string }
    | { kind: "has-current-context" };

export type KubeconfigInspectFn = () => KubeconfigState;

/**
 * Default kubeconfig inspector: pure local file reads — no kubectl (the
 * read-only get/version verb contract holds) and no network. Mirrors
 * kubectl's merge rule for $KUBECONFIG lists: any listed file that sets a
 * non-empty current-context wins. A config that cannot be parsed NEVER
 * claims "no cluster" — misdiagnosing a real cluster as absent is worse
 * than the generic unreachable message, so parse failures report
 * has-current-context and the caller keeps the legacy path.
 */
export function inspectKubeconfig(): KubeconfigState {
    const env = process.env.KUBECONFIG;
    const searched = env?.length
        ? env.split(delimiter).filter((p) => p.length > 0)
        : [join(homedir(), ".kube", "config")];
    const existing = searched.filter((p) => existsSync(p));
    const first = existing[0];
    if (first === undefined) {
        return { kind: "absent", searched };
    }
    for (const path of existing) {
        try {
            const parsed = parseYaml(readFileSync(path, "utf-8")) as
                | { "current-context"?: unknown }
                | null
                | undefined;
            const ctx = parsed?.["current-context"];
            if (typeof ctx === "string" && ctx.length > 0) {
                return { kind: "has-current-context" };
            }
        } catch {
            return { kind: "has-current-context" };
        }
    }
    return { kind: "no-current-context", path: first };
}

const GETTING_STARTED_URL = `${DOCS_URL}/docs/getting-started`;

/** The persona-plain hint for every no-cluster-configured state (finding 1c). */
const NO_CLUSTER_HINT = `you don't have a Kubernetes cluster connected yet — kn-next deploys into one; follow ${GETTING_STARTED_URL} to get set up, then re-run doctor`;

/**
 * A refused dial on an address that can only be THIS machine. Anchored on
 * start / whitespace / "/" rather than \b: a word boundary can never precede
 * "[", which made the [::1] alternative unmatchable (review-ux3 issue 1).
 */
const LOCAL_APISERVER_RE =
    /(?:^|[\s/])((?:127\.0\.0\.1|0\.0\.0\.0|localhost|\[::1\]):\d+)/;

interface NoClusterDiagnosis {
    detail: string;
    hint: string;
}

/**
 * Finding 1c: distinguish the no-cluster-configured states from a real
 * reachability flake. Returns undefined when the failure could plausibly be
 * a genuine remote cluster having a bad day — the caller then keeps the
 * legacy "connection flaked" hint. Callers must NOT invoke this for
 * auth/forbidden-classified failures (#230): those imply a configured
 * cluster and keep their more specific hints.
 */
export function diagnoseNoCluster(
    stderr: string,
    state: KubeconfigState,
): NoClusterDiagnosis | undefined {
    if (state.kind === "absent") {
        return {
            detail: `no kubeconfig found (searched: ${state.searched.join(", ")}) — you don't have a Kubernetes cluster connected yet; all cluster checks skipped`,
            hint: NO_CLUSTER_HINT,
        };
    }
    if (state.kind === "no-current-context") {
        return {
            detail: `kubeconfig ${state.path} sets no current-context — you don't have a Kubernetes cluster connected yet; all cluster checks skipped`,
            hint: NO_CLUSTER_HINT,
        };
    }
    const local = LOCAL_APISERVER_RE.exec(stderr);
    if (local?.[1] && /refused/i.test(stderr)) {
        return {
            detail: `connection refused at ${local[1]} — an address on THIS machine, usually a leftover local cluster (kind/minikube/OrbStack/k3d) that is not running; all cluster checks skipped`,
            hint: `your kubeconfig points at a local address with nothing listening — restart that local cluster (or the tunnel that used to forward this port), or follow ${GETTING_STARTED_URL} to connect a different cluster`,
        };
    }
    return undefined;
}

function safeJson<T>(raw: string): T | undefined {
    try {
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
}

interface DeploymentJson {
    metadata?: { name?: string };
    spec?: { template?: { spec?: { containers?: { image?: string }[] } } };
    status?: { readyReplicas?: number; replicas?: number };
}

function isReady(d: DeploymentJson | undefined): boolean {
    return (d?.status?.readyReplicas ?? 0) >= 1;
}

/** Split an image ref into registry / repository / reference (tag or digest). */
export function parseImageRef(image: string): {
    registry: string;
    repository: string;
    reference: string;
} {
    // digest wins over tag when both are present (name:tag@sha256:…)
    let rest = image;
    let reference = "latest";
    const atIdx = rest.indexOf("@");
    if (atIdx !== -1) {
        reference = rest.slice(atIdx + 1);
        rest = rest.slice(0, atIdx);
    }
    // a colon after the last slash is a tag (not a registry port)
    const lastSlash = rest.lastIndexOf("/");
    const colonIdx = rest.indexOf(":", lastSlash + 1);
    if (atIdx === -1 && colonIdx !== -1) {
        reference = rest.slice(colonIdx + 1);
        rest = rest.slice(0, colonIdx);
    } else if (atIdx !== -1 && colonIdx !== -1) {
        // tag present alongside digest — strip it, keep the digest reference
        rest = rest.slice(0, colonIdx);
    }
    // Registry host = first path segment when it looks like a host (dot/port/localhost)
    const firstSlash = rest.indexOf("/");
    let registry = "registry-1.docker.io";
    let repository = rest;
    if (firstSlash !== -1) {
        const head = rest.slice(0, firstSlash);
        if (head.includes(".") || head.includes(":") || head === "localhost") {
            registry = head;
            repository = rest.slice(firstSlash + 1);
        }
    }
    if (registry === "registry-1.docker.io" && !repository.includes("/")) {
        repository = `library/${repository}`;
    }
    return { registry, repository, reference };
}

/**
 * Production manifest probe: pull-secret-less HEAD of the manifest, with the
 * anonymous token dance for registries (ghcr/docker.io) that 401 first. Any
 * network-level failure maps to "unreachable" so the check SKIPs offline.
 */
export async function probeManifest(image: string): Promise<ProbeOutcome> {
    const { registry, repository, reference } = parseImageRef(image);
    const manifestUrl = `https://${registry}/v2/${encodeURIComponent(repository).replace(/%2F/g, "/")}/manifests/${reference}`;
    const accept = [
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    ].join(", ");
    // Every fetch is bounded: a stalling registry must degrade to the
    // "unreachable" SKIP path within 10s, not hang doctor toward undici's
    // multi-minute defaults. AbortSignal.timeout rejects -> the catch below.
    const probeTimeoutMs = 10_000;
    try {
        let res = await fetch(manifestUrl, {
            method: "HEAD",
            headers: { Accept: accept },
            signal: AbortSignal.timeout(probeTimeoutMs),
        });
        if (res.status === 401) {
            // Anonymous token flow (ghcr.io / registry-1.docker.io style).
            const challenge = res.headers.get("www-authenticate") ?? "";
            const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
            const service = /service="([^"]+)"/.exec(challenge)?.[1];
            if (realm) {
                const tokenUrl = `${realm}?${service ? `service=${encodeURIComponent(service)}&` : ""}scope=${encodeURIComponent(`repository:${repository}:pull`)}`;
                const tokenRes = await fetch(tokenUrl, {
                    signal: AbortSignal.timeout(probeTimeoutMs),
                });
                if (tokenRes.ok) {
                    const body = (await tokenRes.json()) as {
                        token?: string;
                        access_token?: string;
                    };
                    const token = body.token ?? body.access_token;
                    if (token) {
                        res = await fetch(manifestUrl, {
                            method: "HEAD",
                            headers: {
                                Accept: accept,
                                Authorization: `Bearer ${token}`,
                            },
                            signal: AbortSignal.timeout(probeTimeoutMs),
                        });
                    }
                }
            }
        }
        if (res.ok) return "ok";
        if (res.status === 401 || res.status === 403) return "auth-required";
        if (res.status === 404) return "not-found";
        return "unreachable";
    } catch {
        return "unreachable";
    }
}

const SKIP_UNREACHABLE = "cluster unreachable — check skipped";

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

/**
 * Parse `kubectl version --client -o json` into {major, minor}.
 *
 * Prefers `clientVersion.gitVersion` ("v1.29.3-eks-a1b2c3") and falls back to
 * the discrete major/minor fields, which on managed distros carry a `+` suffix
 * ("29+"). Returns undefined when nothing numeric can be read — the caller then
 * WARNs rather than guessing.
 */
export function parseKubectlClientVersion(
    stdout: string,
): { major: number; minor: number; display: string } | undefined {
    const parsed = safeJson<{
        clientVersion?: { major?: string; minor?: string; gitVersion?: string };
    }>(stdout);
    const cv = parsed?.clientVersion;
    if (!cv) {
        return undefined;
    }
    const git = cv.gitVersion ?? "";
    const m = /^v?(\d+)\.(\d+)/.exec(git);
    if (m?.[1] && m[2]) {
        return {
            major: Number(m[1]),
            minor: Number(m[2]),
            display: git,
        };
    }
    // Fallback: discrete fields; strip the managed-distro "+"/non-digit tail.
    const major = Number.parseInt(cv.major ?? "", 10);
    const minor = Number.parseInt(cv.minor ?? "", 10);
    if (Number.isNaN(major) || Number.isNaN(minor)) {
        return undefined;
    }
    return { major, minor, display: git || `v${major}.${minor}` };
}

/** True iff this client understands `--validate=strict` (>= v1.25). */
export function supportsStrictValidation(v: {
    major: number;
    minor: number;
}): boolean {
    const { major, minor } = MIN_STRICT_VALIDATION_KUBECTL;
    return v.major > major || (v.major === major && v.minor >= minor);
}

/** Run every preflight check. Pure orchestration over the injected deps. */
/**
 * CNI NetworkPolicy-enforcement classification (#744).
 *
 * The operator reconciles a default-on NetworkPolicy, but enforcement is the
 * CNI's job — flannel (OKE GA, OrbStack) ships no NetworkPolicy controller,
 * so there the policy is declarative only. There is no Kubernetes API that
 * answers "is NetworkPolicy enforced", and an active probe would mutate the
 * cluster (doctor is read-only), so detection is signature-based over the
 * cluster's DaemonSets and HONEST about its confidence: a known
 * policy-controller DaemonSet => "enforced"; flannel alone =>
 * "likely-unenforced"; anything else => "unknown", which callers must treat
 * as unenforced, never as enforced.
 *
 * The operator carries the same signature table
 * (internal/controller/netpol_enforcement.go) into the NextApp's
 * NetworkPolicyEnforced status condition — keep the two in sync when adding
 * a CNI.
 */
export type CNIEnforcement = "enforced" | "likely-unenforced" | "unknown";

export interface DaemonSetRef {
    namespace: string;
    name: string;
}

/** DaemonSet names of NetworkPolicy-ENFORCING agents (exact matches). */
const ENFORCING_AGENT_DS: Readonly<Record<string, string>> = {
    "calico-node": "Calico",
    cilium: "Cilium",
    "kube-router": "kube-router",
    "weave-net": "Weave Net",
    "antrea-agent": "Antrea",
    canal: "Canal (Calico policy)",
};

/**
 * Pure classification seam: any enforcing agent wins (canal clusters also run
 * a flannel DaemonSet); flannel alone is likely-unenforced; nothing
 * recognized is unknown. Evidence is sorted so the same cluster always yields
 * the same string.
 */
export function classifyCNIEnforcement(daemonSets: readonly DaemonSetRef[]): {
    verdict: CNIEnforcement;
    evidence: string;
} {
    const enforcing: string[] = [];
    const flannel: string[] = [];
    for (const ds of daemonSets) {
        const cni = ENFORCING_AGENT_DS[ds.name];
        if (cni) {
            enforcing.push(`${cni} DaemonSet ${ds.name} (${ds.namespace})`);
        } else if (ds.name.includes("flannel")) {
            flannel.push(`flannel DaemonSet ${ds.name} (${ds.namespace})`);
        }
    }
    if (enforcing.length > 0) {
        return { verdict: "enforced", evidence: enforcing.sort().join("; ") };
    }
    if (flannel.length > 0) {
        return {
            verdict: "likely-unenforced",
            evidence: flannel.sort().join("; "),
        };
    }
    return { verdict: "unknown", evidence: "" };
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
    const checks: CheckResult[] = [];
    const push = (
        id: string,
        title: string,
        status: CheckStatus,
        detail: string,
        hint?: string,
    ) => checks.push({ id, title, status, detail, ...(hint ? { hint } : {}) });

    // Gate: is the apiserver reachable at all? A failed gate keeps the
    // documented degrade path (WARN + all checks SKIP, exit 0) — but #230:
    // when the failure is clearly credentials, say so instead of leaving the
    // user to guess from "unreachable".
    const version = deps.kubectl(["kubectl", "get", "--raw", "/version"]);
    const reachable = version.ok;
    if (reachable) {
        push("cluster", "Cluster reachable", "pass", "apiserver responded");
    } else {
        // #230 keeps precedence: auth/RBAC-classified failures imply a
        // configured cluster, so they keep their specific hints. Everything
        // else consults the LOCAL kubeconfig (finding 1c) before falling
        // back to the flake hint.
        const cls = classifyKubectlFailure(version.stderr);
        const noCluster =
            cls === "auth" || cls === "forbidden"
                ? undefined
                : diagnoseNoCluster(
                      version.stderr,
                      (deps.inspectKubeconfig ?? inspectKubeconfig)(),
                  );
        push(
            "cluster",
            "Cluster reachable",
            "warn",
            noCluster?.detail ??
                `apiserver unreachable (${version.stderr.trim().slice(0, 120) || "no kubectl context?"}) — all cluster checks skipped`,
            noCluster?.hint ?? infraFailure(version)?.hint,
        );
    }
    const skipAll = !reachable;

    // (g) client kubectl strict-validation support. LOCAL and read-only, so it
    // runs even when the cluster is unreachable (it never touches the
    // apiserver). `kn-next deploy` applies the NextApp CR with an explicit
    // `--validate=strict` so a field the operator's CRD does not know is
    // REJECTED instead of silently pruned; on kubectl < v1.25 that flag value
    // does not exist, so the deploy cannot make that guarantee.
    {
        const ver = deps.kubectl([
            "kubectl",
            "version",
            "--client",
            "-o",
            "json",
        ]);
        const parsed = ver.ok
            ? parseKubectlClientVersion(ver.stdout)
            : undefined;
        if (!parsed) {
            push(
                "kubectl-validation",
                "kubectl strict validation",
                "warn",
                "could not determine the kubectl client version — unable to confirm that the CR apply can be strictly validated",
                "run `kubectl version --client` and upgrade to >= v1.25 if older",
            );
        } else if (supportsStrictValidation(parsed)) {
            push(
                "kubectl-validation",
                "kubectl strict validation",
                "pass",
                `client ${parsed.display} — the CR apply asserts --validate=strict (unknown fields are rejected, never silently pruned)`,
            );
        } else {
            push(
                "kubectl-validation",
                "kubectl strict validation",
                "fail",
                `client ${parsed.display} is older than v${MIN_STRICT_VALIDATION_KUBECTL.major}.${MIN_STRICT_VALIDATION_KUBECTL.minor} — before v1.25 --validate is a BOOLEAN, so \`kn-next deploy\` fails on this client at flag parsing, before it contacts the apiserver. Upgrade kubectl`,
                `upgrade kubectl to >= v${MIN_STRICT_VALIDATION_KUBECTL.major}.${MIN_STRICT_VALIDATION_KUBECTL.minor}`,
            );
        }
    }

    // (h) static-asset mode (ADR-0047) — LOCAL and read-only, so it runs even
    // when the cluster is unreachable. Both modes are healthy states, so both
    // are "pass": the value is that the mode is STATED where the user looks,
    // never inferred from what happens to be in the config.
    {
        const appConfig = await (
            deps.loadAppConfig ?? loadAppConfigOrUndefined
        )();
        if (!appConfig) {
            push(
                "storage-mode",
                "Static asset mode",
                "skip",
                "no kn-next.config.ts in this directory — run doctor from the app directory to see how its static assets will be served",
            );
        } else if (appConfig.storage) {
            push(
                "storage-mode",
                "Static asset mode",
                "pass",
                `object storage configured (${appConfig.storage.provider}: ${appConfig.storage.bucket}) — assets are offloaded to the bucket and retained across deploys`,
            );
        } else {
            push(
                "storage-mode",
                "Static asset mode",
                "pass",
                "no object storage configured — static assets are served from the image (no CDN offload, no cross-deploy asset retention)",
                `add a storage block when you need the offload path: ${NO_STORAGE_DOCS_URL}`,
            );
        }
    }

    // (a) NextApp CRD present + served version
    if (skipAll) {
        push("crd", "NextApp CRD", "skip", SKIP_UNREACHABLE);
    } else {
        const crd = deps.kubectl([
            "kubectl",
            "get",
            "crd",
            NEXTAPP_CRD,
            "-o",
            "json",
        ]);
        const crdInfra = crd.ok ? undefined : infraFailure(crd);
        if (crdInfra) {
            push("crd", "NextApp CRD", "error", crdInfra.detail, crdInfra.hint);
        } else if (!crd.ok) {
            push(
                "crd",
                "NextApp CRD",
                "fail",
                `${NEXTAPP_CRD} not found — install the operator bundle (kubectl apply --server-side -f install.yaml)`,
            );
        } else {
            const parsed = safeJson<{
                spec?: { versions?: { name?: string; served?: boolean }[] };
            }>(crd.stdout);
            const served = (parsed?.spec?.versions ?? []).filter(
                (v) => v.served,
            );
            if (served.length === 0) {
                push(
                    "crd",
                    "NextApp CRD",
                    "fail",
                    `${NEXTAPP_CRD} exists but serves no version — reinstall the operator bundle`,
                );
            } else {
                push(
                    "crd",
                    "NextApp CRD",
                    "pass",
                    `served version: ${served.map((v) => v.name).join(", ")}`,
                );
            }
        }
    }

    // (a2) NextApp CRD SCHEMA COVERAGE (#314, T6) — the question check (a)
    // cannot answer. "The CRD exists and serves v1alpha1" is green on exactly
    // the cluster this exists for: one whose CRD is installed, served, and
    // OLDER than this CLI. What matters is whether the installed schema defines
    // every field this CLI can emit — and the emitted set is DERIVED BY
    // SCANNING cr-builder.ts (schema/emitted-fields.generated.ts), not
    // enumerated, so it cannot go stale silently.
    //
    // This is DIAGNOSIS. The verdict lives in `kn-next deploy`'s server-side
    // dry-run apply, which needs no read at all — so when both schema reads are
    // denied, doctor SKIPS (visibly) rather than failing. Failing here would
    // punish a restricted kubeconfig for a diagnosis it cannot run, which is
    // the RBAC tension D-3 dissolves rather than re-creates.
    if (skipAll) {
        push(
            "crd-schema",
            "NextApp CRD schema coverage",
            "skip",
            SKIP_UNREACHABLE,
        );
    } else {
        const read = readKnownCRDFields(deps.kubectl);
        if (!read.known) {
            push(
                "crd-schema",
                "NextApp CRD schema coverage",
                "skip",
                `${read.detail} — diagnosis only; \`kn-next deploy\` still verifies this cluster with a server-side dry-run apply, which needs no extra permission`,
                "optional: grant `get customresourcedefinitions` (or access to /openapi/v3) for a named-field diagnosis here",
            );
        } else {
            const missing = unknownEmittedFields(
                EMITTED_CR_FIELD_PATHS,
                read.known,
            );
            if (missing.length === 0) {
                push(
                    "crd-schema",
                    "NextApp CRD schema coverage",
                    "pass",
                    `all ${EMITTED_CR_FIELD_PATHS.length} field(s) this CLI emits are defined by the installed CRD (${read.detail})`,
                );
            } else {
                push(
                    "crd-schema",
                    "NextApp CRD schema coverage",
                    "fail",
                    `the installed NextApp CRD does not define ${missing.length} field(s) this CLI emits: ${missing.join(", ")} — a deploy setting one of them is rejected (or, without strict validation, SILENTLY PRUNED). Source: ${read.detail}`,
                    "upgrade the operator/CRD FIRST, then the CLI (docs/RELEASING.md)",
                );
            }
        }
    }

    // (b) operator Deployment Ready — also yields the image for check (e).
    let operatorImage: string | undefined;
    if (skipAll) {
        push("operator", "Operator deployment", "skip", SKIP_UNREACHABLE);
    } else {
        const deps_ = deps.kubectl([
            "kubectl",
            "get",
            "deployments",
            "-n",
            OPERATOR_NAMESPACE,
            "-o",
            "json",
        ]);
        const items = deps_.ok
            ? (safeJson<{ items?: DeploymentJson[] }>(deps_.stdout)?.items ??
              [])
            : [];
        const opInfra = deps_.ok ? undefined : infraFailure(deps_);
        if (opInfra) {
            push(
                "operator",
                "Operator deployment",
                "error",
                opInfra.detail,
                opInfra.hint,
            );
        } else if (!deps_.ok || items.length === 0) {
            push(
                "operator",
                "Operator deployment",
                "fail",
                `no Deployment found in ${OPERATOR_NAMESPACE} — install the operator bundle`,
            );
        } else {
            const manager =
                items.find((d) =>
                    (d.metadata?.name ?? "").includes("controller-manager"),
                ) ?? items[0];
            operatorImage =
                manager.spec?.template?.spec?.containers?.[0]?.image;
            if (isReady(manager)) {
                push(
                    "operator",
                    "Operator deployment",
                    "pass",
                    `${manager.metadata?.name} Ready in ${OPERATOR_NAMESPACE}`,
                );
            } else {
                push(
                    "operator",
                    "Operator deployment",
                    "fail",
                    `${manager.metadata?.name} is not Ready (readyReplicas=0) — kubectl describe deploy -n ${OPERATOR_NAMESPACE} (ImagePullBackOff? see the image check)`,
                );
            }
        }
    }

    // (c) cert-manager webhook prereq
    if (skipAll) {
        push("cert-manager", "cert-manager webhook", "skip", SKIP_UNREACHABLE);
    } else {
        const cm = deps.kubectl([
            "kubectl",
            "get",
            "deployment",
            "cert-manager-webhook",
            "-n",
            "cert-manager",
            "-o",
            "json",
        ]);
        const cmInfra = cm.ok ? undefined : infraFailure(cm);
        if (cmInfra) {
            push(
                "cert-manager",
                "cert-manager webhook",
                "error",
                cmInfra.detail,
                cmInfra.hint,
            );
        } else if (!cm.ok) {
            push(
                "cert-manager",
                "cert-manager webhook",
                "warn",
                "cert-manager-webhook not found — the operator bundle includes webhook Certificates that need cert-manager installed",
            );
        } else if (isReady(safeJson<DeploymentJson>(cm.stdout))) {
            push(
                "cert-manager",
                "cert-manager webhook",
                "pass",
                "cert-manager-webhook Ready",
            );
        } else {
            push(
                "cert-manager",
                "cert-manager webhook",
                "fail",
                "cert-manager-webhook exists but is not Ready",
            );
        }
    }

    // (d) ingress-class vs serving reconciler (#208)
    if (skipAll) {
        push("ingress", "Knative ingress-class", "skip", SKIP_UNREACHABLE);
    } else {
        const cm = deps.kubectl([
            "kubectl",
            "get",
            "configmap",
            "config-network",
            "-n",
            "knative-serving",
            "-o",
            "json",
        ]);
        const cnInfra = cm.ok ? undefined : infraFailure(cm);
        if (cnInfra) {
            push(
                "ingress",
                "Knative ingress-class",
                "error",
                cnInfra.detail,
                cnInfra.hint,
            );
        } else if (!cm.ok) {
            push(
                "ingress",
                "Knative ingress-class",
                "fail",
                "configmap config-network not found in knative-serving — is Knative Serving installed?",
            );
        } else {
            const data =
                safeJson<{ data?: Record<string, string> }>(cm.stdout)?.data ??
                {};
            const ingressClass =
                data["ingress-class"] ??
                data["ingress.class"] ??
                "istio.ingress.networking.knative.dev";

            // Does a kourier reconciler exist? (controller ships in
            // knative-serving on current installs, kourier-system on older
            // ones). #230: a probe-infra failure here must not be read as
            // "no reconciler exists" — track it and error out below.
            let kourierReady = false;
            let kourierInfra: InfraFailure | undefined;
            for (const ns of ["knative-serving", "kourier-system"]) {
                const d = deps.kubectl([
                    "kubectl",
                    "get",
                    "deployment",
                    "net-kourier-controller",
                    "-n",
                    ns,
                    "-o",
                    "json",
                ]);
                if (d.ok && isReady(safeJson<DeploymentJson>(d.stdout))) {
                    kourierReady = true;
                    break;
                }
                if (!d.ok) kourierInfra ??= infraFailure(d);
            }

            if (!kourierReady && kourierInfra) {
                push(
                    "ingress",
                    "Knative ingress-class",
                    "error",
                    `${kourierInfra.detail} — kourier-reconciler presence could not be verified`,
                    kourierInfra.hint,
                );
            } else if (ingressClass === KOURIER_INGRESS_CLASS && kourierReady) {
                push(
                    "ingress",
                    "Knative ingress-class",
                    "pass",
                    `ingress-class ${ingressClass} is served by net-kourier-controller`,
                );
            } else if (ingressClass === KOURIER_INGRESS_CLASS) {
                push(
                    "ingress",
                    "Knative ingress-class",
                    "fail",
                    `ingress-class is ${ingressClass} but no Ready net-kourier-controller deployment was found — no reconciler serves this class, routes will never program`,
                );
            } else if (kourierReady) {
                push(
                    "ingress",
                    "Knative ingress-class",
                    "warn",
                    `config-network ingress-class is "${ingressClass}" but net-kourier serves "${KOURIER_INGRESS_CLASS}" — KIngresses will be silently skipped (routes never program, no error surfaced; #208). Fix the class where it is AUTHORED: if a KnativeServing CR manages this cluster, set it there — editing the ConfigMap directly gets clobbered by the KnativeServing operator.`,
                );
            } else {
                push(
                    "ingress",
                    "Knative ingress-class",
                    "warn",
                    `ingress-class is "${ingressClass}" and no net-kourier reconciler was found — verify a networking layer serving this class is installed (knext installs pin Kourier)`,
                );
            }
        }
    }

    // (e) operator image pullability (#198)
    if (skipAll || !operatorImage) {
        push(
            "image",
            "Operator image pullable",
            "skip",
            skipAll
                ? SKIP_UNREACHABLE
                : "no operator image ref resolved (operator check failed) — skipped",
        );
    } else {
        const outcome = await deps.probeImage(operatorImage);
        switch (outcome) {
            case "ok":
                push(
                    "image",
                    "Operator image pullable",
                    "pass",
                    `${operatorImage} is anonymously pullable`,
                );
                break;
            case "auth-required":
                push(
                    "image",
                    "Operator image pullable",
                    "warn",
                    `${operatorImage} is NOT anonymously pullable — fresh nodes need an imagePullSecret, or the registry package must be public (#198)`,
                );
                break;
            case "not-found":
                push(
                    "image",
                    "Operator image pullable",
                    "fail",
                    `${operatorImage} does not exist on the registry — the running pods hold a cached image that new nodes cannot pull`,
                );
                break;
            default:
                push(
                    "image",
                    "Operator image pullable",
                    "skip",
                    "registry unreachable (offline?) — pullability not verified",
                );
        }
    }

    // (f) Knative Serving present
    if (skipAll) {
        push("knative", "Knative Serving", "skip", SKIP_UNREACHABLE);
    } else {
        const ksvc = deps.kubectl([
            "kubectl",
            "get",
            "crd",
            KSVC_CRD,
            "-o",
            "json",
        ]);
        const ksvcInfra = ksvc.ok ? undefined : infraFailure(ksvc);
        if (ksvc.ok) {
            push(
                "knative",
                "Knative Serving",
                "pass",
                `${KSVC_CRD} CRD present`,
            );
        } else if (ksvcInfra) {
            push(
                "knative",
                "Knative Serving",
                "error",
                ksvcInfra.detail,
                ksvcInfra.hint,
            );
        } else {
            push(
                "knative",
                "Knative Serving",
                "fail",
                `${KSVC_CRD} not found — install Knative Serving + Kourier (see docs/QUICKSTART.md prerequisites)`,
            );
        }
    }

    // (i) CNI NetworkPolicy enforcement (#744). The operator reconciles a
    // default-on NetworkPolicy for every app, but flannel — which OKE GA and
    // OrbStack both run — ships no NetworkPolicy controller, so there the
    // policy is written yet enforces nothing. Detection is read-only
    // (DaemonSet signatures; doctor never launches probe pods) and fails
    // honest: "cannot determine" is a distinct outcome from "enforced",
    // never folded into it.
    if (skipAll) {
        push("netpol", "NetworkPolicy enforcement", "skip", SKIP_UNREACHABLE);
    } else {
        const ds = deps.kubectl([
            "kubectl",
            "get",
            "daemonsets",
            "--all-namespaces",
            "-o",
            "json",
        ]);
        const dsInfra = ds.ok ? undefined : infraFailure(ds);
        if (!ds.ok && classifyKubectlFailure(ds.stderr) === "forbidden") {
            // A denied read is "cannot determine", not an infra ERROR: the
            // check is diagnosis, and the honest fallback — treat as
            // unenforced — holds with or without the permission.
            push(
                "netpol",
                "NetworkPolicy enforcement",
                "warn",
                "cannot determine whether the cluster's CNI enforces NetworkPolicy (listing DaemonSets was denied by RBAC) — treat the operator's NetworkPolicy as UNENFORCED until verified",
                "grant `list daemonsets` cluster-wide for this diagnosis, or verify your CNI's NetworkPolicy support manually",
            );
        } else if (dsInfra) {
            push(
                "netpol",
                "NetworkPolicy enforcement",
                "error",
                dsInfra.detail,
                dsInfra.hint,
            );
        } else {
            const items = ds.ok
                ? (safeJson<{
                      items?: {
                          metadata?: { name?: string; namespace?: string };
                      }[];
                  }>(ds.stdout)?.items ?? [])
                : [];
            const refs: DaemonSetRef[] = items.map((i) => ({
                name: i.metadata?.name ?? "",
                namespace: i.metadata?.namespace ?? "",
            }));
            const { verdict, evidence } = classifyCNIEnforcement(refs);
            if (verdict === "enforced") {
                push(
                    "netpol",
                    "NetworkPolicy enforcement",
                    "pass",
                    `a NetworkPolicy-enforcing agent is running (${evidence}) — the operator's default-on NetworkPolicy is enforced on this cluster`,
                );
            } else if (verdict === "likely-unenforced") {
                push(
                    "netpol",
                    "NetworkPolicy enforcement",
                    "warn",
                    `flannel is the cluster CNI (${evidence}) and no NetworkPolicy controller was detected — the operator still writes its default-on NetworkPolicy, but it is declarative only: it enforces NOTHING on this cluster (OKE GA and OrbStack both run flannel), so treat network isolation as absent`,
                    "install a policy-capable CNI (Calico or Cilium) to make the NetworkPolicy effective",
                );
            } else {
                push(
                    "netpol",
                    "NetworkPolicy enforcement",
                    "warn",
                    "cannot determine whether the cluster's CNI enforces NetworkPolicy (no known CNI DaemonSet signature found) — treat the operator's NetworkPolicy as UNENFORCED until verified",
                    "verify your CNI's NetworkPolicy support manually; a policy written but not enforced provides no isolation",
                );
            }
        }
    }

    // ERRORs exit nonzero like FAILs (#230): an errored probe means the
    // preflight could NOT verify the cluster — reporting green would be a lie.
    const exitCode = checks.some(
        (c) => c.status === "fail" || c.status === "error",
    )
        ? 1
        : 0;
    return { checks, exitCode };
}

const STATUS_LABEL: Record<CheckStatus, string> = {
    pass: "PASS",
    warn: "WARN",
    fail: "FAIL",
    skip: "SKIP",
    error: "ERROR",
};

/** Render the human table (one status-tagged row per check, + repair hint). */
export function formatDoctorTable(checks: readonly CheckResult[]): string {
    const titleWidth = Math.max(...checks.map((c) => c.title.length), 5);
    const rows = checks.map(
        (c) =>
            `${STATUS_LABEL[c.status]}  ${c.title.padEnd(titleWidth)}  ${c.detail}${c.hint ? ` (hint: ${c.hint})` : ""}`,
    );
    return `${rows.join("\n")}\n`;
}

export interface DoctorArgs {
    json: boolean;
    help: boolean;
}

export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
    // Unknown flags fail loudly (a typo like `--jsno` must not silently run
    // the human-table mode a script then fails to parse).
    for (const a of argv) {
        if (a !== "--json" && a !== "-h" && a !== "--help") {
            throw new UsageError(
                `unknown argument "${a}" (see kn-next doctor --help)`,
            );
        }
    }
    return {
        json: argv.includes("--json"),
        help: argv.includes("-h") || argv.includes("--help"),
    };
}

const DOCTOR_HELP = `kn-next doctor — cluster-prereq preflight (read-only)

Checks: NextApp CRD, operator readiness, cert-manager webhook, Knative
ingress-class vs its reconciler (#208), operator-image pullability (#198),
Knative Serving, CNI NetworkPolicy enforcement (whether the cluster can\nenforce the operator's default-on policy — on flannel it cannot), and the\nlocal kubectl's --validate=strict support. Exit 1 on
hard FAILs and on probe ERRORs (a check's kubectl
probe hit a network/TLS/credential/RBAC failure — the cluster state could not
be verified); WARN/SKIP never fail; a fully unreachable cluster SKIPs (exit 0).
A missing/empty kubeconfig, or a refused dial on a local-only apiserver
address, is reported plainly as "no cluster connected yet" (with the
getting-started guide), never as a network flake.

Options:
  --json      Emit the check results as JSON
  -h, --help  Show this help
`;

/**
 * Entry for `kn-next doctor`. Returns the process exit code.
 *
 * `deps` defaults to the production kubectl runner + registry probe; tests
 * inject fakes so the unit suite never shells out to a real kubectl or dials
 * a real registry (a real probe cost ~7s of connection timeouts under CI
 * load and flaked the 5s test budget).
 */
export async function doctorMain(
    argv: readonly string[],
    deps: DoctorDeps = { kubectl: kubectlRunner, probeImage: probeManifest },
): Promise<number> {
    const args = parseDoctorArgs(argv);
    if (args.help) {
        writeSync(1, DOCTOR_HELP);
        return 0;
    }
    const report = await runDoctor(deps);
    if (args.json) {
        writeSync(1, `${JSON.stringify(report, null, 2)}\n`);
    } else {
        writeSync(1, formatDoctorTable(report.checks));
    }
    return report.exitCode;
}

// NO self-entry block here, DELIBERATELY — this module is reached ONLY via
// the kn-next bin's subcommand dispatch (see the hazard note atop deploy.ts's
// dispatcher: an isEntrypoint block in a bin-dispatched module re-arms the
// tsup-inlining hijack, #263).
