/**
 * kubectl invocation + classification helpers for `kn-next doctor`.
 *
 * All of this is READ-ONLY by construction (ADR-0001): the runner spawns
 * `kubectl get`/`version`, the registry probe is an HTTP manifest HEAD, and the
 * kubeconfig inspector reads local files. Moved verbatim from the pre-#1055
 * single-file doctor; no logic changed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DOCS_URL } from "../help";
import { excerpt } from "../shared";
import type {
    CNIEnforcement,
    DaemonSetRef,
    DeploymentJson,
    InfraFailure,
    KubeconfigState,
    KubectlFailureClass,
    KubectlResult,
    NoClusterDiagnosis,
    ProbeOutcome,
} from "./types";
import { MIN_STRICT_VALIDATION_KUBECTL } from "./types";

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

/**
 * Map a failed kubectl result to an ERROR payload when (and only when) the
 * stderr carries a clearly-infrastructural signature; undefined otherwise so
 * the caller keeps its legacy (not-found / warn) branch.
 */
export function infraFailure(r: KubectlResult): InfraFailure | undefined {
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

/**
 * The home directory to search for `~/.kube/config`, preferring `$HOME`.
 *
 * This is what kubectl does, and what Node's own `os.homedir()` does — so on
 * Node the two agree and this reads as redundant. **Bun's `os.homedir()`
 * ignores `$HOME`** and returns the passwd entry, measured directly:
 *
 *   HOME=/tmp/zzz  node -> /tmp/zzz      bun -> /Users/<real>
 *
 * That is a behaviour difference, not just a test inconvenience: a container or
 * CI job that sets `HOME` — which is the ordinary way to point a tool at a
 * scoped config — would have its kubeconfig looked up in the wrong place the
 * moment this CLI ran under Bun.
 */
function kubeconfigHome(): string {
    const home = process.env.HOME;
    return home !== undefined && home.length > 0 ? home : homedir();
}

/**
 * Default kubeconfig inspector: pure local file reads — no kubectl (the
 * read-only get/version verb contract holds) and no network. Mirrors
 * kubectl's merge rule for $KUBECONFIG lists: any listed file that sets a
 * non-empty current-context wins. A config that cannot be parsed NEVER
 * claims "no cluster".
 */
export function inspectKubeconfig(): KubeconfigState {
    const env = process.env.KUBECONFIG;
    const searched = env?.length
        ? env.split(delimiter).filter((p) => p.length > 0)
        : [join(kubeconfigHome(), ".kube", "config")];
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

export function safeJson<T>(raw: string): T | undefined {
    try {
        return JSON.parse(raw) as T;
    } catch {
        return undefined;
    }
}

export function isReady(d: DeploymentJson | undefined): boolean {
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
 * Pure classification seam: a READY enforcing agent wins (canal clusters also
 * run a flannel DaemonSet); an enforcing agent installed but NOT running is
 * unknown, with evidence naming the dead agent — the more specific signal, so
 * it outranks the flannel fallback; flannel alone is likely-unenforced;
 * nothing recognized is unknown. Evidence is sorted so the same cluster
 * always yields the same string.
 */
export function classifyCNIEnforcement(daemonSets: readonly DaemonSetRef[]): {
    verdict: CNIEnforcement;
    evidence: string;
} {
    const enforcing: string[] = [];
    const crashed: string[] = [];
    const flannel: string[] = [];
    for (const ds of daemonSets) {
        const cni = ENFORCING_AGENT_DS[ds.name];
        if (cni) {
            if (ds.ready) {
                enforcing.push(`${cni} DaemonSet ${ds.name} (${ds.namespace})`);
            } else {
                crashed.push(
                    `${cni} DaemonSet ${ds.name} (${ds.namespace}, not running)`,
                );
            }
        } else if (ds.name.includes("flannel")) {
            flannel.push(`flannel DaemonSet ${ds.name} (${ds.namespace})`);
        }
    }
    if (enforcing.length > 0) {
        return { verdict: "enforced", evidence: enforcing.sort().join("; ") };
    }
    if (crashed.length > 0) {
        return { verdict: "unknown", evidence: crashed.sort().join("; ") };
    }
    if (flannel.length > 0) {
        return {
            verdict: "likely-unenforced",
            evidence: flannel.sort().join("; "),
        };
    }
    return { verdict: "unknown", evidence: "" };
}
