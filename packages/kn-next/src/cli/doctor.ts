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
 *
 * READ-ONLY by construction (ADR-0001): every kubectl call is a `get`; the
 * registry probe is an HTTP manifest HEAD.
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
 */

import { spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { createLogger } from "../utils/logger";
import { isEntrypoint } from "./exec";

const log = createLogger({ module: "doctor" });

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
    const excerpt = r.stderr.trim().replace(/\s+/g, " ").slice(0, 160);
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
            detail: `probe failed (rbac): ${excerpt}`,
            hint: `insufficient RBAC — ask a cluster admin for get/list on ${resource}`,
        };
    }
    return cls === "auth"
        ? {
              detail: `probe failed (auth): ${excerpt}`,
              hint: "credentials failed — re-authenticate (refresh your kubeconfig token) and retry",
          }
        : {
              detail: `probe failed (network): ${excerpt}`,
              hint: "cluster connection flaked — check network/VPN and retry",
          };
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

/** Run every preflight check. Pure orchestration over the injected deps. */
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
        push(
            "cluster",
            "Cluster reachable",
            "warn",
            `apiserver unreachable (${version.stderr.trim().slice(0, 120) || "no kubectl context?"}) — all cluster checks skipped`,
            infraFailure(version)?.hint,
        );
    }
    const skipAll = !reachable;

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
            throw new Error(
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
Knative Serving. Exit 1 on hard FAILs and on probe ERRORs (a check's kubectl
probe hit a network/TLS/credential/RBAC failure — the cluster state could not
be verified); WARN/SKIP never fail; a fully unreachable cluster SKIPs (exit 0).

Options:
  --json      Emit the check results as JSON
  -h, --help  Show this help
`;

/** Entry for `kn-next doctor`. Returns the process exit code. */
export async function doctorMain(argv: readonly string[]): Promise<number> {
    const args = parseDoctorArgs(argv);
    if (args.help) {
        writeSync(1, DOCTOR_HELP);
        return 0;
    }
    const report = await runDoctor({
        kubectl: kubectlRunner,
        probeImage: probeManifest,
    });
    if (args.json) {
        writeSync(1, `${JSON.stringify(report, null, 2)}\n`);
    } else {
        writeSync(1, formatDoctorTable(report.checks));
    }
    return report.exitCode;
}

// Run only when invoked directly as the entry (not when imported by tests or
// the kn-next bin dispatcher).
if (isEntrypoint(import.meta.url)) {
    try {
        process.exit(await doctorMain(process.argv.slice(2)));
    } catch (err) {
        log.fatal({ err }, "doctor failed");
        process.exit(1);
    }
}
