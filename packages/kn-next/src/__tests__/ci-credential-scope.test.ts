/**
 * ADR-0049 — the credential preflight (#874).
 *
 * The whole trust argument for stage-1 git integration is that CI needs
 * permission to write ONE kind of object in ONE namespace. That argument is
 * only worth anything if the Action actually **refuses** more than it asked
 * for. ADR-0049 says so in as many words: "a cluster-admin kubeconfig must be
 * refused, not merely discouraged … asking for less than you are offered is the
 * whole trust argument."
 *
 * So the classifier is the security boundary, and it is tested as one — both
 * halves. Over-broad credentials must be REFUSED (or the preflight is
 * decoration), and the exact Role ADR-0049 publishes must be ACCEPTED (or the
 * preflight refuses the only credential the docs tell people to create, which
 * is a different way of being useless).
 */
import { describe, expect, it } from "vitest";
import {
    CI_ROLE_RULES,
    classifyCredentialScope,
    renderRoleYaml,
} from "../cli/ci/credential-scope";

/**
 * What `kubectl auth can-i --list` reports for ANY authenticated subject, via
 * `system:basic-user` and `system:discovery`. It is present for a correctly
 * scoped ServiceAccount too, so a classifier that trips on it refuses
 * everything.
 */
const BASELINE = [
    {
        apiGroups: ["authorization.k8s.io"],
        resources: ["selfsubjectaccessreviews", "selfsubjectrulesreviews"],
        verbs: ["create"],
    },
];

/** The credential ADR-0049 tells the client to create. */
const SCOPED = [...BASELINE, ...CI_ROLE_RULES.map((r) => ({ ...r }))];

describe("ADR-0049 credential preflight (#874)", () => {
    it("accepts exactly the Role the docs publish", () => {
        const v = classifyCredentialScope(SCOPED);
        expect(v.findings).toEqual([]);
        expect(v.ok).toBe(true);
    });

    it("accepts the review-only baseline every authenticated subject carries", () => {
        // Not a corner: refusing this would refuse every ServiceAccount there
        // is, and the fastest way to make a security check get deleted is to
        // have it refuse the correct credential.
        expect(classifyCredentialScope(BASELINE).ok).toBe(true);
    });

    it("refuses cluster-admin — the wildcard rule", () => {
        const v = classifyCredentialScope([
            ...BASELINE,
            { apiGroups: ["*"], resources: ["*"], verbs: ["*"] },
        ]);
        expect(v.ok).toBe(false);
        expect(v.findings.join(" ")).toMatch(/wildcard/i);
    });

    it("refuses a credential that can read Secrets", () => {
        // The single worst thing a leaked CI token could hold: every database
        // password, registry credential and token in the namespace. knext's own
        // rules put secrets in Kubernetes Secrets precisely so that nothing but
        // the operator and the app need them.
        const v = classifyCredentialScope([
            ...SCOPED,
            { apiGroups: [""], resources: ["secrets"], verbs: ["get", "list"] },
        ]);
        expect(v.ok).toBe(false);
        expect(v.findings.join(" ")).toMatch(/secrets/i);
    });

    it("refuses a credential that can write core workloads directly", () => {
        // This one is architectural, not merely broad. ADR-0001 makes the
        // operator the single source of truth for cluster state; a CI token
        // that can create Deployments can mutate the cluster around it, and
        // then the CR no longer describes what is running.
        const v = classifyCredentialScope([
            ...SCOPED,
            {
                apiGroups: ["apps"],
                resources: ["deployments"],
                verbs: ["create", "update"],
            },
        ]);
        expect(v.ok).toBe(false);
        expect(v.findings.join(" ")).toMatch(/deployments/i);
    });

    it("refuses delete on nextapps — the verb the Role deliberately omits", () => {
        const v = classifyCredentialScope([
            ...BASELINE,
            {
                apiGroups: ["apps.kn-next.dev"],
                resources: ["nextapps"],
                verbs: ["get", "list", "create", "patch", "update", "delete"],
            },
        ]);
        expect(v.ok).toBe(false);
        expect(v.findings.join(" ")).toMatch(/delete/i);
    });

    it("refuses a wildcard verb even when the resource is scoped", () => {
        // `verbs: ['*']` on nextapps includes `delete`. Enumerating the bad
        // verbs and missing the wildcard is how this check would pass something
        // strictly worse than the case above.
        const v = classifyCredentialScope([
            ...BASELINE,
            {
                apiGroups: ["apps.kn-next.dev"],
                resources: ["nextapps"],
                verbs: ["*"],
            },
        ]);
        expect(v.ok).toBe(false);
    });

    it("tolerates the rule shapes the API actually returns", () => {
        // `SelfSubjectRulesReview` omits empty fields rather than sending `[]`,
        // and a classifier that assumes arrays throws on a real cluster — which
        // would fail closed, but with a stack trace instead of the Role.
        expect(() => classifyCredentialScope([{}])).not.toThrow();
        expect(() =>
            classifyCredentialScope([{ verbs: ["get"] }]),
        ).not.toThrow();
    });

    it("names what to do, not just what is wrong", () => {
        // A refusal that does not print the Role leaves the user to find it in
        // a docs page they have not opened. ADR-0049 requires the Role in the
        // failure, so the fix is in the same screen as the problem.
        const v = classifyCredentialScope([
            { apiGroups: ["*"], resources: ["*"], verbs: ["*"] },
        ]);
        expect(v.remedy).toContain("apps.kn-next.dev");
        expect(v.remedy).toContain("nextapps");
    });
});

describe("the published Role has ONE definition (#874)", () => {
    it("renders the rules rather than restating them", () => {
        // The Role appears in the ADR, the docs page, the generated manifest
        // and this check. Four copies of a permission list is how one of them
        // silently grants more than the others; the renderer makes the manifest
        // and the check read from the same constant.
        const yaml = renderRoleYaml("acme");
        for (const verb of CI_ROLE_RULES[0].verbs) {
            expect(yaml).toContain(`- ${verb}`);
        }
        expect(yaml).toContain("namespace: acme");
        expect(yaml).not.toContain("- delete");
    });

    it("grants nothing beyond nextapps", () => {
        const rendered = renderRoleYaml("acme");
        // Scanned, not enumerated: any apiGroup other than knext's in the Role
        // means the generator has widened past what the classifier accepts.
        const groups = [...rendered.matchAll(/apiGroups:\s*\n\s*- (\S+)/g)].map(
            (m) => m[1],
        );
        expect(new Set(groups)).toEqual(new Set(["apps.kn-next.dev"]));
    });

    it("the Role it generates passes its own classifier", () => {
        // The end-to-end property that makes the two halves one thing: what
        // `init-ci` tells the client to apply must be what the preflight then
        // accepts. If they drift, every user hits a refusal on the credential
        // knext itself generated.
        expect(classifyCredentialScope([...CI_ROLE_RULES]).ok).toBe(true);
    });
});
