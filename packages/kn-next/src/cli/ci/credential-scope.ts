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
 * `kn-next init-ci` generates, and this check. Four hand-maintained copies of a
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
    "kubeconfig as KNEXT_KUBECONFIG. `kn-next init-ci` generates all three.",
].join("\n");
