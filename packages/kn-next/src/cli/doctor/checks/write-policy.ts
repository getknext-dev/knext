/**
 * Operator write policy. The operator's cluster-wide create/update on Secrets
 * and ConfigMaps is bounded by a ValidatingAdmissionPolicy (RBAC cannot restrict
 * `create` by name), and that bound can be off with nothing saying so:
 *
 *  - a server older than Kubernetes 1.30 rejects the two policy objects while the
 *    rest of the install bundle applies;
 *  - an install under another namespace or ServiceAccount name than the bundle
 *    rendered leaves a matchCondition that matches nobody;
 *  - an admin or a GitOps prune deletes the policy or its binding.
 *
 * The operator publishes the same verdict as `knext_operator_write_policy_enforced`
 * (internal/writepolicy). This is the CLI half: read-only `get`s only, and an
 * unknown is reported as not verified, never as enforced.
 *
 * KEEP IN LOCKSTEP with internal/writepolicy/verdict.go. Both are held to
 * `kn-next-operator/internal/writepolicy/testdata/verdict-cases.json`.
 */

import { excerpt } from "../../shared";
import { classifyKubectlFailure, infraFailure, safeJson } from "../kubectl";
import { mk } from "../report";
import type { CheckContext, CheckResult } from "../types";
import { OPERATOR_NAMESPACE, SKIP_UNREACHABLE } from "../types";

const ID = "write-policy";
const TITLE = "Operator write policy";

/**
 * The policy's name AS THE BUNDLE RENDERS IT (the `kn-next-operator-` name
 * prefix applied), used when the operator Deployment carries no
 * WRITE_POLICY_NAME, i.e. an operator from before the self-check existed.
 *
 * The operator's own flag default (cmd/main.go, `--write-policy-name`) is the
 * UNPREFIXED base name `secret-configmap-writes` on purpose: it runs inside an
 * operator whose bundle always sets the env, so the fallback only matters for a
 * hand-run `make run`. Doctor runs outside it and is most likely to meet a
 * stock bundle, so the rendered name is the useful guess.
 */
const DEFAULT_POLICY_NAME = "kn-next-operator-secret-configmap-writes";

/**
 * The variables and validations the shipped policy carries, reduced to their
 * CEL: what the policy ADMITS, which matchConstraints, identity and binding all
 * being right do not guarantee (a validation replaced by `true` admits
 * everything). A copy of config/admission/secret-configmap-writes.yaml.
 *
 * KEEP IN LOCKSTEP: doctor-write-policy-canonical.test.ts fails if
 * config/admission changes without this, and the operator holds the same copy
 * (internal/writepolicy/canonical.go). Cosmetic fields (message, reason) are not
 * compared; messageExpression is, because it is CEL the apiserver evaluates.
 * An operator whose bundle is newer than the installed policy reports
 * PolicyModified until the bundle is reapplied, which is the honest answer.
 */
export const CANONICAL_POLICY_CEL = {
    variables: [
        {
            name: "objectName",
            expression:
                "request.operation == 'DELETE' ? oldObject.metadata.name : object.metadata.name",
        },
        {
            name: "allowedSecretSuffixes",
            expression: "['-knext-signing-key']",
        },
        { name: "allowedConfigMapSuffixes", expression: "['-knext-jwks']" },
        { name: "allowedSecretType", expression: "'Opaque'" },
        {
            name: "allowedSuffixes",
            expression:
                "request.resource.resource == 'secrets' ? variables.allowedSecretSuffixes : variables.allowedConfigMapSuffixes",
        },
    ],
    validations: [
        {
            expression:
                "variables.allowedSuffixes.exists(s, variables.objectName.endsWith(s) && size(variables.objectName) > size(s))",
            messageExpression:
                "'the knext operator may not ' + request.operation.lowerAscii() + ' the ' + request.resource.resource + ' object \"' + variables.objectName + '\": it writes only the per-zone signing key and JWKS'",
        },
        {
            expression:
                "request.resource.resource != 'secrets' || request.operation == 'DELETE' || dyn(object).type == variables.allowedSecretType",
            messageExpression: "",
        },
    ],
} as const;

/** ValidatingAdmissionPolicy is admissionregistration.k8s.io/v1 from here. */
const FLOOR = { major: 1, minor: 30 } as const;

export type WritePolicyReason =
    | "Enforced"
    | "PolicyMissing"
    | "BindingMissing"
    | "IdentityUnknown"
    | "PolicyFailsOpen"
    | "PolicyScope"
    | "PolicyModified"
    | "IdentityUnparseable"
    | "IdentityMismatch"
    | "BindingPolicyMismatch"
    | "BindingNotDeny"
    | "BindingScoped";

