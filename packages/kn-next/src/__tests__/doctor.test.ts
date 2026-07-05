/**
 * `kn-next doctor` — cluster-prereq preflight (Workstream C).
 *
 * Every check is field-learned:
 *   (a) NextApp CRD present + served version
 *   (b) operator Deployment Ready in kn-next-operator-system
 *   (c) cert-manager webhook prereq
 *   (d) ingress-class vs the reconciler that actually serves it (#208's
 *       silently-skipped-KIngress lesson, incl. the KnativeServing-CR clobber note)
 *   (e) operator-image anonymous pullability (#198's private-ghcr lesson)
 *   (f) Knative Serving present
 *
 * All cluster I/O goes through an injectable kubectl runner and an injectable
 * registry manifest probe, so these tests are fully hermetic. An unreachable
 * cluster degrades every check to a clear SKIP (never a crash, never exit 1).
 */

import { describe, expect, it, vi } from "vitest";
import {
    type CheckResult,
    formatDoctorTable,
    KOURIER_INGRESS_CLASS,
    type KubectlFn,
    type ManifestProbeFn,
    parseDoctorArgs,
    parseImageRef,
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

const deployJson = (name: string, image: string, ready = 1) =>
    JSON.stringify({
        items: [
            {
                metadata: { name },
                spec: {
                    template: { spec: { containers: [{ image }] } },
                },
                status: { readyReplicas: ready, replicas: 1 },
            },
        ],
    });

const singleDeployJson = (name: string, ready = 1) =>
    JSON.stringify({
        metadata: { name },
        status: { readyReplicas: ready, replicas: 1 },
    });

const OPERATOR_IMAGE =
    "ghcr.io/getknext-dev/kn-next-operator@sha256:75be42bb6b4c6d03c902b4fc90b36b246cc6cacf2233926fa183a6051521a99d";

/** A fully healthy cluster fixture. */
function healthyStubs(): Record<
    string,
    { ok: boolean; stdout?: string; stderr?: string }
> {
    return {
        "kubectl get --raw /version": { ok: true, stdout: "{}" },
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
            stdout: deployJson(
                "kn-next-operator-controller-manager",
                OPERATOR_IMAGE,
            ),
        },
        "kubectl get deployment cert-manager-webhook -n cert-manager -o json": {
            ok: true,
            stdout: singleDeployJson("cert-manager-webhook"),
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
                stdout: singleDeployJson("net-kourier-controller"),
            },
        "kubectl get crd services.serving.knative.dev -o json": {
            ok: true,
            stdout: JSON.stringify({ spec: {} }),
        },
    };
}

const okProbe: ManifestProbeFn = async () => "ok";

function byId(checks: CheckResult[]): Record<string, CheckResult> {
    return Object.fromEntries(checks.map((c) => [c.id, c]));
}

describe("runDoctor — healthy cluster", () => {
    it("all checks pass and the exit code is 0", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubs()),
            probeImage: okProbe,
        });
        const ids = report.checks.map((c) => c.id);
        expect(ids).toEqual([
            "cluster",
            "crd",
            "operator",
            "cert-manager",
            "ingress",
            "image",
            "knative",
        ]);
        for (const c of report.checks) {
            expect(c.status, `${c.id}: ${c.detail}`).toBe("pass");
        }
        expect(report.exitCode).toBe(0);
    });
});

describe("runDoctor — unreachable cluster degrades to SKIP", () => {
    it("every cluster check SKIPs with a clear reason and the exit code stays 0", async () => {
        const kubectl: KubectlFn = () => ({
            ok: false,
            stdout: "",
            stderr: "The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?",
        });
        const probe = vi.fn(okProbe);
        const report = await runDoctor({ kubectl, probeImage: probe });
        const checks = byId(report.checks);
        expect(checks.cluster.status).toBe("warn");
        for (const id of [
            "crd",
            "operator",
            "cert-manager",
            "ingress",
            "image",
            "knative",
        ]) {
            expect(checks[id].status, id).toBe("skip");
            expect(checks[id].detail).toMatch(/unreachable/i);
        }
        // No registry probe without an image ref from the cluster.
        expect(probe).toHaveBeenCalledTimes(0);
        expect(report.exitCode).toBe(0);
    });
});

