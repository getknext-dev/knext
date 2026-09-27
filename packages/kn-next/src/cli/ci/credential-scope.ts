/**
 * ADR-0049 stage 1 — what CI is allowed to hold, and the refusal that enforces it.
 *
 * The trust argument for deploying into someone else's cluster is that knext
 * asks for permission to write ONE kind of object in ONE namespace. That is
 * only possible because the operator is the single source of truth (ADR-0001):
 * the Action emits a `NextApp` CR and stops, so it never needs to create
 * Deployments, Services or read Secrets.
 *
 * An argument like that is worth nothing if the code accepts whatever it is
 * handed. Most people, asked for a kubeconfig, will reach for the admin one —
 * it is the one they have. So ADR-0049 requires the credential to be REFUSED
 * rather than discouraged, and this module is that refusal.
 *
 * ## Why the rules live here and not in a docs snippet
 *
 * The Role appears in four places: the ADR, the docs page, the manifest
 * `knext init-ci` generates, and this check. Four hand-maintained copies of a
 * permission list is how one of them ends up granting more than the others —
 * and the one that drifts wide is the one nobody notices, because nothing
 * fails. `CI_ROLE_RULES` is the single definition; the renderer and the
 * classifier both read it.
 */

/** A rule as `SelfSubjectRulesReview` returns it — every field optional. */
export interface PolicyRule {
    apiGroups?: readonly string[];
    resources?: readonly string[];
    verbs?: readonly string[];
}

export interface ScopeVerdict {
    /** True when nothing beyond the published Role was found. */
    ok: boolean;
    /** One line per over-broad grant, in the order found. */
    findings: string[];
    /** The Role to apply instead — printed WITH the findings, never instead. */
    remedy: string;
}

/**
 * The Role ADR-0049 publishes, verbatim and singular.
 *
 * No `delete`: a leaked token must not be able to remove an application, and
 * the operator's finalizer — not CI — owns teardown. No `secrets`, no core
 * resources at all.
 */
export const CI_ROLE_RULES = [
    {
        apiGroups: ["apps.kn-next.dev"],
        resources: ["nextapps"],
        verbs: ["get", "list", "create", "patch", "update"],
    },
] as const;

/**
 * Grants every authenticated subject carries via `system:basic-user`, so they
 * are not evidence of a broad credential.
 *
 * This allowance is deliberately tiny and deliberately explicit. A classifier
 * that tripped on it would refuse a correctly-scoped ServiceAccount, and the
 * fastest way to get a security check deleted is to have it refuse the correct
 * credential.
 */
const ALWAYS_PRESENT = new Set([
    "authorization.k8s.io/selfsubjectaccessreviews",
    "authorization.k8s.io/selfsubjectrulesreviews",
    // Kubernetes 1.28+: `system:basic-user` also grants this (`kubectl auth
    // whoami`) — an identity read of the caller itself, nothing more.
    "authentication.k8s.io/selfsubjectreviews",
]);

/**
 * Resources whose presence is reported by NAME, because the name is the
 * explanation. Everything outside the published Role is refused regardless;
 * these get a specific line because "you granted secrets" lands where "you
 * granted 14 extra resources" does not.
 */
const NAMED_HAZARDS: Record<string, string> = {
    secrets: "can read Secrets — every credential in the namespace",
    pods: "can act on Pods directly, around the operator",
    deployments: "can act on Deployments directly, around the operator",
    statefulsets: "can act on StatefulSets directly, around the operator",
    services: "can act on Services directly, around the operator",
    roles: "can grant itself further permissions",
    rolebindings: "can grant itself further permissions",
    clusterroles: "can grant itself further permissions",
    clusterrolebindings: "can grant itself further permissions",
};

const allowedVerbs = new Set<string>(CI_ROLE_RULES[0].verbs);

/** `""` is the core group; normalise it to a printable name. */
const groupName = (g: string) => (g === "" ? "core" : g);

/**
 * Classify what a credential can do against what stage 1 needs.
 *
 * Fails CLOSED in shape as well as in verdict: an unrecognised grant is a
 * finding, not an omission. The check is "is this within the Role", never "does
 * this match a list of bad things" — an enumerated denylist is how the next
 * dangerous resource gets missed, and Kubernetes grows resources faster than
 * this file would be updated.
 */
