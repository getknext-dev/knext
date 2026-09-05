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
 *   - sa-attached-pass:         auth-required but the app SA lists
 *                               imagePullSecrets => pass, worded as
 *                               attachment-not-authorization. The SA is the
 *                               ONLY carrier that can pass: pods resolve pull
 *                               secrets from the SA at pod creation
 *   - unattached-secret-warn:   auth-required + a dockerconfigjson Secret in
 *                               the namespace that no SA references => WARN
 *                               (the created-the-secret-skipped-the-attach
 *                               mistake), never a pass
 *   - unreachable-not-verified: registry unreachable => "not verified", NEVER
 *                               a pass (the honest-status shape of #198/#963)
 *   - budget-exhausted:         probe budget 0 => "not verified", never a pass
 *   - creds-unreadable:         auth-required and RBAC denies reading the
 *                               SA/Secrets => warn "could not verify", never a
 *                               pass
 *   - 404-ambiguity:            not-found => warn (Artifactory/Harbor answer
 *                               404 for private repos, so "does not exist"
 *                               would false-red them), not a hard fail
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
        // tests override these two keys to build the credential branches. The
        // listing is field-selector-narrowed to dockerconfigjson and -o name
        // (no Secret payloads are ever materialized).
        "kubectl get secrets -n team-a --field-selector type=kubernetes.io/dockerconfigjson -o name":
            {
                ok: true,
                stdout: "",
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

    it("private image + UNATTACHED dockerconfigjson Secret in the namespace => WARN, never a pass", async () => {
        const stubs = healthyStubsWithApp();
        stubs[
            "kubectl get secrets -n team-a --field-selector type=kubernetes.io/dockerconfigjson -o name"
        ] = {
            ok: true,
            stdout: "secret/ocir-secret\n",
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: probeWith("auth-required"),
        });
        const c = appImageCheck(report.checks);
        // The blocking-review fix: pods resolve pull secrets from the
        // ServiceAccount, not from the namespace, so an unattached Secret is
        // the exact "created the secret, skipped the attach" mistake — a pass
        // here would greenlight the failure mode the docs page warns about.
        expect(c.status, c.detail).toBe("warn");
        expect(c.status).not.toBe("pass");
        expect(c.detail).toContain("team-a/shop");
        expect(c.detail).toMatch(/lists no imagePullSecrets/);
        expect(c.detail).toMatch(/attach it, then redeploy/);
        expect(c.hint ?? "").toContain("kubectl patch serviceaccount");
        // the strategic-merge patch replaces the whole list — the hint says so
        expect(c.hint ?? "").toMatch(
            /REPLACES the whole imagePullSecrets list/,
        );
        expect(c.hint ?? "").toContain(PRIVATE_REGISTRY_DOCS_URL);
        expect(report.exitCode).toBe(0);
    });

    it("private image + imagePullSecrets on the app SA => pass, worded attachment-not-authorization", async () => {
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
        expect(c.detail).toContain("team-a/shop");
        // attachment is verified, authorization is not — the wording says so
        expect(c.detail).toMatch(/attached to the app ServiceAccount/);
        expect(c.detail).toMatch(/not that the credential actually authorizes/);
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

    it("image 404s anonymously => warn stating the ambiguity (Artifactory/Harbor 404 private repos), exit stays 0", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubsWithApp()),
            probeImage: probeWith("not-found"),
        });
        const c = appImageCheck(report.checks);
        // 404 anonymously is AMBIGUOUS: truly-missing image OR a registry
        // that hides private repos behind 404 — a hard fail would false-red
        // every Artifactory/Harbor private repo, so this warns with both
        // readings and never exits 1 for it.
        expect(c.status, c.detail).toBe("warn");
        expect(c.detail).toContain("team-a/shop");
        expect(c.detail).toContain("404");
        expect(c.detail).toMatch(/does not exist|hides private repositories/);
        expect(report.exitCode).toBe(0);
    });

    it("probe budget exhausted => 'not verified' skip, NEVER a pass", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubsWithApp()),
            probeImage: probeWith("ok"),
            appImageProbeBudgetMs: 0,
        });
        const c = appImageCheck(report.checks);
        expect(c.status, c.detail).toBe("skip");
        expect(c.detail).toContain("not verified");
        expect(c.status).not.toBe("pass");
        expect(report.exitCode).toBe(0);
    });

    it("private image + RBAC-denied SA read => warn 'could not verify', never a pass", async () => {
        const stubs = healthyStubsWithApp();
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
