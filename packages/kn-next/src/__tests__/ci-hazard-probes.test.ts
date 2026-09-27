/**
 * The hazardous-permission probe set the action preflight submits as
 * SelfSubjectAccessReviews (#1495; review of #1557, round 2).
 *
 * On a webhook-authorized cluster (OKE, GKE with IAM) the rules review comes
 * back `incomplete` and says nothing about IAM-granted permissions, so these
 * point queries are the ONLY thing standing between an over-broad credential
 * and a deploy. A SelfSubjectAccessReview cannot enumerate "everything outside
 * the Role", so the set is DERIVED from the Role where it can be, plus a fixed
 * escalation list where it cannot:
 *
 *   1. every Role verb, asked in a FOREIGN namespace — the Role is
 *      namespaced, so an allow there means the grant is broader (a
 *      cluster-wide grant answers "yes" there too);
 *   2. every nextapps verb the Role does NOT grant, in the target namespace;
 *   3. a fixed list of escalation primitives.
 *
 * Tested against a simulated authorizer, both halves: the exact Role must
 * answer "no" to every probe (or the preflight refuses the credential knext
 * itself tells people to create), and the Role plus any ONE hazard must answer
 * "yes" to at least one probe (or the probe set is decoration).
 */
import { describe, expect, it } from "bun:test";
import {
    CI_ROLE_RULES,
    type HazardProbe,
    hazardProbes,
} from "../cli/ci/credential-scope";

/** One simulated grant. `ns: "*"` = every namespace AND cluster-wide. */
interface Grant {
    group: string;
    resource: string; // may carry "/subresource"
    verb: string;
    ns: string;
}

const m = (g: string, v: string) => g === "*" || g === v;

/** RBAC-shaped answer to one SelfSubjectAccessReview. */
function allows(grants: readonly Grant[], p: HazardProbe): boolean {
    const res = p.subresource ? `${p.resource}/${p.subresource}` : p.resource;
    return grants.some(
        (g) =>
            m(g.group, p.group) &&
            m(g.resource, res) &&
            m(g.verb, p.verb) &&
            (g.ns === "*" ||
                (p.namespace !== undefined && p.namespace === g.ns)),
    );
}

const NS = "demo";

/** Exactly what `kn-next init-ci` applies: the Role, bound in `demo`. */
const ROLE_GRANTS: Grant[] = CI_ROLE_RULES.flatMap((r) =>
    r.apiGroups.flatMap((group) =>
        r.resources.flatMap((resource) =>
            r.verbs.map((verb) => ({ group, resource, verb, ns: NS })),
        ),
    ),
);

const refused = (extra: Grant[]) =>
    hazardProbes(NS).some((p) => allows([...ROLE_GRANTS, ...extra], p));

describe("hazardProbes — the reviewed Role alone passes every probe", () => {
    it("the exact CI Role, bound in the target namespace, is allowed NOTHING the probes ask", () => {
        const hits = hazardProbes(NS).filter((p) => allows(ROLE_GRANTS, p));
        expect(hits.map((h) => h.label)).toEqual([]);
    });

    it("no probe restates a Role permission in the target namespace", () => {
        const roleVerbs = new Set<string>(CI_ROLE_RULES[0].verbs);
        for (const p of hazardProbes(NS)) {
            const insideRole =
                p.group === "apps.kn-next.dev" &&
                p.resource === "nextapps" &&
                !p.subresource &&
                p.namespace === NS &&
                roleVerbs.has(p.verb);
            expect(insideRole).toBe(false);
        }
    });

    it("every probe carries a human label", () => {
        for (const p of hazardProbes(NS))
            expect(p.label.length).toBeGreaterThan(0);
    });
});

describe("hazardProbes — derived from the Role", () => {
    for (const verb of CI_ROLE_RULES[0].verbs) {
        it(`refuses '${verb} nextapps' granted in a FOREIGN namespace only`, () => {
            expect(
                refused([
                    {
                        group: "apps.kn-next.dev",
                        resource: "nextapps",
                        verb,
                        ns: "kube-system",
                    },
                ]),
            ).toBe(true);
        });

        it(`refuses '${verb} nextapps' granted cluster-wide`, () => {
            expect(
                refused([
                    {
                        group: "apps.kn-next.dev",
                        resource: "nextapps",
                        verb,
                        ns: "*",
                    },
                ]),
            ).toBe(true);
        });
    }

    for (const verb of ["watch", "delete", "deletecollection", "*"]) {
        it(`refuses nextapps verb '${verb}', which the Role does not grant`, () => {
            expect(
                refused([
                    {
                        group: "apps.kn-next.dev",
                        resource: "nextapps",
                        verb,
                        ns: NS,
                    },
                ]),
            ).toBe(true);
        });
    }

    it("probes a DIFFERENT foreign namespace when the target is itself kube-system", () => {
        const foreign = hazardProbes("kube-system").filter(
            (p) => p.resource === "nextapps" && p.namespace !== undefined,
        );
        const namespaces = new Set(foreign.map((p) => p.namespace));
        expect([...namespaces].some((n) => n !== "kube-system")).toBe(true);
    });
});