export function classifyCredentialScope(
    rules: readonly PolicyRule[],
): ScopeVerdict {
    const findings: string[] = [];

    for (const rule of rules) {
        const groups = rule.apiGroups ?? [];
        const resources = rule.resources ?? [];
        const verbs = rule.verbs ?? [];

        // A wildcard on either axis is cluster-admin-shaped. Report it first
        // and by name — it is the credential people actually paste in.
        if (groups.includes("*") || resources.includes("*")) {
            findings.push(
                `wildcard grant (apiGroups: ${JSON.stringify(groups)}, ` +
                    `resources: ${JSON.stringify(resources)}) — this is a ` +
                    "cluster-admin-shaped credential",
            );
            continue;
        }

        for (const group of groups) {
            for (const resource of resources) {
                const key = `${group}/${resource}`;
                if (ALWAYS_PRESENT.has(key)) continue;

                const inRole = CI_ROLE_RULES.some(
                    (r) =>
                        (r.apiGroups as readonly string[]).includes(group) &&
                        (r.resources as readonly string[]).includes(resource),
                );

                if (!inRole) {
                    const hazard = NAMED_HAZARDS[resource];
                    findings.push(
                        hazard
                            ? `${groupName(group)}/${resource}: ${hazard}`
                            : `${groupName(group)}/${resource}: granted, but ` +
                                  "stage 1 needs only nextapps",
                    );
                    continue;
                }

                // In the Role by resource — now check the verbs. `*` includes
                // `delete`, so checking for the wildcard separately is not
                // pedantry: enumerating bad verbs and missing `*` would pass
                // something strictly worse than an explicit `delete`.
                if (verbs.includes("*")) {
                    findings.push(
                        `${groupName(group)}/${resource}: wildcard verb ` +
                            "`*` — this includes delete",
                    );
                    continue;
                }
                const extra = verbs.filter((v) => !allowedVerbs.has(v));
                if (extra.length > 0) {
                    findings.push(
                        `${groupName(group)}/${resource}: verbs ` +
                            `${extra.join(", ")} are outside the published Role`,
                    );
                }
            }
        }
    }

    return { ok: findings.length === 0, findings, remedy: ROLE_REMEDY };
}

/**
 * One SelfSubjectAccessReview point query. `namespace` undefined asks
 * "across all namespaces / cluster-wide", which only a cluster-scoped grant
 * satisfies.
 */
export interface HazardProbe {
    group: string;
    resource: string;
    subresource?: string;
    verb: string;
    namespace?: string;
    /** Printed when the probe is allowed — the reason for the refusal. */
    label: string;
}

/** Every verb Kubernetes defines on an ordinary resource, plus the wildcard. */
const RESOURCE_VERBS = [
    "get",
    "list",
    "watch",
    "create",
    "update",
    "patch",
    "delete",
    "deletecollection",
    "*",
] as const;

/** A namespace that is not the target, for asking "is the grant namespaced?". */
function foreignNamespace(namespace: string): string {
    return namespace === "kube-system" ? "default" : "kube-system";
}

/**
 * The hazardous-permission probe set for a credential meant to deploy into
 * `namespace` (#1495). Any ONE allowed ⇒ refuse.
 *
 * Why probes at all: on a webhook-authorized cluster (OKE, GKE with IAM) the
 * `SelfSubjectRulesReview` is `incomplete` and silent about IAM-granted
 * permissions; `SelfSubjectAccessReview` still answers point queries there.
 * It cannot enumerate the complement of the Role, so this set is DERIVED from
 * `CI_ROLE_RULES` wherever it can be — a Role change re-derives it — and is a
 * fixed escalation list where it cannot. It is a spot-check, not a proof: a
 * permission outside every probe below still passes on such a cluster.
 */
