/**
 * doctor check "App image pullable" (#952, decision-free first step).
 *
 * The operator-image pullability probe (#198) already exists; #952's S3-V
 * evidence was a fresh namespace dying in ImagePullBackOff because the APP
 * image needed credentials nothing in the namespace carried. This suite pins
 * the app-image extension of that probe, hermetically (injected kubectl +
 * injected registry probe — no network, no cluster):
 *
 *   - pullable-pass:            anonymously pullable app image => pass
 *   - private-no-secret-warn:   auth-required + no dockerconfigjson Secret in
 *                               the namespace + no imagePullSecrets on the app
 *                               SA => warn naming ImagePullBackOff, with the
 *                               private-registry docs pointer
 *   - secret-present-pass:      auth-required but a credential is visible
 *                               (either carrier) => pass, worded as
 *                               presence-not-validity
 *   - unreachable-not-verified: registry unreachable => "not verified", NEVER
 *                               a pass (the honest-status shape of #198/#963)
 *   - creds-unreadable:         auth-required and RBAC denies reading
 *                               Secrets/ServiceAccounts => warn "could not
 *                               verify", never a pass
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
    type CheckResult,
    KOURIER_INGRESS_CLASS,
    type KubectlFn,
    type ManifestProbeFn,
    PRIVATE_REGISTRY_DOCS_URL,
    runDoctor,
} from "../cli/doctor";

/** Build a stub kubectl keyed on the joined argv (space-separated). */
function stubKubectl(
    table: Record<string, { ok: boolean; stdout?: string; stderr?: string }>,
): KubectlFn {
    return (args) => {
        const key = args.join(" ");
        const hit = table[key];
        if (!hit) {
            return { ok: false, stdout: "", stderr: `no stub for: ${key}` };
        }
        return {
            ok: hit.ok,
            stdout: hit.stdout ?? "",
            stderr: hit.stderr ?? "",
        };
    };
}

const OPERATOR_IMAGE =
    "ghcr.io/getknext-dev/kn-next-operator@sha256:75be42bb6b4c6d03c902b4fc90b36b246cc6cacf2233926fa183a6051521a99d";

const APP_IMAGE = "ocir.example.com/tenancy/shop@sha256:aaaa";

/** The v1alpha1 structural schema from the CRD this repo ships. */
function bundledCRDSchema(): unknown {
    const crd = YAML.parse(
        readFileSync(
            join(
                dirname(fileURLToPath(import.meta.url)),
                "..",
                "..",
                "..",
                "..",
                "packages",
                "kn-next-operator",
                "config",
                "crd",
                "bases",
                "apps.kn-next.dev_nextapps.yaml",
            ),
            "utf-8",
        ),
    ) as { spec: { versions: { schema: { openAPIV3Schema: unknown } }[] } };
    return crd.spec.versions[0]?.schema.openAPIV3Schema;
}

/**
 * A fully healthy cluster fixture carrying ONE NextApp (team-a/shop) so the
 * exit-code assertions below are about the app-image check alone — every
 * sibling check passes on this table.
 */
function healthyStubsWithApp(): Record<
    string,
    { ok: boolean; stdout?: string; stderr?: string }