describe("runDoctor — check (a) NextApp CRD", () => {
    it("fails when the CRD is missing (exit 1)", async () => {
        const stubs = healthyStubs();
        stubs["kubectl get crd nextapps.apps.kn-next.dev -o json"] = {
            ok: false,
            stderr: 'Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "nextapps.apps.kn-next.dev" not found',
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        expect(byId(report.checks).crd.status).toBe("fail");
        expect(report.exitCode).toBe(1);
    });

    it("fails when no version is served, and reports the served version when one is", async () => {
        const stubs = healthyStubs();
        stubs["kubectl get crd nextapps.apps.kn-next.dev -o json"] = {
            ok: true,
            stdout: JSON.stringify({
                spec: { versions: [{ name: "v1alpha1", served: false }] },
            }),
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        expect(byId(report.checks).crd.status).toBe("fail");

        const healthy = await runDoctor({
            kubectl: stubKubectl(healthyStubs()),
            probeImage: okProbe,
        });
        expect(byId(healthy.checks).crd.detail).toContain("v1alpha1");
    });
});

describe("runDoctor — check (b) operator Deployment", () => {
    it("fails when the operator deployment exists but is not Ready", async () => {
        const stubs = healthyStubs();
        stubs["kubectl get deployments -n kn-next-operator-system -o json"] = {
            ok: true,
            stdout: deployJson(
                "kn-next-operator-controller-manager",
                OPERATOR_IMAGE,
                0,
            ),
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        expect(byId(report.checks).operator.status).toBe("fail");
        expect(report.exitCode).toBe(1);
    });

    it("fails when the namespace/deployment is absent, and skips the image probe", async () => {
        const stubs = healthyStubs();
        stubs["kubectl get deployments -n kn-next-operator-system -o json"] = {
            ok: false,
            stderr: 'namespaces "kn-next-operator-system" not found',
        };
        const probe = vi.fn(okProbe);
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: probe,
        });
        const checks = byId(report.checks);
        expect(checks.operator.status).toBe("fail");
        expect(checks.image.status).toBe("skip");
        expect(probe).toHaveBeenCalledTimes(0);
    });
});

describe("runDoctor — check (c) cert-manager webhook", () => {
    it("warns (not fails) when cert-manager-webhook is absent", async () => {
        const stubs = healthyStubs();
        stubs[
            "kubectl get deployment cert-manager-webhook -n cert-manager -o json"
        ] = { ok: false, stderr: "NotFound" };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        expect(byId(report.checks)["cert-manager"].status).toBe("warn");
        expect(report.exitCode).toBe(0);
    });
});

describe("runDoctor — check (d) ingress-class (#208)", () => {
    it("warns on a class/reconciler mismatch and mentions the KnativeServing-CR clobber note", async () => {
        const stubs = healthyStubs();
        stubs[
            "kubectl get configmap config-network -n knative-serving -o json"
        ] = {
            ok: true,
            stdout: JSON.stringify({
                data: { "ingress-class": "kourier.knative.dev" },
            }),
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        const ingress = byId(report.checks).ingress;
        expect(ingress.status).toBe("warn");
        expect(ingress.detail).toContain(KOURIER_INGRESS_CLASS);
        expect(ingress.detail).toMatch(/silently/i);
        expect(ingress.detail).toMatch(/KnativeServing/);
    });

    it("fails when the class is kourier's but no kourier reconciler deployment exists", async () => {
        const stubs = healthyStubs();
        delete stubs[
            "kubectl get deployment net-kourier-controller -n knative-serving -o json"
        ];
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        expect(byId(report.checks).ingress.status).toBe("fail");
    });

    it("finds the kourier controller in the kourier-system fallback namespace", async () => {
        const stubs = healthyStubs();
        delete stubs[
            "kubectl get deployment net-kourier-controller -n knative-serving -o json"
        ];
        stubs[
            "kubectl get deployment net-kourier-controller -n kourier-system -o json"
        ] = { ok: true, stdout: singleDeployJson("net-kourier-controller") };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        expect(byId(report.checks).ingress.status).toBe("pass");
    });

    it("reads the legacy ingress.class key", async () => {
        const stubs = healthyStubs();
        stubs[
            "kubectl get configmap config-network -n knative-serving -o json"
        ] = {
            ok: true,
            stdout: JSON.stringify({
                data: { "ingress.class": KOURIER_INGRESS_CLASS },
            }),
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        expect(byId(report.checks).ingress.status).toBe("pass");
    });
});

describe("runDoctor — check (e) image pullability (#198)", () => {
    it("probes the operator's configured image ref and passes when anonymously pullable", async () => {
        const probe = vi.fn(okProbe);
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubs()),
            probeImage: probe,
        });
        expect(probe).toHaveBeenCalledWith(OPERATOR_IMAGE);
        expect(byId(report.checks).image.status).toBe("pass");
    });

    it("warns when the registry requires auth (private ghcr package)", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubs()),
            probeImage: async () => "auth-required",
        });
        const image = byId(report.checks).image;
        expect(image.status).toBe("warn");
        expect(image.detail).toMatch(/anonymous|imagePullSecret/i);
    });

    it("fails when the manifest does not exist", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubs()),
            probeImage: async () => "not-found",
        });
        expect(byId(report.checks).image.status).toBe("fail");
        expect(report.exitCode).toBe(1);
    });

    it("skips gracefully when offline", async () => {
        const report = await runDoctor({
            kubectl: stubKubectl(healthyStubs()),
            probeImage: async () => "unreachable",
        });
        expect(byId(report.checks).image.status).toBe("skip");
        expect(report.exitCode).toBe(0);
    });
});

