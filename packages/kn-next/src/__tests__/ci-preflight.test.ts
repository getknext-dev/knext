/**
 * `runCiPreflight` (#1534) — the orchestration `ci-preflight-cmd.ts` exposes
 * as `knext ci-preflight`, ported from `packages/kn-next-action/preflight.mjs`
 * so a non-GitHub CI provider (starting with `init-ci --provider gitlab`) can
 * run the SAME hazard preflight through the published CLI rather than a
 * shell script re-deriving the rules.
 *
 * Hermetic throughout: `readFile` and `kubectlRaw` are injected, so nothing
 * here spawns a real kubectl or touches a real file. The rule modules
 * (`classifyKubeconfigSafety`, `classifyCredentialScope`, `hazardProbes`) are
 * the real, shipped ones — only the cluster/filesystem boundary is faked.
 */
import { describe, expect, it } from "bun:test";
import { runCiPreflight } from "../cli/ci/ci-preflight";
import { CI_ROLE_RULES } from "../cli/ci/credential-scope";

const NS = "acme";
const TOKEN_KUBECONFIG = [
    "apiVersion: v1",
    "kind: Config",
    "users:",
    "  - name: knext-deployer",
    "    user:",
    "      token: abc",
    "contexts: []",
    "",
].join("\n");

const EXEC_KUBECONFIG = [
    "apiVersion: v1",
    "kind: Config",
    "users:",
    "  - name: admin",
    "    user:",
    "      exec:",
    "        command: aws",
    "contexts: []",
    "",
].join("\n");

/** A fake `kubectlRaw`: rules review answers with exactly the published
 * Role's grants (complete, not `incomplete`); access reviews answer allowed
 * iff a GRANTS entry `group|resource[/sub]|verb|ns` matches. */
function fakeKubectlRaw(
    grants: string[],
): (rawPath: string, body: string) => string {
    return (_rawPath, body) => {
        const parsed = JSON.parse(body) as {
            kind: string;
            spec: {
                namespace?: string;
                resourceAttributes?: Record<string, unknown>;
            };
        };
        if (parsed.kind === "SelfSubjectRulesReview") {
            return JSON.stringify({
                status: {
                    incomplete: false,
                    resourceRules: CI_ROLE_RULES.map((r) => ({
                        apiGroups: r.apiGroups,
                        resources: r.resources,
                        verbs: r.verbs,
                    })),
                },
            });
        }
        const a = parsed.spec.resourceAttributes as {
            group: string;
            resource: string;
            subresource?: string;
            verb: string;
            namespace?: string;
        };
        const res = a.subresource
            ? `${a.resource}/${a.subresource}`
            : a.resource;
        const match = (g: string, v: string) => g === "*" || g === v;
        const allowed = grants.some((g) => {
            const [group, resource, verb, ns] = g.split("|");
            return (
                match(group ?? "", a.group) &&
                match(resource ?? "", res) &&
                match(verb ?? "", a.verb) &&
                (ns === "*" ||
                    (a.namespace !== undefined && a.namespace === ns))
            );
        });
        return JSON.stringify({ status: { allowed } });
    };
}

const ROLE_GRANTS = ["get", "list", "create", "patch", "update"].map(
    (v) => `apps.kn-next.dev|nextapps|${v}|${NS}`,
);

describe("runCiPreflight — the kubeconfig-safety refusal runs first, before any kubectl call", () => {
    it("refuses an exec-plugin kubeconfig without ever calling kubectlRaw", () => {
        let called = false;
        const result = runCiPreflight({
            namespace: NS,
            kubeconfigPath: "/fake/kubeconfig",
            readFile: () => EXEC_KUBECONFIG,
            kubectlRaw: () => {
                called = true;
                return "{}";
            },
        });
        expect(result.ok).toBe(false);
        expect(result.lines.join("\n")).toContain(
            "This kubeconfig needs cloud-account credentials on the runner.",
        );
        expect(called).toBe(false);
    });

    it("refuses, fail-closed, when the kubeconfig file cannot be read", () => {
        const result = runCiPreflight({
            namespace: NS,
            kubeconfigPath: "/fake/missing",
            readFile: () => {
                throw new Error("ENOENT: no such file");
            },
            kubectlRaw: () => "{}",
        });
        expect(result.ok).toBe(false);
        expect(result.lines.join("\n")).toContain("could not read");
    });
});

describe("runCiPreflight — passes a correctly-scoped credential", () => {
    it("ok:true for exactly the published Role in the target namespace", () => {
        const result = runCiPreflight({
            namespace: NS,
            kubeconfigPath: "/fake/kubeconfig",
            readFile: () => TOKEN_KUBECONFIG,
            kubectlRaw: fakeKubectlRaw(ROLE_GRANTS),
        });
        expect(result.ok).toBe(true);
        expect(result.lines.join("\n")).toContain("correctly scoped");
    });
});

