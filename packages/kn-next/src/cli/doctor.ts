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
 * registry probe is an HTTP manifest HEAD. Exit code is 1 only on hard FAILs;
 * WARN/SKIP never fail the preflight, and an unreachable cluster degrades all
 * checks to a clear SKIP.
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

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
    id: string;
    title: string;
    status: CheckStatus;
    detail: string;
}

export interface DoctorReport {
    checks: CheckResult[];
    /** 1 iff any check hard-FAILed; WARN/SKIP never fail the preflight. */
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
    try {
        let res = await fetch(manifestUrl, {
            method: "HEAD",
            headers: { Accept: accept },
        });
        if (res.status === 401) {
            // Anonymous token flow (ghcr.io / registry-1.docker.io style).
            const challenge = res.headers.get("www-authenticate") ?? "";
            const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
            const service = /service="([^"]+)"/.exec(challenge)?.[1];
            if (realm) {
                const tokenUrl = `${realm}?${service ? `service=${encodeURIComponent(service)}&` : ""}scope=${encodeURIComponent(`repository:${repository}:pull`)}`;
                const tokenRes = await fetch(tokenUrl);
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
    ) => checks.push({ id, title, status, detail });

    // Gate: is the apiserver reachable at all?
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
        if (!crd.ok) {
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
        if (!deps_.ok || items.length === 0) {
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
        if (!cm.ok) {
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
        if (!cm.ok) {
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
            // knative-serving on current installs, kourier-system on older ones)
            const kourierReady = ["knative-serving", "kourier-system"].some(
                (ns) => {
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
                    return d.ok && isReady(safeJson<DeploymentJson>(d.stdout));
                },
            );

            if (ingressClass === KOURIER_INGRESS_CLASS && kourierReady) {
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
        if (ksvc.ok) {
            push(
                "knative",
                "Knative Serving",
                "pass",
                `${KSVC_CRD} CRD present`,
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

    const exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
    return { checks, exitCode };
}

const STATUS_LABEL: Record<CheckStatus, string> = {
    pass: "PASS",
    warn: "WARN",
    fail: "FAIL",
    skip: "SKIP",
};

/** Render the human table (one status-tagged row per check). */
export function formatDoctorTable(checks: readonly CheckResult[]): string {
    const titleWidth = Math.max(...checks.map((c) => c.title.length), 5);
    const rows = checks.map(
        (c) =>
            `${STATUS_LABEL[c.status]}  ${c.title.padEnd(titleWidth)}  ${c.detail}`,
    );
    return `${rows.join("\n")}\n`;
}

export interface DoctorArgs {
    json: boolean;
    help: boolean;
}

export function parseDoctorArgs(argv: readonly string[]): DoctorArgs {
    return {
        json: argv.includes("--json"),
        help: argv.includes("-h") || argv.includes("--help"),
    };
}

const DOCTOR_HELP = `kn-next doctor — cluster-prereq preflight (read-only)

Checks: NextApp CRD, operator readiness, cert-manager webhook, Knative
ingress-class vs its reconciler (#208), operator-image pullability (#198),
Knative Serving. Exit 1 only on hard FAILs; unreachable clusters SKIP.

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