> {
    return {
        "kubectl get --raw /version": { ok: true, stdout: "{}" },
        "kubectl version --client -o json": {
            ok: true,
            stdout: JSON.stringify({
                clientVersion: {
                    major: "1",
                    minor: "31",
                    gitVersion: "v1.31.2",
                },
            }),
        },
        "kubectl get crd nextapps.apps.kn-next.dev -o json": {
            ok: true,
            stdout: JSON.stringify({
                spec: {
                    versions: [
                        { name: "v1alpha1", served: true, storage: true },
                    ],
                },
            }),
        },
        "kubectl get deployments -n kn-next-operator-system -o json": {
            ok: true,
            stdout: JSON.stringify({
                items: [
                    {
                        metadata: {
                            name: "kn-next-operator-controller-manager",
                        },
                        spec: {
                            template: {
                                spec: {
                                    containers: [{ image: OPERATOR_IMAGE }],
                                },
                            },
                        },
                        status: { readyReplicas: 1, replicas: 1 },
                    },
                ],
            }),
        },
        "kubectl get deployment cert-manager-webhook -n cert-manager -o json": {
            ok: true,
            stdout: JSON.stringify({
                metadata: { name: "cert-manager-webhook" },
                status: { readyReplicas: 1, replicas: 1 },
            }),
        },
        "kubectl get configmap config-network -n knative-serving -o json": {
            ok: true,
            stdout: JSON.stringify({
                data: { "ingress-class": KOURIER_INGRESS_CLASS },
            }),
        },
        "kubectl get deployment net-kourier-controller -n knative-serving -o json":
            {
                ok: true,
                stdout: JSON.stringify({
                    metadata: { name: "net-kourier-controller" },
                    status: { readyReplicas: 1, replicas: 1 },
                }),
            },
        "kubectl get crd services.serving.knative.dev -o json": {
            ok: true,
            stdout: JSON.stringify({ spec: {} }),
        },
        "kubectl get configmap config-observability -n knative-serving -o json":
            {
                ok: true,
                stdout: JSON.stringify({
                    data: { "request-metrics-protocol": "none" },
                }),
            },
        "kubectl get nextapps --all-namespaces -o json": {
            ok: true,
            stdout: JSON.stringify({
                items: [
                    {
                        metadata: { name: "shop", namespace: "team-a" },
                        spec: { image: APP_IMAGE },
                    },
                ],
            }),
        },
        "kubectl get daemonsets --all-namespaces -o json": {
            ok: true,
            stdout: JSON.stringify({
                items: [
                    {
                        metadata: {
                            name: "calico-node",
                            namespace: "kube-system",
                        },
                        status: { desiredNumberScheduled: 3, numberReady: 3 },
                    },
                ],
            }),
        },
        "kubectl get --raw /openapi/v3/apis/apps.kn-next.dev/v1alpha1": {
            ok: true,
            stdout: JSON.stringify({
                components: {
                    schemas: {
                        "dev.kn-next.apps.v1alpha1.NextApp": bundledCRDSchema(),
                    },
                },
            }),
        },
        // Default credential carriers for team-a: nothing attached. Individual
        // tests override these two keys to build the secret-present branches.
        "kubectl get secrets -n team-a -o json": {
            ok: true,
            stdout: JSON.stringify({
                items: [
                    // an unrelated Opaque secret must NOT count as a credential
                    { metadata: { name: "app-env" }, type: "Opaque" },
                ],
            }),
        },
        "kubectl get serviceaccount shop-sa -n team-a -o json": {
            ok: true,
            stdout: JSON.stringify({
                metadata: { name: "shop-sa" },
                // no imagePullSecrets key at all
            }),
        },
    };
}

/**
 * The probe the app-image check must consult for the APP image. The operator
 * image stays pullable throughout so the sibling check (e) never pollutes the
 * exit code under test.
 */
function probeWith(
    appOutcome: "ok" | "auth-required" | "not-found" | "unreachable",
): ManifestProbeFn {
    return async (image) => (image === APP_IMAGE ? appOutcome : "ok");
}

function appImageCheck(checks: CheckResult[]): CheckResult {
    const c = checks.find((x) => x.id === "app-image");
    if (!c) {
        throw new Error(
            `no app-image check in [${checks.map((x) => x.id).join(", ")}]`,
        );
    }
    return c;
}