export interface WritePolicyVerdict {
    enforced: boolean;
    reason: WritePolicyReason;
    /** One sentence for a human; empty only when enforced. */
    detail: string;
}

interface Selector {
    matchLabels?: Record<string, string>;
    matchExpressions?: unknown[];
}

interface ResourceRule {
    apiGroups?: string[];
    apiVersions?: string[];
    resources?: string[];
    resourceNames?: string[];
    operations?: string[];
    scope?: string;
}

interface PolicyJson {
    metadata?: { name?: string };
    spec?: {
        failurePolicy?: string;
        matchConstraints?: {
            resourceRules?: ResourceRule[];
            excludeResourceRules?: ResourceRule[];
            namespaceSelector?: Selector;
            objectSelector?: Selector;
        };
        matchConditions?: { name?: string; expression?: string }[];
        variables?: { name?: string; expression?: string }[];
        validations?: { expression?: string; messageExpression?: string }[];
    };
}

interface BindingJson {
    metadata?: { name?: string };
    spec?: {
        policyName?: string;
        validationActions?: string[];
        matchResources?: {
            namespaceSelector?: Selector;
            objectSelector?: Selector;
            resourceRules?: unknown[];
            excludeResourceRules?: unknown[];
        };
    };
}

const no = (reason: WritePolicyReason, detail: string): WritePolicyVerdict => ({
    enforced: false,
    reason,
    detail,
});

/**
 * The one matchCondition shape read: an equality on the username against string
 * literals joined with +. Anything richer is not an exact-identity confinement.
 */
const IDENTITY_EXPR =
    /^\s*request\.userInfo\.username\s*==\s*('[^']*'(?:\s*\+\s*'[^']*')*)\s*$/;

function confinedUsername(policy: PolicyJson): string | undefined {
    const conds = policy.spec?.matchConditions ?? [];
    if (conds.length !== 1) return undefined;
    const m = IDENTITY_EXPR.exec(conds[0].expression ?? "");
    if (!m) return undefined;
    let out = "";
    for (const l of m[1].matchAll(/'([^']*)'/g)) out += l[1];
    return out;
}

/** An empty selector selects everything; the apiserver defaults an absent one to it. */
const narrows = (s?: Selector): boolean =>
    !!s &&
    (Object.keys(s.matchLabels ?? {}).length > 0 ||
        (s.matchExpressions ?? []).length > 0);

const has = (list: string[] | undefined, want: string): boolean =>
    (list ?? []).some((v) => v === want || v === "*");

/** The first (resource, operation) the policy does not reach, or "" if none. */
function uncovered(policy: PolicyJson): string {
    const rules = policy.spec?.matchConstraints?.resourceRules;
    if (!policy.spec?.matchConstraints) return "it has no matchConstraints";
    // Any exclusion could be carving Secrets or ConfigMaps (or an operation)
    // back out of the rules below, and reading which is a re-implementation of
    // the apiserver's matching. The shipped policy has none, so none is accepted.
    if ((policy.spec.matchConstraints.excludeResourceRules ?? []).length > 0) {
        return "it excludes some requests through excludeResourceRules";
    }
    for (const resource of ["secrets", "configmaps"]) {
        for (const op of ["CREATE", "UPDATE", "DELETE"]) {
            // A rule that names objects, is cluster-scoped, or is for another
            // apiVersion does not cover the operator's writes, however it spells
            // the resources. Secrets and ConfigMaps are namespaced; an absent
            // scope means all.
            const found = (rules ?? []).some(
                (r) =>
                    has(r.apiGroups, "") &&
                    has(r.apiVersions, "v1") &&
                    has(r.resources, resource) &&
                    has(r.operations, op) &&
                    (r.resourceNames ?? []).length === 0 &&
                    (r.scope === undefined ||
                        r.scope === "Namespaced" ||
                        r.scope === "*"),
            );
            if (!found) return `it does not cover ${op} on ${resource}`;
        }
    }
    return "";
}

/** Whether the policy's variables and validations are exactly the shipped CEL. */
function sameCEL(policy: PolicyJson): boolean {
    const got = {
        variables: (policy.spec?.variables ?? []).map((v) => ({
            name: v.name ?? "",
            expression: v.expression ?? "",
        })),
        validations: (policy.spec?.validations ?? []).map((v) => ({
            expression: v.expression ?? "",
            messageExpression: v.messageExpression ?? "",
        })),
    };
    return JSON.stringify(got) === JSON.stringify(CANONICAL_POLICY_CEL);
}