describe("runDoctor — check (f) Knative Serving", () => {
    it("fails when the Knative Service CRD is missing", async () => {
        const stubs = healthyStubs();
        stubs["kubectl get crd services.serving.knative.dev -o json"] = {
            ok: false,
            stderr: "NotFound",
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        expect(byId(report.checks).knative.status).toBe("fail");
    });
});

describe("parseImageRef", () => {
    it("splits registry / repository / reference for a digest-pinned ghcr ref", () => {
        expect(parseImageRef(OPERATOR_IMAGE)).toEqual({
            registry: "ghcr.io",
            repository: "getknext-dev/kn-next-operator",
            reference:
                "sha256:75be42bb6b4c6d03c902b4fc90b36b246cc6cacf2233926fa183a6051521a99d",
        });
    });

    it("handles tag refs and docker-hub-style short names", () => {
        expect(parseImageRef("ghcr.io/acme/app:v1")).toEqual({
            registry: "ghcr.io",
            repository: "acme/app",
            reference: "v1",
        });
        expect(parseImageRef("nginx:1.27")).toEqual({
            registry: "registry-1.docker.io",
            repository: "library/nginx",
            reference: "1.27",
        });
    });
});

describe("output surface", () => {
    it("formatDoctorTable renders one status-tagged row per check", () => {
        const table = formatDoctorTable([
            { id: "crd", title: "NextApp CRD", status: "pass", detail: "ok" },
            {
                id: "ingress",
                title: "Ingress class",
                status: "warn",
                detail: "w",
            },
            {
                id: "image",
                title: "Operator image",
                status: "fail",
                detail: "f",
            },
            { id: "knative", title: "Knative", status: "skip", detail: "s" },
        ]);
        expect(table).toContain("PASS");
        expect(table).toContain("WARN");
        expect(table).toContain("FAIL");
        expect(table).toContain("SKIP");
        expect(table).toContain("NextApp CRD");
    });

    it("parseDoctorArgs understands --json", () => {
        expect(parseDoctorArgs(["--json"]).json).toBe(true);
        expect(parseDoctorArgs([]).json).toBe(false);
    });
});