describe("hazardProbes — fixed escalation list", () => {
    const cases: Array<[string, Grant]> = [
        [
            "create pods/exec",
            { group: "", resource: "pods/exec", verb: "create", ns: NS },
        ],
        [
            "create pods",
            { group: "", resource: "pods", verb: "create", ns: NS },
        ],
        [
            "create jobs",
            { group: "batch", resource: "jobs", verb: "create", ns: NS },
        ],
        [
            "create cronjobs",
            { group: "batch", resource: "cronjobs", verb: "create", ns: NS },
        ],
        [
            "patch deployments (namespaced)",
            { group: "apps", resource: "deployments", verb: "patch", ns: NS },
        ],
        [
            "create statefulsets",
            { group: "apps", resource: "statefulsets", verb: "create", ns: NS },
        ],
        [
            "create daemonsets",
            { group: "apps", resource: "daemonsets", verb: "create", ns: NS },
        ],
        [
            "patch services.serving.knative.dev",
            {
                group: "serving.knative.dev",
                resource: "services",
                verb: "patch",
                ns: NS,
            },
        ],
        [
            "create serviceaccounts",
            { group: "", resource: "serviceaccounts", verb: "create", ns: NS },
        ],
        [
            "create serviceaccounts/token",
            {
                group: "",
                resource: "serviceaccounts/token",
                verb: "create",
                ns: NS,
            },
        ],
        [
            "patch deployments cluster-wide",
            { group: "apps", resource: "deployments", verb: "patch", ns: "*" },
        ],
        [
            "get secrets",
            { group: "", resource: "secrets", verb: "get", ns: NS },
        ],
        [
            "list secrets",
            { group: "", resource: "secrets", verb: "list", ns: NS },
        ],
        [
            "watch secrets",
            { group: "", resource: "secrets", verb: "watch", ns: NS },
        ],
        [
            "escalate clusterroles",
            {
                group: "rbac.authorization.k8s.io",
                resource: "clusterroles",
                verb: "escalate",
                ns: "*",
            },
        ],
        [
            "bind clusterroles",
            {
                group: "rbac.authorization.k8s.io",
                resource: "clusterroles",
                verb: "bind",
                ns: "*",
            },
        ],
        [
            "escalate roles",
            {
                group: "rbac.authorization.k8s.io",
                resource: "roles",
                verb: "escalate",
                ns: NS,
            },
        ],
        [
            "bind roles",
            {
                group: "rbac.authorization.k8s.io",
                resource: "roles",
                verb: "bind",
                ns: NS,
            },
        ],
        [
            "create rolebindings",
            {
                group: "rbac.authorization.k8s.io",
                resource: "rolebindings",
                verb: "create",
                ns: NS,
            },
        ],
        [
            "create clusterrolebindings",
            {
                group: "rbac.authorization.k8s.io",
                resource: "clusterrolebindings",
                verb: "create",
                ns: "*",
            },
        ],
        [
            "impersonate serviceaccounts",
            {
                group: "",
                resource: "serviceaccounts",
                verb: "impersonate",
                ns: "*",
            },
        ],
        [
            "impersonate users",
            { group: "", resource: "users", verb: "impersonate", ns: "*" },
        ],
        [
            "impersonate groups",
            { group: "", resource: "groups", verb: "impersonate", ns: "*" },
        ],
        [
            "get nodes/proxy",
            { group: "", resource: "nodes/proxy", verb: "get", ns: "*" },
        ],
        ["*/*/*", { group: "*", resource: "*", verb: "*", ns: "*" }],
        ["*/*/get", { group: "*", resource: "*", verb: "get", ns: "*" }],
    ];
    for (const [label, grant] of cases) {
        it(`refuses the Role plus '${label}'`, () => {
            expect(refused([grant])).toBe(true);
        });
    }
});