/**
 * Whether the write policy is in force for the operator that runs as
 * `operatorUsername`. `policy`/`binding` are undefined when the object does not
 * exist. Checks run in a fixed order, so the first thing wrong is reported.
 */
export function evaluateWritePolicy(
    policy: PolicyJson | undefined,
    binding: BindingJson | undefined,
    operatorUsername: string,
): WritePolicyVerdict {
    if (!policy) {
        return no(
            "PolicyMissing",
            "the ValidatingAdmissionPolicy that limits the operator's Secret and ConfigMap writes does not exist (deleted or pruned, or the server is older than Kubernetes 1.30): the operator is unrestricted",
        );
    }
    const name = policy.metadata?.name ?? "";
    if (!binding) {
        return no(
            "BindingMissing",
            `the policy ${name} exists but no binding of that name does, so it is never evaluated: the operator is unrestricted`,
        );
    }
    if (!operatorUsername) {
        return no(
            "IdentityUnknown",
            "the username the operator runs as could not be established, so the policy's identity cannot be compared with it",
        );
    }
    if (policy.spec?.failurePolicy === "Ignore") {
        return no(
            "PolicyFailsOpen",
            `the policy ${name} has failurePolicy Ignore, so an evaluation error lets the write through`,
        );
    }
    const gap = uncovered(policy);
    if (gap) {
        return no(
            "PolicyScope",
            `the policy ${name} does not confine every write the operator makes: ${gap}`,
        );
    }
    const mc = policy.spec?.matchConstraints;
    if (narrows(mc?.namespaceSelector) || narrows(mc?.objectSelector)) {
        return no(
            "PolicyScope",
            `the policy ${name} narrows by namespace or object selector, but the operator writes in every namespace`,
        );
    }
    const confined = confinedUsername(policy);
    if (confined === undefined) {
        return no(
            "IdentityUnparseable",
            `the policy ${name} does not confine one exact username (its matchCondition is not an equality on request.userInfo.username), so which principal it limits cannot be verified`,
        );
    }
    if (confined !== operatorUsername) {
        return no(
            "IdentityMismatch",
            `the policy ${name} confines ${confined} but the operator runs as ${operatorUsername}: it matches nobody the operator is (installed under another namespace or ServiceAccount name than the bundle rendered?)`,
        );
    }
    if (!sameCEL(policy)) {
        return no(
            "PolicyModified",
            `the policy ${name} does not carry the variables and validations this CLI ships, so what it admits is not what the bundle intended (its validation CEL, an allow-list variable or a messageExpression was changed, added or removed)`,
        );
    }
    if (binding.spec?.policyName !== name) {
        return no(
            "BindingPolicyMismatch",
            `the binding names policy ${binding.spec?.policyName ?? "(none)"}, not ${name}`,
        );
    }
    if (!(binding.spec?.validationActions ?? []).includes("Deny")) {
        return no(
            "BindingNotDeny",
            `the binding does not include the Deny action (actions ${JSON.stringify(binding.spec?.validationActions ?? [])}): a violation is warned about or audited, never refused`,
        );
    }
    const mr = binding.spec?.matchResources;
    if (
        mr &&
        (narrows(mr.namespaceSelector) ||
            narrows(mr.objectSelector) ||
            (mr.resourceRules ?? []).length > 0 ||
            (mr.excludeResourceRules ?? []).length > 0)
    ) {
        return no(
            "BindingScoped",
            "the binding limits the policy to some namespaces or objects, but the operator writes in every namespace",
        );
    }
    return { enforced: true, reason: "Enforced", detail: "" };
}

/** The server's major.minor from `/version`, or undefined when unreadable. */
function serverVersion(
    stdout: string,
): { major: number; minor: number } | undefined {
    const v = safeJson<{
        major?: string;
        minor?: string;
        gitVersion?: string;
    }>(stdout);
    if (!v) return undefined;
    const git = /^v?(\d+)\.(\d+)/.exec(v.gitVersion ?? "");
    if (git) return { major: Number(git[1]), minor: Number(git[2]) };
    const major = Number.parseInt(v.major ?? "", 10);
    const minor = Number.parseInt((v.minor ?? "").replace(/\D+$/, ""), 10);
    return Number.isFinite(major) && Number.isFinite(minor)
        ? { major, minor }
        : undefined;
}