describe("runCiPreflight — refuses a credential broader than the published Role", () => {
    const broader: Array<[string, string]> = [
        ["nextapps granted cluster-wide", "apps.kn-next.dev|nextapps|create|*"],
        ["create pods/exec", `|pods/exec|create|${NS}`],
        ["list secrets", `|secrets|list|${NS}`],
        ["*/*/*", "*|*|*|*"],
    ];
    for (const [label, grant] of broader) {
        it(`refuses the Role plus ${label}`, () => {
            const result = runCiPreflight({
                namespace: NS,
                kubeconfigPath: "/fake/kubeconfig",
                readFile: () => TOKEN_KUBECONFIG,
                kubectlRaw: fakeKubectlRaw([...ROLE_GRANTS, grant]),
            });
            expect(result.ok).toBe(false);
            expect(result.lines.join("\n")).toContain(
                "can do things far outside what knext needs",
            );
        });
    }
});

describe("runCiPreflight — the credential-scope refusal catches what the hazard probes alone would not", () => {
    it("refuses when the RULES REVIEW itself reports a resource outside the published Role, even though no hazard probe for it exists", () => {
        // `configmaps get` is outside CI_ROLE_RULES but is not on the fixed
        // hazard-escalation list `hazardProbes()` derives — so only
        // `classifyCredentialScope`, reading the SelfSubjectRulesReview
        // directly, catches it. Proves the two checks are not redundant.
        const result = runCiPreflight({
            namespace: NS,
            kubeconfigPath: "/fake/kubeconfig",
            readFile: () => TOKEN_KUBECONFIG,
            kubectlRaw: (rawPath, body) => {
                const parsed = JSON.parse(body) as { kind: string };
                if (parsed.kind === "SelfSubjectRulesReview") {
                    return JSON.stringify({
                        status: {
                            incomplete: false,
                            resourceRules: [
                                ...CI_ROLE_RULES,
                                {
                                    apiGroups: [""],
                                    resources: ["configmaps"],
                                    verbs: ["get"],
                                },
                            ],
                        },
                    });
                }
                // The hazard spot-check itself finds nothing: every probe is
                // answered against exactly the published Role's grants.
                return fakeKubectlRaw(ROLE_GRANTS)(rawPath, body);
            },
        });
        expect(result.ok).toBe(false);
        expect(result.lines.join("\n")).toContain(
            "grants more than knext needs",
        );
    });
});

describe("runCiPreflight — fails closed when a review cannot be run at all", () => {
    it("refuses when the rules review throws", () => {
        const result = runCiPreflight({
            namespace: NS,
            kubeconfigPath: "/fake/kubeconfig",
            readFile: () => TOKEN_KUBECONFIG,
            kubectlRaw: () => {
                throw new Error("connection refused");
            },
        });
        expect(result.ok).toBe(false);
        expect(result.lines.join("\n")).toContain(
            "Could not determine what this credential can do",
        );
    });

    it("refuses when a hazard probe's access review returns no boolean verdict", () => {
        let calls = 0;
        const result = runCiPreflight({
            namespace: NS,
            kubeconfigPath: "/fake/kubeconfig",
            readFile: () => TOKEN_KUBECONFIG,
            kubectlRaw: (rawPath, body) => {
                const parsed = JSON.parse(body) as { kind: string };
                if (parsed.kind === "SelfSubjectRulesReview") {
                    return fakeKubectlRaw(ROLE_GRANTS)(rawPath, body);
                }
                calls += 1;
                // No boolean `allowed` at all.
                return JSON.stringify({ status: {} });
            },
        });
        expect(result.ok).toBe(false);
        expect(calls).toBeGreaterThan(0);
        expect(result.lines.join("\n")).toContain(
            "Could not run the hazardous-permission spot-check",
        );
    });
});

describe("runCiPreflight — the incomplete rules review is a warning, not a refusal by itself", () => {
    it("still passes a correctly-scoped credential on a webhook-authorized (incomplete) cluster", () => {
        const result = runCiPreflight({
            namespace: NS,
            kubeconfigPath: "/fake/kubeconfig",
            readFile: () => TOKEN_KUBECONFIG,
            kubectlRaw: (rawPath, body) => {
                const parsed = JSON.parse(body) as { kind: string };
                if (parsed.kind === "SelfSubjectRulesReview") {
                    return JSON.stringify({
                        status: {
                            incomplete: true,
                            evaluationError:
                                "webhook authorizer does not support user rule resolution",
                            resourceRules: [],
                        },
                    });
                }
                return fakeKubectlRaw(ROLE_GRANTS)(rawPath, body);
            },
        });
        expect(result.ok).toBe(true);
        expect(result.lines.join("\n")).toContain("incomplete");
    });
});
