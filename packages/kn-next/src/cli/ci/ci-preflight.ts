/**
 * `kn-next ci-preflight` — the same credential preflight
 * `packages/kn-next-action/preflight.mjs` runs, exposed as a CLI verb (#1534)
 * so a CI provider with no composite-action equivalent (GitLab, and any
 * future provider `init-ci` generates for) can run it by invoking the
 * published CLI instead of a shell script re-deriving the rules.
 *
 * This module is orchestration ONLY. The rules live in exactly one place
 * each, unchanged by this file: `kubeconfig-safety.ts`
 * (`classifyKubeconfigSafety`) and `credential-scope.ts`
 * (`classifyCredentialScope`, `hazardProbes`) — the same two modules
 * `doctor --ci-kubeconfig` and `kn-next-action` already read. Nothing here
 * is a security decision of its own; it asks the classifier, asks the
 * cluster, asks the classifier again.
 *
 * Two refusals, fail-closed at every stage, matching
 * `packages/kn-next-action/{kubeconfig-check,preflight}.mjs` line for line:
 *
 *   1. (ADR-0061) the kubeconfig needs cloud-account credentials
 *      (exec/auth-provider) — a LOCAL read, no cluster call.
 *   2. (#874/#1495) a `SelfSubjectRulesReview` plus a `SelfSubjectAccessReview`
 *      hazard spot-check report the credential can do more than the
 *      published Role. A webhook authorizer (OKE/GKE IAM) answers the
 *      targeted access review even when the broader rules review comes back
 *      `incomplete` — that is what lets this fail closed on exactly the
 *      cluster class a naive "trust the rules review" implementation fails
 *      open on.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
    classifyCredentialScope,
    type HazardProbe,
    hazardProbes,
    type PolicyRule,
} from "./credential-scope";
import { classifyKubeconfigSafety } from "./kubeconfig-safety";

const RULES_PATH = "/apis/authorization.k8s.io/v1/selfsubjectrulesreviews";
const ACCESS_PATH = "/apis/authorization.k8s.io/v1/selfsubjectaccessreviews";

export type KubectlRawFn = (rawPath: string, body: string) => string;

/**
 * Production: `kubectl create --raw <path> -f -`, body on stdin — no
 * client-side schema validation, which the scoped `knext-deployer`
 * ServiceAccount is never granted (`list` on
 * `customresourcedefinitions.apiextensions.k8s.io`). Falls back to
 * `create -o json --validate=false -f -` only when `--raw` itself is
 * unrecognized by this kubectl release, mirroring `preflight.mjs`'s
 * `submitRaw` verbatim — this is the same fallback, ported.
 */