const REPAIR_HINT =
    "reapply the operator bundle (`kubectl apply --server-side -f install.yaml`) on Kubernetes 1.30 or newer; for a repackaged install, make the policy's identity and name match the operator's ServiceAccount and WRITE_POLICY_NAME";

export function writePolicyCheck(ctx: CheckContext): CheckResult[] {
    if (ctx.skipAll) {
        return [mk(ID, TITLE, "skip", SKIP_UNREACHABLE)];
    }
    const manager = ctx.operatorManager;
    if (!manager) {
        return [
            mk(
                ID,
                TITLE,
                "skip",
                "no operator Deployment found, so there is no identity to compare the write policy with — skipped",
            ),
        ];
    }

    const version = serverVersion(
        ctx.kubectl(["kubectl", "get", "--raw", "/version"]).stdout,
    );
    if (
        version &&
        (version.major < FLOOR.major ||
            (version.major === FLOOR.major && version.minor < FLOOR.minor))
    ) {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `the server is Kubernetes ${version.major}.${version.minor}, older than the ${FLOOR.major}.${FLOOR.minor} floor: ValidatingAdmissionPolicy is not available, so nothing limits the operator's Secret and ConfigMap writes — the operator is unrestricted`,
                `upgrade the cluster to Kubernetes ${FLOOR.major}.${FLOOR.minor} or newer, then reapply the operator bundle`,
            ),
        ];
    }

    const podSpec = manager.spec?.template?.spec;
    const container =
        podSpec?.containers?.find((c) => c.name === "manager") ??
        podSpec?.containers?.[0];
    const name =
        container?.env?.find((e) => e.name === "WRITE_POLICY_NAME")?.value ||
        DEFAULT_POLICY_NAME;
    const namespace = manager.metadata?.namespace ?? OPERATOR_NAMESPACE;
    const sa = podSpec?.serviceAccountName ?? "default";
    const username = `system:serviceaccount:${namespace}:${sa}`;

    const read = (kind: string) =>
        ctx.kubectl(["kubectl", "get", kind, name, "-o", "json"]);
    const policyRes = read("validatingadmissionpolicy");
    const bindingRes = read("validatingadmissionpolicybinding");

    for (const r of [policyRes, bindingRes]) {
        if (r.ok) continue;
        const cls = classifyKubectlFailure(r.stderr);
        if (cls === "not-found") continue;
        if (cls === "forbidden") {
            return [
                mk(
                    ID,
                    TITLE,
                    "warn",
                    `cannot determine whether the operator's write policy ${name} is in force (reading it was denied by RBAC) — treat the operator as UNRESTRICTED until verified`,
                    "grant `get` on validatingadmissionpolicies and validatingadmissionpolicybindings for this diagnosis, or check the operator's knext_operator_write_policy_enforced gauge",
                ),
            ];
        }
        const infra = infraFailure(r);
        if (infra) return [mk(ID, TITLE, "error", infra.detail, infra.hint)];
        return [
            // Unknown is not enforced: a read that failed for a reason doctor does
            // not recognise says nothing about the policy, so it is a WARN, not a
            // skip that reads as "nothing to see".
            mk(
                ID,
                TITLE,
                "warn",
                `could not read the operator's write policy ${name} (${excerpt(r.stderr.replace(/[^\x20-\x7e\s]/g, "")) || "no error text"}) — not verified; treat the operator as UNRESTRICTED until it is`,
                REPAIR_HINT,
            ),
        ];
    }

    const policy = policyRes.ok
        ? (safeJson<PolicyJson>(policyRes.stdout) ?? undefined)
        : undefined;
    const binding = bindingRes.ok
        ? (safeJson<BindingJson>(bindingRes.stdout) ?? undefined)
        : undefined;
    // A policy object that exists but could not be parsed is not "missing".
    if ((policyRes.ok && !policy) || (bindingRes.ok && !binding)) {
        return [
            mk(
                ID,
                TITLE,
                "warn",
                `the operator's write policy ${name} returned unreadable output — not verified; treat the operator as UNRESTRICTED until it is`,
                REPAIR_HINT,
            ),
        ];
    }

    const v = evaluateWritePolicy(policy, binding, username);
    if (v.enforced) {
        return [
            mk(
                ID,
                TITLE,
                "pass",
                `${name} is bound with Deny, covers create/update/delete on Secrets and ConfigMaps, confines ${username} and carries the shipped validations, so the operator may write only its per-zone signing-key Secrets and JWKS ConfigMaps`,
            ),
        ];
    }
    return [mk(ID, TITLE, "warn", v.detail, REPAIR_HINT)];
}
