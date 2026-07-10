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
    classifyKubectlFailure,
    formatDoctorTable,
    KOURIER_INGRESS_CLASS,
    type KubectlFn,
    type ManifestProbeFn,
    parseDoctorArgs,
    parseImageRef,
    probeManifest,
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

// #230: kubectl probe failures caused by the PROBE PATH (network, TLS, expired
// credentials) must never be diagnosed as cluster-state facts ("not found").
// Field-learned on OKE over a flaky WAN: an expired session token made doctor
// report a healthy cluster as missing its operator.
const TLS_TIMEOUT_STDERR =
    "Unable to connect to the server: net/http: TLS handshake timeout";
const CRED_EXEC_STDERR =
    "Unable to connect to the server: getting credentials: exec: executable oci failed with exit code 1";
const NOTFOUND_CRD_STDERR =
    'Error from server (NotFound): customresourcedefinitions.apiextensions.k8s.io "nextapps.apps.kn-next.dev" not found';

describe("classifyKubectlFailure (#230) — conservative stderr classifier", () => {
    it("maps NotFound-style stderr to not-found (today's behavior)", () => {
        expect(classifyKubectlFailure(NOTFOUND_CRD_STDERR)).toBe("not-found");
        expect(
            classifyKubectlFailure(
                'namespaces "kn-next-operator-system" not found',
            ),
        ).toBe("not-found");
        expect(
            classifyKubectlFailure(
                'error: the server doesn\'t have a resource type "nextapps"',
            ),
        ).toBe("not-found");
    });

    it("maps clearly-infrastructural network signatures to network", () => {
        expect(classifyKubectlFailure(TLS_TIMEOUT_STDERR)).toBe("network");
        expect(
            classifyKubectlFailure(
                "The connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?",
            ),
        ).toBe("network");
        expect(
            classifyKubectlFailure(
                "Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout",
            ),
        ).toBe("network");
    });

    it("maps credential/authn signatures to auth", () => {
        expect(classifyKubectlFailure(CRED_EXEC_STDERR)).toBe("auth");
        expect(
            classifyKubectlFailure(
                "error: You must be logged in to the server (Unauthorized)",
            ),
        ).toBe("auth");
    });

    it("keeps anything ambiguous as unknown (falls back to today's behavior)", () => {
        expect(classifyKubectlFailure("")).toBe("unknown");
        expect(classifyKubectlFailure("some novel kubectl error")).toBe(
            "unknown",
        );
    });
});

