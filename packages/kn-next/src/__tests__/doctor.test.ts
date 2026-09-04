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

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
    stubEnv,
    unstubAllEnvs,
} from "../../../../tests/helpers/bun-test-helpers";
import {
    type CheckResult,
    classifyKubectlFailure,
    formatDoctorTable,
    inspectKubeconfig,
    KOURIER_INGRESS_CLASS,
    type KubeconfigInspectFn,
    type KubectlFn,
    type ManifestProbeFn,
    parseDoctorArgs,
    parseImageRef,
    parseKubectlClientVersion,
    probeManifest,
    runDoctor,
} from "../cli/doctor";

/**
 * bun's `typeof fetch` carries a `preconnect` property; a bare async arrow does
 * not, so `spyOn(globalThis, 'fetch').mockImplementation(async () => …)` is not
 * assignable under `@types/bun`. This attaches the missing member instead of
 * casting, so the callback's own parameter and return types stay checked — a
 * cast would silence a genuinely wrong stub too.
 */
const fetchImpl = (fn: (...a: Parameters<typeof fetch>) => Promise<Response>) =>
    Object.assign(fn, { preconnect: globalThis.fetch.preconnect });

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
        // (g) local client version — modern enough for --validate=strict.
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
        // (i, #744) a policy-capable CNI runs AND is healthy: enforcement
        // detected. numberReady is not decoration — a calico-node DaemonSet
        // with zero ready pods enforces nothing, so a fixture claiming a
        // healthy cluster has to say the agent is actually running.
        "kubectl get daemonsets --all-namespaces -o json": {
            ok: true,
            stdout: JSON.stringify({
                items: [
                    {
                        metadata: {
                            name: "calico-node",
                            namespace: "kube-system",
                        },
                        status: {
                            desiredNumberScheduled: 3,
                            numberReady: 3,
                        },
                    },
                ],
            }),
        },
        // (a2, #314) schema coverage: serve the REAL bundled CRD schema through
        // the aggregated OpenAPI v3 document, so a healthy cluster is one whose
        // CRD actually defines every field this CLI emits. A stub that merely
        // said "the CRD exists" is exactly the check #314 replaces.
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
    };
}

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
            "kubectl-validation",
            "storage-mode",
            "crd",
            "crd-schema",
            "operator",
            "cert-manager",
            "ingress",
            "image",
            "knative",
            "netpol",
        ]);
        for (const c of report.checks) {
            // storage-mode is LOCAL (ADR-0047): with no kn-next.config.ts in
            // the test's cwd it reports skip — an informational state, never
            // a failure, and never a reason for a healthy cluster to exit 1.
            if (c.id === "storage-mode") {
                expect(c.status, `${c.id}: ${c.detail}`).toBe("skip");
                continue;
            }
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
        const probe = mock(okProbe);
        const report = await runDoctor({
            kubectl,
            probeImage: probe,
            // Pin the kubeconfig state so this test's wording assertions do
            // not depend on the machine's real ~/.kube/config (finding 1c).
            inspectKubeconfig: () => ({ kind: "has-current-context" }),
        });
        const checks = byId(report.checks);
        expect(checks.cluster.status).toBe("warn");
        for (const id of [
            "crd",
            "operator",
            "cert-manager",
            "ingress",
            "image",
            "knative",
            "netpol",
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
        const probe = mock(okProbe);
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
        const probe = mock(okProbe);
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

// ---------------------------------------------------------------------------
// (g) client kubectl strict-validation support.
//
// `kn-next deploy` now passes `--validate=strict` EXPLICITLY on the NextApp CR
// apply, so a field the operator's CRD does not know (e.g. `spec.database.roSecretRef`
// against a CRD that predates it) is REJECTED by the apiserver, not silently pruned.
// That flag VALUE only exists from kubectl v1.25 — on an older client the deploy
// cannot assert strict validation at all. This check is purely LOCAL (kubectl
// version --client) and read-only, so it runs even when the cluster is
// unreachable.
// ---------------------------------------------------------------------------
const VERSION_KEY = "kubectl version --client -o json";

const clientVersionJson = (gitVersion: string, major = "", minor = "") =>
    JSON.stringify({
        clientVersion: {
            ...(major ? { major } : {}),
            ...(minor ? { minor } : {}),
            gitVersion,
        },
    });

describe("runDoctor — check (g) kubectl strict-validation support", () => {
    it("passes on a modern client and says the deploy asserts --validate=strict", async () => {
        const stubs = healthyStubs();
        stubs[VERSION_KEY] = {
            ok: true,
            stdout: clientVersionJson("v1.31.2", "1", "31"),
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        const check = byId(report.checks)["kubectl-validation"];
        expect(check.status).toBe("pass");
        expect(check.detail).toMatch(/1\.31/);
        expect(check.detail).toMatch(/--validate=strict/);
        expect(report.exitCode).toBe(0);
    });

    it("passes at the v1.25.0 boundary exactly (the release that introduced the flag value)", async () => {
        const stubs = healthyStubs();
        stubs[VERSION_KEY] = { ok: true, stdout: clientVersionJson("v1.25.0") };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        expect(byId(report.checks)["kubectl-validation"].status).toBe("pass");
    });

    it("FAILS on v1.24.17 — one minor below the boundary — and names the upgrade", async () => {
        const stubs = healthyStubs();
        stubs[VERSION_KEY] = {
            ok: true,
            stdout: clientVersionJson("v1.24.17"),
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        const check = byId(report.checks)["kubectl-validation"];
        expect(check.status).toBe("fail");
        expect(check.detail).toMatch(/1\.24\.17/);
        expect(check.detail).toMatch(/1\.25/);
        expect(check.hint).toMatch(/upgrade/i);
        // A client that cannot strictly validate must not report green.
        expect(report.exitCode).toBe(1);
    });

    it("compares MAJOR too — a v0.x client fails and a v2.x client passes", async () => {
        const old = healthyStubs();
        old[VERSION_KEY] = { ok: true, stdout: clientVersionJson("v0.99.0") };
        const oldReport = await runDoctor({
            kubectl: stubKubectl(old),
            probeImage: okProbe,
        });
        expect(byId(oldReport.checks)["kubectl-validation"].status).toBe(
            "fail",
        );

        const future = healthyStubs();
        future[VERSION_KEY] = { ok: true, stdout: clientVersionJson("v2.0.0") };
        const futureReport = await runDoctor({
            kubectl: stubKubectl(future),
            probeImage: okProbe,
        });
        expect(byId(futureReport.checks)["kubectl-validation"].status).toBe(
            "pass",
        );
    });

    it("reads distro-suffixed and non-numeric-minor builds (v1.29.3-eks-…, minor '27+')", async () => {
        const eks = healthyStubs();
        eks[VERSION_KEY] = {
            ok: true,
            stdout: clientVersionJson("v1.29.3-eks-a1b2c3", "1", "29+"),
        };
        const eksReport = await runDoctor({
            kubectl: stubKubectl(eks),
            probeImage: okProbe,
        });
        expect(byId(eksReport.checks)["kubectl-validation"].status).toBe(
            "pass",
        );

        const gke = healthyStubs();
        gke[VERSION_KEY] = {
            ok: true,
            stdout: clientVersionJson("v1.22.17-gke.3400", "1", "22+"),
        };
        const gkeReport = await runDoctor({
            kubectl: stubKubectl(gke),
            probeImage: okProbe,
        });
        expect(byId(gkeReport.checks)["kubectl-validation"].status).toBe(
            "fail",
        );
    });

    // The gitVersion regex above always matches when gitVersion is present, so
    // the DISCRETE-field fallback (the `Number.parseInt("29+")` strip) is only
    // reached when gitVersion is ABSENT — a shape some vendored/managed clients
    // really emit, and one no test exercised before.
    it("falls back to the discrete major/minor fields when gitVersion is absent", async () => {
        const noGit = (major: string, minor: string) =>
            JSON.stringify({ clientVersion: { major, minor } });

        expect(parseKubectlClientVersion(noGit("1", "29+"))).toEqual({
            major: 1,
            minor: 29,
            display: "v1.29",
        });
        expect(parseKubectlClientVersion(noGit("1", "24+"))).toEqual({
            major: 1,
            minor: 24,
            display: "v1.24",
        });
        // Nothing numeric anywhere → undefined, so the caller WARNs.
        expect(
            parseKubectlClientVersion(noGit("stable", "unknown")),
        ).toBeUndefined();

        const modern = healthyStubs();
        modern[VERSION_KEY] = { ok: true, stdout: noGit("1", "29+") };
        const modernReport = await runDoctor({
            kubectl: stubKubectl(modern),
            probeImage: okProbe,
        });
        const pass = byId(modernReport.checks)["kubectl-validation"];
        expect(pass.status).toBe("pass");
        expect(pass.detail).toMatch(/v1\.29/);

        const old = healthyStubs();
        old[VERSION_KEY] = { ok: true, stdout: noGit("1", "24+") };
        const oldReport = await runDoctor({
            kubectl: stubKubectl(old),
            probeImage: okProbe,
        });
        const fail = byId(oldReport.checks)["kubectl-validation"];
        expect(fail.status).toBe("fail");
        expect(fail.detail).toMatch(/v1\.24/);
    });

    it("WARNS (never fails, never lies) when the version cannot be determined", async () => {
        for (const bad of [
            { ok: false, stderr: "exec: kubectl: not found" },
            { ok: true, stdout: "not json at all" },
            { ok: true, stdout: JSON.stringify({ clientVersion: {} }) },
        ]) {
            const stubs = healthyStubs();
            stubs[VERSION_KEY] = bad;
            const report = await runDoctor({
                kubectl: stubKubectl(stubs),
                probeImage: okProbe,
            });
            const check = byId(report.checks)["kubectl-validation"];
            expect(check.status, JSON.stringify(bad)).toBe("warn");
            expect(check.detail).toMatch(/could not determine|unknown/i);
            expect(report.exitCode).toBe(0);
        }
    });

    it("is LOCAL: it still runs (does not SKIP) when the cluster is unreachable", async () => {
        const kubectl: KubectlFn = (args) => {
            if (args.join(" ") === VERSION_KEY) {
                return {
                    ok: true,
                    stdout: clientVersionJson("v1.30.0"),
                    stderr: "",
                };
            }
            return {
                ok: false,
                stdout: "",
                stderr: "The connection to the server 10.0.0.1:6443 was refused",
            };
        };
        const report = await runDoctor({ kubectl, probeImage: okProbe });
        const check = byId(report.checks)["kubectl-validation"];
        expect(check.status).toBe("pass");
        expect(report.exitCode).toBe(0);
    });

    it("is READ-ONLY: the only kubectl verbs doctor runs are get/version", async () => {
        const seen: string[][] = [];
        const kubectl: KubectlFn = (args) => {
            seen.push([...args]);
            const key = args.join(" ");
            if (key === VERSION_KEY) {
                return {
                    ok: true,
                    stdout: clientVersionJson("v1.30.0"),
                    stderr: "",
                };
            }
            const hit = healthyStubs()[key];
            return {
                ok: hit?.ok ?? false,
                stdout: hit?.stdout ?? "",
                stderr: hit?.stderr ?? "",
            };
        };
        await runDoctor({ kubectl, probeImage: okProbe });
        for (const argv of seen) {
            expect(["get", "version"]).toContain(argv[1]);
        }
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
        const probe = mock(okProbe);
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

// P3: RBAC-denied probes. A restricted user (`kubectl auth can-i list nextapps`
// → no) gets `Error from server (Forbidden): …` — the apiserver ANSWERED, but
// doctor must not report the operator/CRD as "not found" when the user merely
// lacks get/list. Signatures are deliberately only the kubectl/apiserver
// literals `(Forbidden)` and `forbidden: User` (conservative-matching stance).
const FORBIDDEN_LIST_STDERR =
    'Error from server (Forbidden): nextapps.apps.kn-next.dev is forbidden: User "system:serviceaccount:dev:restricted" cannot list resource "nextapps" in API group "apps.kn-next.dev" at the cluster scope';
const FORBIDDEN_PLAIN_STDERR =
    'Error from server (Forbidden): User "restricted" cannot get path "/apis/apiextensions.k8s.io/v1/customresourcedefinitions"';

describe("classifyKubectlFailure (P3) — RBAC Forbidden", () => {
    it("maps the full apiserver forbidden: User form to forbidden", () => {
        expect(classifyKubectlFailure(FORBIDDEN_LIST_STDERR)).toBe("forbidden");
    });

    it("maps the plain (Forbidden) form to forbidden", () => {
        expect(classifyKubectlFailure(FORBIDDEN_PLAIN_STDERR)).toBe(
            "forbidden",
        );
    });

    it("NotFound still wins when both markers are present (cluster-state facts first)", () => {
        expect(
            classifyKubectlFailure(
                'Error from server (NotFound): nextapps.apps.kn-next.dev not found; earlier attempt was forbidden: User "x"',
            ),
        ).toBe("not-found");
    });

    it("does NOT match loose prose mentions of forbidden (stays unknown)", () => {
        expect(
            classifyKubectlFailure("the operation is forbidden by policy"),
        ).toBe("unknown");
    });

    it("documented residual: discovery-denied RBAC surfaces as doesn't-have-a-resource-type and still classifies not-found", () => {
        // Conservative stderr matching cannot distinguish this from a
        // genuinely absent CRD — accepted residual, see the classifier doc.
        expect(
            classifyKubectlFailure(
                'error: the server doesn\'t have a resource type "nextapps"',
            ),
        ).toBe("not-found");
    });
});

describe("runDoctor — RBAC-denied probes are not 'not found' (P3)", () => {
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

    it("full forbidden: User stderr becomes an rbac ERROR naming the resource, not a not-found FAIL (exit 1)", async () => {
        const { crd, exitCode } = await crdCheckWith(FORBIDDEN_LIST_STDERR);
        expect(crd.status).toBe("error");
        expect(crd.detail).not.toMatch(/not found/i);
        expect(crd.detail).toContain("rbac");
        expect(crd.hint).toMatch(/insufficient RBAC/);
        expect(crd.hint).toMatch(/cluster admin/);
        expect(crd.hint).toMatch(/get\/list/);
        expect(crd.hint).toContain("nextapps.apps.kn-next.dev");
        expect(exitCode).toBe(1);
    });

    it("plain (Forbidden) stderr becomes an rbac ERROR with the generic-resource hint", async () => {
        const { crd } = await crdCheckWith(FORBIDDEN_PLAIN_STDERR);
        expect(crd.status).toBe("error");
        expect(crd.detail).not.toMatch(/not found/i);
        expect(crd.hint).toMatch(/insufficient RBAC/);
        expect(crd.hint).toMatch(/the probed resource/);
    });

    it("ambiguous stderr still keeps today's not-found FAIL behavior", async () => {
        const { crd } = await crdCheckWith("some novel kubectl error");
        expect(crd.status).toBe("fail");
        expect(crd.detail).toMatch(/not found/i);
    });

    it("caps and sanitizes the resource token embedded in the RBAC hint (garbled stderr)", async () => {
        // A garbled/hostile stderr token: an ANSI ESC + 200 chars. The hint
        // must never carry control characters or an unbounded token.
        const junkToken = `\u001b${"a".repeat(200)}`;
        const { crd } = await crdCheckWith(
            `Error from server (Forbidden): ${junkToken} is forbidden: User "x" cannot list it`,
        );
        expect(crd.status).toBe("error");
        expect(crd.hint).not.toContain("\u001b");
        const resource = crd.hint?.split("get/list on ")[1];
        expect(resource).toBe("a".repeat(80));
    });

    it("falls back to the generic phrase when the resource token sanitizes to nothing", async () => {
        // The token is nothing but control characters (BEL+BS) — sanitization
        // empties it, and the hint must not end in a dangling empty resource.
        const { crd } = await crdCheckWith(
            `Error from server (Forbidden): \u0007\u0008 is forbidden: User "x" cannot list it`,
        );
        expect(crd.status).toBe("error");
        expect(crd.hint).toMatch(/the probed resource/);
    });
});

// P3: the 160-char stderr excerpt cap + whitespace collapse in infraFailure
// (flagged untested by the #231 sysdesign gate). Exercised through runDoctor —
// the detail line is `probe failed (<class>): <excerpt>`.
describe("runDoctor — infra-failure stderr excerpt bounds (P3)", () => {
    const DETAIL_PREFIX = "probe failed (network): ";

    async function crdDetailFor(stderr: string): Promise<string> {
        const stubs = healthyStubs();
        stubs["kubectl get crd nextapps.apps.kn-next.dev -o json"] = {
            ok: false,
            stderr,
        };
        const report = await runDoctor({
            kubectl: stubKubectl(stubs),
            probeImage: okProbe,
        });
        return byId(report.checks).crd.detail;
    }

    // "connection refused " (19 chars) + 141 filler = exactly 160 collapsed.
    const exact160 = `connection refused ${"x".repeat(141)}`;

    it("an exactly-160-char excerpt survives intact (no off-by-one truncation)", async () => {
        expect(exact160).toHaveLength(160);
        const detail = await crdDetailFor(exact160);
        expect(detail).toBe(`${DETAIL_PREFIX}${exact160}`);
    });

    it("chars beyond 160 are dropped, keeping exactly the first 160", async () => {
        const detail = await crdDetailFor(`${exact160}OVERFLOW`);
        expect(detail).toBe(`${DETAIL_PREFIX}${exact160}`);
        expect(detail).not.toContain("OVERFLOW");
    });

    it("collapses runs of whitespace (newlines/tabs) to single spaces and trims", async () => {
        // NB: the signature must stay contiguous in the RAW stderr —
        // classification happens before the excerpt collapse.
        const detail = await crdDetailFor(
            "  connection refused\n\tto   the server   10.0.0.1:6443  ",
        );
        expect(detail).toBe(
            `${DETAIL_PREFIX}connection refused to the server 10.0.0.1:6443`,
        );
    });

    it("caps AFTER collapsing, so whitespace never inflates the excerpt budget", async () => {
        // 100 "y␠␠\n" groups collapse from 400 raw chars to 200 → cap at 160.
        const raw = "connection refused ".concat("y  \n".repeat(100));
        const collapsed = raw.trim().replace(/\s+/g, " ");
        expect(collapsed.length).toBeGreaterThan(160);
        const detail = await crdDetailFor(raw);
        expect(detail).toBe(`${DETAIL_PREFIX}${collapsed.slice(0, 160)}`);
    });

    // P6c nit: the excerpt path gets the SAME printable-ASCII scrub the RBAC
    // resource token already had — kubectl stderr can carry ANSI color escapes
    // and stray control bytes, and a doctor detail line must never re-emit
    // terminal escape sequences to the operator's console (or a JSON consumer).
    it("scrubs control chars / ANSI escape bytes from the excerpt (printable ASCII only)", async () => {
        const detail = await crdDetailFor(
            "\u001b[31mconnection refused\u001b[0m to the server \u0007\u0008 10.0.0.1:6443",
        );
        // Only printable ASCII survives (the ESC/BEL/BS bytes go; the readable
        // "[31m" tail of a color sequence is harmless printable text).
        expect(detail).toMatch(/^[\x20-\x7e]*$/);
        expect(detail).toContain("connection refused");
        expect(detail).toContain("10.0.0.1:6443");
        expect(detail).not.toContain("\u001b");
    });

    it("scrub happens BEFORE the cap, so control bytes never eat the 160-char budget", async () => {
        // 160 printable chars, the filler interleaved with control bytes
        // (the "connection refused" signature must stay contiguous in the RAW
        // stderr — classification runs before the scrub): after the scrub the
        // collapsed excerpt is exactly the printable 160.
        const printable = `connection refused ${"z".repeat(141)}`;
        const raw = `connection refused ${"\u0001z".repeat(141)}`;
        const detail = await crdDetailFor(raw);
        expect(detail).toBe(`${DETAIL_PREFIX}${printable}`);
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
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
            fetchImpl(async (_url, init) => {
                seenInits.push(init as RequestInit | undefined);
                // Simulate a stalling registry: the bounded fetch rejects the
                // way undici does when AbortSignal.timeout fires.
                throw new DOMException(
                    "The operation was aborted due to timeout",
                    "TimeoutError",
                );
            }),
        );
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

// ---------------------------------------------------------------------------
// Finding 1c (docs/ux/ergonomics-ledger.md): `doctor` with no working cluster
// used to answer every gate failure with "cluster connection flaked — check
// network/VPN and retry" — misdirection for the zero-k8s persona who has NO
// cluster yet. The gate now consults the LOCAL kubeconfig (pure file reads —
// no network, no new kubectl verbs, so the read-only verb scan above still
// holds) and tells that user plainly that no cluster is connected, pointing
// at the getting-started guide. A genuinely-remote unreachable server keeps
// the flake hint, and auth/RBAC classifications (#230) keep precedence.
// ---------------------------------------------------------------------------

const NO_CONFIG_STDERR =
    "The connection to the server localhost:8080 was refused - did you specify the right host or port?";
const LOCAL_REFUSED_STDERR =
    "The connection to the server 127.0.0.1:26443 was refused - did you specify the right host or port?";
const REMOTE_REFUSED_STDERR =
    "The connection to the server 203.0.113.7:6443 was refused - did you specify the right host or port?";

const hasCtx: KubeconfigInspectFn = () => ({ kind: "has-current-context" });

/** Gate fails with `stderr`; the local client-version probe still answers. */
function gateFailKubectl(stderr: string): KubectlFn {
    return (args) =>
        args.join(" ") === VERSION_KEY
            ? { ok: true, stdout: clientVersionJson("v1.30.0"), stderr: "" }
            : { ok: false, stdout: "", stderr };
}

describe("runDoctor — finding 1c: no-cluster-configured is not a 'flake'", () => {
    it("state 1 — no kubeconfig at all: plain 'no cluster connected yet' + getting-started URL, never VPN", async () => {
        const report = await runDoctor({
            kubectl: gateFailKubectl(NO_CONFIG_STDERR),
            probeImage: okProbe,
            inspectKubeconfig: () => ({
                kind: "absent",
                searched: ["/home/dev/.kube/config"],
            }),
        });
        const checks = byId(report.checks);
        expect(checks.cluster.status).toBe("warn");
        expect(checks.cluster.detail).toMatch(/no kubeconfig/i);
        expect(checks.cluster.detail).toMatch(
            /don't have a Kubernetes cluster connected yet/,
        );
        expect(checks.cluster.detail).toContain("/home/dev/.kube/config");
        expect(checks.cluster.hint).toContain(
            "https://knext.dev/docs/getting-started",
        );
        expect(`${checks.cluster.detail} ${checks.cluster.hint}`).not.toMatch(
            /VPN|flaked/i,
        );
        // The documented degrade contract is unchanged: WARN gate, SKIP
        // checks, exit 0.
        for (const id of ["crd", "operator", "knative"]) {
            expect(checks[id].status, id).toBe("skip");
        }
        expect(report.exitCode).toBe(0);
    });

    it("state 2 — kubeconfig exists but sets no current-context: same plain answer, names the file", async () => {
        const report = await runDoctor({
            kubectl: gateFailKubectl(NO_CONFIG_STDERR),
            probeImage: okProbe,
            inspectKubeconfig: () => ({
                kind: "no-current-context",
                path: "/home/dev/.kube/config",
            }),
        });
        const checks = byId(report.checks);
        expect(checks.cluster.status).toBe("warn");
        expect(checks.cluster.detail).toContain("/home/dev/.kube/config");
        expect(checks.cluster.detail).toMatch(/current-context/);
        expect(checks.cluster.detail).toMatch(
            /don't have a Kubernetes cluster connected yet/,
        );
        expect(checks.cluster.hint).toContain(
            "https://knext.dev/docs/getting-started",
        );
        expect(`${checks.cluster.detail} ${checks.cluster.hint}`).not.toMatch(
            /VPN|flaked/i,
        );
        expect(report.exitCode).toBe(0);
    });

    for (const addr of [
        "127.0.0.1:26443",
        "localhost:8080",
        "0.0.0.0:6443",
        "[::1]:26443",
    ]) {
        it(`state 3 — connection refused on the LOCAL address ${addr}: stale local cluster, not a flake`, async () => {
            const stderr = `The connection to the server ${addr} was refused - did you specify the right host or port?`;
            const report = await runDoctor({
                kubectl: gateFailKubectl(stderr),
                probeImage: okProbe,
                inspectKubeconfig: hasCtx,
            });
            const checks = byId(report.checks);
            expect(checks.cluster.status).toBe("warn");
            expect(checks.cluster.detail).toContain(addr);
            expect(checks.cluster.detail).toMatch(
                /local cluster .* not running/i,
            );
            expect(checks.cluster.hint).toContain(
                "https://knext.dev/docs/getting-started",
            );
            expect(
                `${checks.cluster.detail} ${checks.cluster.hint}`,
            ).not.toMatch(/VPN|flaked/i);
            expect(report.exitCode).toBe(0);
        });
    }

    it("remote refused server KEEPS the flake hint and never claims there is no cluster", async () => {
        const report = await runDoctor({
            kubectl: gateFailKubectl(REMOTE_REFUSED_STDERR),
            probeImage: okProbe,
            inspectKubeconfig: hasCtx,
        });
        const checks = byId(report.checks);
        expect(checks.cluster.status).toBe("warn");
        expect(checks.cluster.hint).toBe(
            "cluster connection flaked — check network/VPN and retry",
        );
        expect(`${checks.cluster.detail} ${checks.cluster.hint}`).not.toMatch(
            /don't have a Kubernetes cluster/,
        );
        expect(report.exitCode).toBe(0);
    });

    it("auth-classified gate failures (#230) keep precedence over the kubeconfig diagnosis", async () => {
        // Contradictory inputs (an exec-credential error implies a configured
        // context) — the conservative answer is the auth hint, never a
        // "no cluster" claim built from a racing filesystem read.
        const report = await runDoctor({
            kubectl: gateFailKubectl(
                "Unable to connect to the server: getting credentials: exec: executable oci failed with exit code 1",
            ),
            probeImage: okProbe,
            inspectKubeconfig: () => ({ kind: "absent", searched: [] }),
        });
        const checks = byId(report.checks);
        expect(checks.cluster.hint).toMatch(/re-authenticate/);
        expect(`${checks.cluster.detail} ${checks.cluster.hint}`).not.toMatch(
            /getting-started|don't have a Kubernetes cluster/,
        );
    });

    it("the DEFAULT inspector is wired in: no injection + a scratch no-cluster env still yields the guidance", async () => {
        // Every other test injects inspectKubeconfig, so this is the ONLY
        // assertion on the call-site fallback — replacing the default with a
        // has-current-context stub (the reviewer's M2 mutation) must go red
        // here, not stay green.
        const dir = mkdtempSync(join(osTmpdir(), "knext-doctor-1c-wiring-"));
        stubEnv("KUBECONFIG", join(dir, "does-not-exist"));
        try {
            const report = await runDoctor({
                kubectl: gateFailKubectl(NO_CONFIG_STDERR),
                probeImage: okProbe,
            });
            const checks = byId(report.checks);
            expect(checks.cluster.status).toBe("warn");
            expect(checks.cluster.detail).toMatch(
                /don't have a Kubernetes cluster connected yet/,
            );
            expect(checks.cluster.hint).toContain(
                "https://knext.dev/docs/getting-started",
            );
        } finally {
            unstubAllEnvs();
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("the three no-cluster states stay pairwise distinguishable in the detail line", async () => {
        const run = (inspect: KubeconfigInspectFn, stderr: string) =>
            runDoctor({
                kubectl: gateFailKubectl(stderr),
                probeImage: okProbe,
                inspectKubeconfig: inspect,
            }).then((r) => byId(r.checks).cluster.detail);
        const details = await Promise.all([
            run(() => ({ kind: "absent", searched: ["/x"] }), NO_CONFIG_STDERR),
            run(
                () => ({ kind: "no-current-context", path: "/x" }),
                NO_CONFIG_STDERR,
            ),
            run(hasCtx, LOCAL_REFUSED_STDERR),
        ]);
        expect(new Set(details).size).toBe(3);
    });
});

describe("inspectKubeconfig — the default local kubeconfig inspector", () => {
    const dirs: string[] = [];
    const tmp = () => {
        const d = mkdtempSync(join(osTmpdir(), "knext-doctor-1c-"));
        dirs.push(d);
        return d;
    };
    afterEach(() => {
        unstubAllEnvs();
        for (const d of dirs.splice(0)) {
            rmSync(d, { recursive: true, force: true });
        }
    });

    it("absent: $KUBECONFIG points at nothing that exists", () => {
        const dir = tmp();
        const missing = join(dir, "nope");
        stubEnv("KUBECONFIG", missing);
        expect(inspectKubeconfig()).toEqual({
            kind: "absent",
            searched: [missing],
        });
    });

    it("absent: no $KUBECONFIG and no ~/.kube/config (HOME redirected)", () => {
        const dir = tmp();
        stubEnv("KUBECONFIG", "");
        stubEnv("HOME", dir);
        expect(inspectKubeconfig()).toEqual({
            kind: "absent",
            searched: [join(dir, ".kube", "config")],
        });
    });

    it("no-current-context: an EMPTY config file (a torn-down local cluster's leftover)", () => {
        const dir = tmp();
        const cfg = join(dir, "config");
        writeFileSync(cfg, "");
        stubEnv("KUBECONFIG", cfg);
        expect(inspectKubeconfig()).toEqual({
            kind: "no-current-context",
            path: cfg,
        });
    });

    it('no-current-context: `current-context: ""`', () => {
        const dir = tmp();
        const cfg = join(dir, "config");
        writeFileSync(cfg, 'apiVersion: v1\ncurrent-context: ""\n');
        stubEnv("KUBECONFIG", cfg);
        expect(inspectKubeconfig()).toEqual({
            kind: "no-current-context",
            path: cfg,
        });
    });

    it("has-current-context when one is set", () => {
        const dir = tmp();
        const cfg = join(dir, "config");
        writeFileSync(cfg, "current-context: prod\n");
        stubEnv("KUBECONFIG", cfg);
        expect(inspectKubeconfig()).toEqual({ kind: "has-current-context" });
    });

    it("$KUBECONFIG list: any file that sets current-context wins (kubectl merge rule)", () => {
        const dir = tmp();
        const a = join(dir, "a");
        const b = join(dir, "b");
        writeFileSync(a, "");
        writeFileSync(b, "current-context: prod\n");
        stubEnv("KUBECONFIG", `${a}${delimiter}${b}`);
        expect(inspectKubeconfig()).toEqual({ kind: "has-current-context" });
    });

    it("a corrupt config NEVER claims no-cluster (conservative: keep the generic path)", () => {
        const dir = tmp();
        const cfg = join(dir, "config");
        writeFileSync(cfg, "{{{ not yaml");
        stubEnv("KUBECONFIG", cfg);
        expect(inspectKubeconfig()).toEqual({ kind: "has-current-context" });
    });
});