export function hazardProbes(namespace: string): HazardProbe[] {
    const probes: HazardProbe[] = [];
    const foreign = foreignNamespace(namespace);

    for (const rule of CI_ROLE_RULES) {
        const roleVerbs = new Set<string>(rule.verbs);
        for (const group of rule.apiGroups) {
            for (const resource of rule.resources) {
                // 1. The Role's own verbs, OUTSIDE the target namespace: the
                //    Role is namespaced, so an allow here is a broader grant.
                //    A cluster-wide grant (ClusterRoleBinding) answers "yes"
                //    here too, so no separate all-namespaces probe is needed.
                for (const verb of rule.verbs) {
                    probes.push({
                        group,
                        resource,
                        verb,
                        namespace: foreign,
                        label: `${verb} ${resource} outside ${namespace} (asked in ${foreign})`,
                    });
                }
                // 2. Verbs the Role does NOT grant, in the target namespace.
                for (const verb of RESOURCE_VERBS) {
                    if (roleVerbs.has(verb)) continue;
                    probes.push({
                        group,
                        resource,
                        verb,
                        namespace,
                        label: `${verb} ${resource} (outside the published Role)`,
                    });
                }
            }
        }
    }

    // 3. Escalation primitives no Role derivation reaches.
    const ns = (p: Omit<HazardProbe, "namespace">): HazardProbe => ({
        ...p,
        namespace,
    });
    const rbac = "rbac.authorization.k8s.io";
    probes.push(
        {
            group: "*",
            resource: "*",
            verb: "*",
            label: "wildcard on everything (*/*/*) — cluster-admin-shaped",
        },
        {
            group: "*",
            resource: "*",
            verb: "get",
            label: "read every resource (*/*/get)",
        },
        ns({
            group: "",
            resource: "pods",
            subresource: "exec",
            verb: "create",
            label: "exec into pods (pods/exec)",
        }),
        ns({
            group: "",
            resource: "pods",
            verb: "create",
            label: "create pods",
        }),
        // The pods probe above is easily sidestepped: any controller that
        // CREATES pods on the credential's behalf gets you the same shell,
        // without ever asking for "create pods" directly (review of #1557,
        // round 2/3, N1). Measured with the webhook fake: `create jobs`,
        // namespaced `patch deployments` and `patch services.serving.knative.dev`
        // all passed the preflight before these were added. Six probes, one
        // per controller/resource this repo's own Knative-based operator
        // makes relevant — not exhaustive (a residual this repo already
        // discloses), but they stop the cheapest sidesteps of the pods probe.
        ns({
            group: "batch",
            resource: "jobs",
            verb: "create",
            label: "create jobs (runs pods without asking for pods directly)",
        }),
        ns({
            group: "batch",
            resource: "cronjobs",
            verb: "create",
            label: "create cronjobs (runs pods on a schedule)",
        }),
        ns({
            group: "apps",
            resource: "deployments",
            verb: "patch",
            label: "patch deployments in the namespace (around the operator)",
        }),
        ns({
            group: "apps",
            resource: "statefulsets",
            verb: "create",
            label: "create statefulsets (runs pods without asking for pods directly)",
        }),
        ns({
            group: "apps",
            resource: "daemonsets",
            verb: "create",
            label: "create daemonsets (runs pods on every node)",
        }),
        ns({
            group: "serving.knative.dev",
            resource: "services",
            verb: "patch",
            label: "patch Knative Services directly (around the NextApp CR)",
        }),
        ns({
            group: "",
            resource: "serviceaccounts",
            verb: "create",
            label: "create serviceaccounts",
        }),
        ns({
            group: "",
            resource: "serviceaccounts",
            subresource: "token",
            verb: "create",
            label: "mint serviceaccount tokens",
        }),
        ns({
            group: "",
            resource: "secrets",
            verb: "get",
            label: "get secrets",
        }),
        ns({
            group: "",
            resource: "secrets",
            verb: "list",
            label: "list secrets",
        }),
        ns({
            group: "",
            resource: "secrets",
            verb: "watch",
            label: "watch secrets",
        }),
        {
            group: "apps",
            resource: "deployments",
            verb: "patch",
            label: "patch deployments cluster-wide",
        },
        ns({
            group: rbac,
            resource: "roles",
            verb: "escalate",
            label: "escalate roles",
        }),
        ns({
            group: rbac,
            resource: "roles",
            verb: "bind",
            label: "bind roles",
        }),
        ns({
            group: rbac,
            resource: "rolebindings",
            verb: "create",
            label: "create rolebindings",
        }),
        {
            group: rbac,
            resource: "clusterroles",
            verb: "escalate",
            label: "escalate clusterroles",
        },
        {
            group: rbac,
            resource: "clusterroles",
            verb: "bind",
            label: "bind clusterroles",
        },
        {
            group: rbac,
            resource: "clusterrolebindings",
            verb: "create",
            label: "create clusterrolebindings",
        },
        {
            group: "",
            resource: "users",
            verb: "impersonate",
            label: "impersonate another user",
        },
        {
            group: "",
            resource: "groups",
            verb: "impersonate",
            label: "impersonate a group",
        },
        {
            group: "",
            resource: "serviceaccounts",
            verb: "impersonate",
            label: "impersonate serviceaccounts",
        },
        {
            group: "",
            resource: "nodes",
            subresource: "proxy",
            verb: "get",
            label: "proxy to nodes (nodes/proxy)",
        },
    );
    return probes;
}

/** The Role rendered as YAML, for a namespace. ONE definition, rendered. */
export function renderRoleYaml(namespace: string): string {
    const rules = CI_ROLE_RULES.map(
        (r) =>
            `  - apiGroups:\n` +
            r.apiGroups.map((g) => `      - ${g}`).join("\n") +
            `\n    resources:\n` +
            r.resources.map((s) => `      - ${s}`).join("\n") +
            `\n    verbs:\n` +
            r.verbs.map((v) => `      - ${v}`).join("\n"),
    ).join("\n");

    return (
        "apiVersion: rbac.authorization.k8s.io/v1\n" +
        "kind: Role\n" +
        "metadata:\n" +
        "  name: knext-deployer\n" +
        `  namespace: ${namespace}\n` +
        "rules:\n" +
        `${rules}\n`
    );
}

/**
 * Printed WITH the findings, never instead of them. A refusal that says only
 * "too broad" leaves the reader to find the fix in a docs page they have not
 * opened; the point is that the fix and the problem share a screen.
 */
const ROLE_REMEDY = [
    "knext deploys by writing ONE kind of object, so it needs exactly this:",
    "",
    renderRoleYaml("<your-namespace>"),
    "Bind it to a ServiceAccount with a RoleBinding and use THAT account's",
    "kubeconfig as KNEXT_KUBECONFIG. `knext init-ci` generates all three.",
].join("\n");