export const defaultKubectlRaw: KubectlRawFn = (rawPath, body) => {
    try {
        return execFileSync(
            "kubectl",
            ["create", "--raw", rawPath, "-f", "-"],
            { encoding: "utf8", input: body, stdio: ["pipe", "pipe", "pipe"] },
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const looksLikeUnknownFlag =
            /unknown flag/i.test(message) ||
            /unknown shorthand flag/i.test(message);
        if (!looksLikeUnknownFlag) throw err;
        return execFileSync(
            "kubectl",
            ["create", "-o", "json", "--validate=false", "-f", "-"],
            { encoding: "utf8", input: body, stdio: ["pipe", "pipe", "pipe"] },
        );
    }
};

export interface CiPreflightResult {
    ok: boolean;
    /** Human-readable lines, printed in order. Never carries kubeconfig bytes. */
    lines: string[];
}

interface EffectiveRules {
    rules: PolicyRule[];
    warnings: string[];
}

function effectiveRules(namespace: string, raw: KubectlRawFn): EffectiveRules {
    const review = JSON.stringify({
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectRulesReview",
        spec: { namespace },
    });
    const out = raw(RULES_PATH, review);
    const parsed = JSON.parse(out) as {
        status?: {
            resourceRules?: unknown;
            incomplete?: boolean;
            evaluationError?: string;
        };
    };
    const status = parsed?.status;
    const rules = status?.resourceRules;
    if (!status || !Array.isArray(rules)) {
        throw new Error("SelfSubjectRulesReview returned no resourceRules");
    }
    const warnings: string[] = [];
    // `incomplete` is the normal answer from a webhook authorizer (OKE/GKE
    // IAM) — warn, don't fail closed HERE: that would refuse every
    // credential on such a cluster, including a correctly-scoped one. The
    // hazard spot-check below is what actually verifies safety there.
    if (status.incomplete) {
        warnings.push(
            "warning: the cluster reports this SelfSubjectRulesReview as " +
                "incomplete (common on webhook-authorized clusters such as " +
                "OKE or GKE with IAM). Relying on the hazardous-permission " +
                "spot-check rather than failing closed here." +
                (status.evaluationError
                    ? ` Cluster said: ${status.evaluationError}`
                    : ""),
        );
    }
    return { rules: rules as PolicyRule[], warnings };
}

function checkHazard(probe: HazardProbe, raw: KubectlRawFn): boolean {
    const review = JSON.stringify({
        apiVersion: "authorization.k8s.io/v1",
        kind: "SelfSubjectAccessReview",
        spec: {
            resourceAttributes: {
                ...(probe.namespace !== undefined
                    ? { namespace: probe.namespace }
                    : {}),
                group: probe.group,
                resource: probe.resource,
                ...(probe.subresource
                    ? { subresource: probe.subresource }
                    : {}),
                verb: probe.verb,
            },
        },
    });
    const out = raw(ACCESS_PATH, review);
    let parsed: unknown;
    try {
        parsed = JSON.parse(out);
    } catch {
        throw new Error(`the review of "${probe.label}" did not return JSON`);
    }
    const status = (parsed as { status?: unknown })?.status;
    if (typeof status !== "object" || status === null) {
        throw new Error(`the review of "${probe.label}" returned no status`);
    }
    const s = status as { evaluationError?: unknown; allowed?: unknown };
    if (typeof s.evaluationError === "string" && s.evaluationError !== "") {
        throw new Error(
            `the review of "${probe.label}" did not complete: ${s.evaluationError}`,
        );
    }
    if (typeof s.allowed !== "boolean") {
        throw new Error(
            `the review of "${probe.label}" returned no boolean verdict`,
        );
    }
    return s.allowed;
}

export interface RunCiPreflightOptions {
    namespace: string;
    kubeconfigPath: string;
    readFile?: (p: string) => string;
    kubectlRaw?: KubectlRawFn;
}

/**
 * Fails CLOSED at every stage: a check that cannot run is a refusal, not a
 * pass — the same discipline `preflight.mjs` and `kubeconfig-safety.ts` apply.
 */
export function runCiPreflight(opts: RunCiPreflightOptions): CiPreflightResult {
    const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
    const raw = opts.kubectlRaw ?? defaultKubectlRaw;
    const lines: string[] = [];

    let kubeconfigYaml: string;
    try {
        kubeconfigYaml = readFile(opts.kubeconfigPath);
    } catch (err) {
        return {
            ok: false,
            lines: [
                `could not read ${opts.kubeconfigPath}: ${err instanceof Error ? err.message : String(err)}`,
            ],
        };
    }

    const safety = classifyKubeconfigSafety(kubeconfigYaml);
    if (!safety.ok) {
        return { ok: false, lines: [safety.reason ?? "refused"] };
    }
    lines.push(
        `kubeconfig-check: ${opts.kubeconfigPath} does not need cloud-account credentials.`,
    );

    let rules: PolicyRule[];
    try {
        const effective = effectiveRules(opts.namespace, raw);
        rules = effective.rules;
        lines.push(...effective.warnings);
    } catch (err) {
        return {
            ok: false,
            lines: [
                ...lines,
                "Could not determine what this credential can do. Refusing " +
                    "rather than proceeding: a credential check that passes " +
                    "when it cannot see is not a check.",
                `underlying error: ${err instanceof Error ? err.message : String(err)}`,
            ],
        };
    }

    const scope = classifyCredentialScope(rules);
    if (!scope.ok) {
        return {
            ok: false,
            lines: [
                ...lines,
                "This kubeconfig grants more than knext needs. Refusing to use it.",
                ...scope.findings.map((f) => `  - ${f}`),
                scope.remedy,
            ],
        };
    }

    let hazardsFound: HazardProbe[];
    try {
        const probes = hazardProbes(opts.namespace);
        if (probes.length === 0)
            throw new Error("the hazard probe set is empty");
        hazardsFound = probes.filter((probe) => checkHazard(probe, raw));
    } catch (err) {
        return {
            ok: false,
            lines: [
                ...lines,
                "Could not run the hazardous-permission spot-check " +
                    "(SelfSubjectAccessReview). Refusing rather than " +
                    "proceeding: a review with no verdict is a review that " +
                    "did not run.",
                `underlying error: ${err instanceof Error ? err.message : String(err)}`,
            ],
        };
    }

    if (hazardsFound.length > 0) {
        return {
            ok: false,
            lines: [
                ...lines,
                "This kubeconfig can do things far outside what knext needs. Refusing to use it.",
                ...hazardsFound.map((h) => `  - ${h.label}`),
                scope.remedy,
            ],
        };
    }

    lines.push(
        `preflight: credential is correctly scoped for namespace "${opts.namespace}".`,
    );
    return { ok: true, lines };
}