describe("runDoctor — probe-infra errors are not 'not found' (#230)", () => {
    /** Run doctor with the crd probe replaced by the given failure. */
    async function crdCheckWith(stderr: string): Promise<{
        crd: CheckResult;
        exitCode: 0 | 1;
    }> {
        const stubs = healthyStubs();
        stubs["kubectl get crd nextapps.apps.kn-next.dev -o json"] = {
            ok: false,
            stderr,
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        return { crd: byId(report.checks).crd, exitCode: report.exitCode };
    }

    it("(a) NotFound stderr stays a not-found FAIL", async () => {
        const { crd } = await crdCheckWith(NOTFOUND_CRD_STDERR);
        expect(crd.status).toBe("fail");
        expect(crd.detail).toMatch(/not found/i);
    });

    it("(b) TLS-timeout stderr becomes a distinct ERROR carrying the stderr excerpt, not a not-found (exit 1)", async () => {
        const { crd, exitCode } = await crdCheckWith(TLS_TIMEOUT_STDERR);
        expect(crd.status).toBe("error");
        expect(crd.detail).not.toMatch(/not found/i);
        expect(crd.detail).toContain("TLS handshake timeout");
        expect(crd.hint).toBeTruthy();
        // The preflight could not verify the cluster — that is not a green run.
        expect(exitCode).toBe(1);
    });

    it("(c) credential-exec-failure stderr becomes an auth ERROR with a re-authenticate hint", async () => {
        const { crd } = await crdCheckWith(CRED_EXEC_STDERR);
        expect(crd.status).toBe("error");
        expect(crd.detail).not.toMatch(/not found/i);
        expect(crd.detail).toContain("getting credentials: exec");
        expect(crd.hint).toMatch(/re-authenticate/i);
    });

    it("ambiguous stderr keeps today's not-found FAIL behavior", async () => {
        const { crd } = await crdCheckWith("some novel kubectl error");
        expect(crd.status).toBe("fail");
        expect(crd.detail).toMatch(/not found/i);
    });

    it("cert-manager probe infra failure is an ERROR, not the not-installed WARN", async () => {
        const stubs = healthyStubs();
        stubs[
            "kubectl get deployment cert-manager-webhook -n cert-manager -o json"
        ] = { ok: false, stderr: TLS_TIMEOUT_STDERR };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        const cm = byId(report.checks)["cert-manager"];
        expect(cm.status).toBe("error");
        expect(cm.detail).not.toMatch(/not found/i);
    });

    it("operator-deployment probe infra failure is an ERROR and still skips the image probe", async () => {
        const stubs = healthyStubs();
        stubs["kubectl get deployments -n kn-next-operator-system -o json"] = {
            ok: false,
            stderr: CRED_EXEC_STDERR,
        };
        const probe = vi.fn(okProbe);
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: probe,
        });
        const checks = byId(report.checks);
        expect(checks.operator.status).toBe("error");
        expect(checks.image.status).toBe("skip");
        expect(probe).toHaveBeenCalledTimes(0);
    });

    it("kourier-reconciler probe infra failure is an ERROR, not a missing-reconciler FAIL", async () => {
        const stubs = healthyStubs();
        stubs[
            "kubectl get deployment net-kourier-controller -n knative-serving -o json"
        ] = { ok: false, stderr: TLS_TIMEOUT_STDERR };
        stubs[
            "kubectl get deployment net-kourier-controller -n kourier-system -o json"
        ] = { ok: false, stderr: TLS_TIMEOUT_STDERR };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        const ingress = byId(report.checks).ingress;
        expect(ingress.status).toBe("error");
        expect(ingress.detail).not.toMatch(/no Ready net-kourier/i);
    });

    it("gate failure keeps the documented warn+SKIP (exit 0) contract but surfaces the auth hint", async () => {
        const kubectl: KubectlFn = () => ({
            ok: false,
            stdout: "",
            stderr: CRED_EXEC_STDERR,
        });
        const report = await runDoctor({ kubectl, probeImage: okProbe });
        const checks = byId(report.checks);
        expect(checks.cluster.status).toBe("warn");
        expect(checks.cluster.hint).toMatch(/re-authenticate/i);
        expect(checks.crd.status).toBe("skip");
        expect(report.exitCode).toBe(0);
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

    it("formatDoctorTable renders ERROR rows with the one-line hint (#230)", () => {
        const table = formatDoctorTable([
            {
                id: "crd",
                title: "NextApp CRD",
                status: "error",
                detail: "probe failed (auth): getting credentials: exec …",
                hint: "credentials failed — re-authenticate and retry",
            },
        ]);
        expect(table).toContain("ERROR");
        expect(table).toMatch(/re-authenticate and retry/);
    });

    it("parseDoctorArgs understands --json", () => {
        expect(parseDoctorArgs(["--json"]).json).toBe(true);
        expect(parseDoctorArgs([]).json).toBe(false);
    });

    it("parseDoctorArgs rejects unknown arguments with a usage hint", () => {
        expect(() => parseDoctorArgs(["--jsno"])).toThrow(
            /unknown argument "--jsno".*doctor --help/,
        );
    });
});

describe("probeManifest — bounded registry I/O", () => {
    it("passes an abort signal to every fetch and maps a timeout to 'unreachable' (SKIP path)", async () => {
        const seenInits: (RequestInit | undefined)[] = [];
        const fetchSpy = vi
            .spyOn(globalThis, "fetch")
            .mockImplementation(async (_url, init) => {
                seenInits.push(init as RequestInit | undefined);
                // Simulate a stalling registry: the bounded fetch rejects the
                // way undici does when AbortSignal.timeout fires.
                throw new DOMException(
                    "The operation was aborted due to timeout",
                    "TimeoutError",
                );
            });
        try {
            const outcome = await probeManifest("ghcr.io/acme/app:v1");
            expect(outcome).toBe("unreachable");
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(seenInits[0]?.signal).toBeInstanceOf(AbortSignal);
        } finally {
            fetchSpy.mockRestore();
        }
    });
});