describe("doctor app-image pullability (#952)", () => {
    it("pullable app image => pass naming the app", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubsWithApp()),
            probeImage: probeWith("ok"),
        });
        const c = appImageCheck(report.checks);
        expect(c.status, c.detail).toBe("pass");
        expect(c.detail).toContain("team-a/shop");
        expect(report.exitCode).toBe(0);
    });

    it("private image + no visible credential => warn with ImagePullBackOff and the docs pointer; exit stays 0", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubsWithApp()),
            probeImage: probeWith("auth-required"),
        });
        const c = appImageCheck(report.checks);
        expect(c.status, c.detail).toBe("warn");
        expect(c.detail).toContain("team-a/shop");
        expect(c.detail).toContain("ImagePullBackOff");
        expect(c.detail).toContain(
            "Anonymous users are only allowed read access",
        );
        expect(c.hint ?? "").toContain("kubectl create secret docker-registry");
        expect(c.hint ?? "").toContain(PRIVATE_REGISTRY_DOCS_URL);
        // a WARN must never fail the preflight
        expect(report.exitCode).toBe(0);
    });

    it("private image + dockerconfigjson Secret in the namespace => pass, worded presence-not-validity", async () => {
        const stubs = healthyStubsWithApp();
        stubs["kubectl get secrets -n team-a -o json"] = {
            ok: true,
            stdout: JSON.stringify({
                items: [
                    {
                        metadata: { name: "ocir-secret" },
                        type: "kubernetes.io/dockerconfigjson",
                    },
                ],
            }),
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: probeWith("auth-required"),
        });
        const c = appImageCheck(report.checks);
        expect(c.status, c.detail).toBe("pass");
        expect(c.detail).toContain("team-a/shop");
        // presence is verified, authorization is not — the wording must say so
        expect(c.detail).toMatch(
            /presence|does not verify|not verified? that/i,
        );
        expect(report.exitCode).toBe(0);
    });

    it("private image + imagePullSecrets on the app SA => pass (the SA is a sufficient carrier)", async () => {
        const stubs = healthyStubsWithApp();
        stubs["kubectl get serviceaccount shop-sa -n team-a -o json"] = {
            ok: true,
            stdout: JSON.stringify({
                metadata: { name: "shop-sa" },
                imagePullSecrets: [{ name: "ocir-secret" }],
            }),
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: probeWith("auth-required"),
        });
        const c = appImageCheck(report.checks);
        expect(c.status, c.detail).toBe("pass");
        expect(report.exitCode).toBe(0);
    });

    it("registry unreachable => 'not verified' skip, NEVER a pass", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubsWithApp()),
            probeImage: probeWith("unreachable"),
        });
        const c = appImageCheck(report.checks);
        expect(c.status, c.detail).toBe("skip");
        expect(c.detail).toContain("not verified");
        expect(c.status).not.toBe("pass");
    });

    it("image missing from the registry => fail (and exit 1)", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubsWithApp()),
            probeImage: probeWith("not-found"),
        });
        const c = appImageCheck(report.checks);
        expect(c.status, c.detail).toBe("fail");
        expect(c.detail).toContain("team-a/shop");
        expect(report.exitCode).toBe(1);
    });

    it("private image + RBAC-denied Secret/SA reads => warn 'could not verify', never a pass", async () => {
        const stubs = healthyStubsWithApp();
        stubs["kubectl get secrets -n team-a -o json"] = {
            ok: false,
            stderr: 'Error from server (Forbidden): secrets is forbidden: User "doctor" cannot list resource "secrets"',
        };
        stubs["kubectl get serviceaccount shop-sa -n team-a -o json"] = {
            ok: false,
            stderr: 'Error from server (Forbidden): serviceaccounts "shop-sa" is forbidden',
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: probeWith("auth-required"),
        });
        const c = appImageCheck(report.checks);
        expect(c.status, c.detail).toBe("warn");
        expect(c.detail).toMatch(/could not verify|cannot determine/i);
        expect(c.status).not.toBe("pass");
    });

    it("SA absent (operator not yet reconciled) counts as no-SA-credential, not as unknown", async () => {
        const stubs = healthyStubsWithApp();
        stubs["kubectl get serviceaccount shop-sa -n team-a -o json"] = {
            ok: false,
            stderr: 'Error from server (NotFound): serviceaccounts "shop-sa" not found',
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: probeWith("auth-required"),
        });
        const c = appImageCheck(report.checks);
        // namespace has no dockerconfigjson, SA does not exist => full warn
        expect(c.status, c.detail).toBe("warn");
        expect(c.detail).toContain("ImagePullBackOff");
    });

    it("no NextApps => skip (nothing to verify), not a pass", async () => {
        const stubs = healthyStubsWithApp();
        stubs["kubectl get nextapps --all-namespaces -o json"] = {
            ok: true,
            stdout: JSON.stringify({ items: [] }),
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: probeWith("auth-required"),
        });
        const c = appImageCheck(report.checks);
        expect(c.status, c.detail).toBe("skip");
        expect(report.exitCode).toBe(0);
    });

    it("unreachable cluster => the check SKIPs like every cluster check", async () => {
        const kubectl: KubectlFn = () => ({
            ok: false,
            stdout: "",
            stderr: "The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?",
        });
        const report = await runDoctor({
            kubectl,
            probeImage: probeWith("ok"),
        });
        const c = appImageCheck(report.checks);
        expect(c.status).toBe("skip");
        expect(report.exitCode).toBe(0);
    });
});
