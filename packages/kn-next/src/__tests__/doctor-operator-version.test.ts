/**
 * `knext doctor` reports the installed operator VERSION and whether it is
 * compatible with this CLI (#1947).
 *
 * The operator publishes `operator-vX.Y.Z` bundles that stamp the version on
 * the manager Deployment (`app.kubernetes.io/version`) and in the image tag
 * (`…:vX.Y.Z@sha256:…`). Doctor reads it back — label first, image tag as the
 * fallback — and applies the documented pairing rule: operator MAJOR must equal
 * the CLI's, and operator MINOR must be >= the CLI's ("operator/CRD first, then
 * CLI"; an older CLI against a newer operator is always valid).
 *
 * Every dep is injected; nothing here shells out to a real kubectl.
 */

import { describe, expect, it } from "bun:test";
import {
    type CheckResult,
    type KubectlFn,
    type ManifestProbeFn,
    runDoctor,
} from "../cli/doctor";
import {
    classifyOperatorCompat,
    parseSemver,
    resolveOperatorVersion,
} from "../cli/doctor/operator-version";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const REPO = "ghcr.io/getknext-dev/kn-next-operator";

function deployment(opts: {
    label?: string;
    templateLabel?: string;
    image?: string;
}) {
    return {
        metadata: {
            name: "kn-next-operator-controller-manager",
            ...(opts.label
                ? { labels: { "app.kubernetes.io/version": opts.label } }
                : {}),
        },
        spec: {
            template: {
                metadata: opts.templateLabel
                    ? {
                          labels: {
                              "app.kubernetes.io/version": opts.templateLabel,
                          },
                      }
                    : {},
                spec: {
                    containers: [{ image: opts.image ?? `${REPO}@${DIGEST}` }],
                },
            },
        },
        status: { readyReplicas: 2, replicas: 2 },
    };
}

function kubectlFor(dep: unknown): KubectlFn {
    return (args) => {
        const key = args.join(" ");
        if (key === "kubectl get --raw /version") {
            return { ok: true, stdout: "{}", stderr: "" };
        }
        if (
            key === "kubectl get deployments -n kn-next-operator-system -o json"
        ) {
            return {
                ok: true,
                stdout: JSON.stringify({ items: [dep] }),
                stderr: "",
            };
        }
        return { ok: false, stdout: "", stderr: `no stub for: ${key}` };
    };
}

const okProbe: ManifestProbeFn = async () => "ok";

async function versionRow(
    dep: unknown,
    cliVersion: string | undefined,
): Promise<CheckResult> {
    const report = await runDoctor({
        kubectl: kubectlFor(dep),
        probeImage: okProbe,
        cliVersion,
    });
    const row = report.checks.find((c) => c.id === "operator-version");
    expect(row, "doctor must emit an operator-version row").toBeDefined();
    return row as CheckResult;
}

describe("parseSemver", () => {
    it("parses X.Y.Z with an optional v prefix and prerelease", () => {
        expect(parseSemver("1.2.3")).toEqual({
            major: 1,
            minor: 2,
            patch: 3,
            prerelease: undefined,
        });
        expect(parseSemver("v1.2.3-rc.1")).toEqual({
            major: 1,
            minor: 2,
            patch: 3,
            prerelease: "rc.1",
        });
    });
    it("rejects non-semver", () => {
        for (const bad of [
            "",
            "latest",
            "1.2",
            "v1.2.x",
            "1.2.3.4",
            "unreleased",
        ]) {
            expect(parseSemver(bad)).toBeUndefined();
        }
    });
});

describe("resolveOperatorVersion", () => {
    it("prefers the Deployment label", () => {
        const v = resolveOperatorVersion(
            deployment({ label: "1.2.3", image: `${REPO}:v9.9.9@${DIGEST}` }),
        );
        expect(v).toMatchObject({
            kind: "version",
            version: "1.2.3",
            source: "label",
        });
        expect(v.digest).toBe(DIGEST);
    });
    it("falls back to the pod-template label, then the image tag", () => {
        expect(
            resolveOperatorVersion(deployment({ templateLabel: "1.2.4" })),
        ).toMatchObject({
            kind: "version",
            version: "1.2.4",
            source: "label",
        });
        expect(
            resolveOperatorVersion(
                deployment({ image: `${REPO}:v1.2.5@${DIGEST}` }),
            ),
        ).toMatchObject({
            kind: "version",
            version: "1.2.5",
            source: "image-tag",
        });
    });
    it("reports the committed `unreleased` sentinel as unreleased, never a version", () => {
        expect(
            resolveOperatorVersion(
                deployment({
                    label: "unreleased",
                    image: `${REPO}:v0.1.0@${DIGEST}`,
                }),
            ).kind,
        ).toBe("unreleased");
    });
    it("reports a digest-only image with no label as unknown", () => {
        const v = resolveOperatorVersion(deployment({}));
        expect(v.kind).toBe("unknown");
        expect(v.digest).toBe(DIGEST);
    });
});

describe("classifyOperatorCompat (operator/CRD first, then CLI)", () => {
    const cases: [string, string, string][] = [
        ["1.0.0", "1.0.0", "ok"],
        ["1.0.7", "1.0.0", "ok"], // patch is independent
        ["1.3.0", "1.0.5", "ok"], // newer operator, older CLI: always valid
        ["1.0.0", "1.3.0", "operator-older"], // CLI ahead of operator: unsupported
        ["1.0.0", "1.3.0-rc.7", "operator-older"], // the CLI prerelease counts as its core
        ["1.3.0-rc.1", "1.3.0-rc.7", "ok"], // operator prerelease counts as its core
        ["2.0.0", "1.9.0", "major-mismatch"],
        ["1.9.0", "2.0.0", "major-mismatch"],
    ];
    for (const [op, cli, want] of cases) {
        it(`operator ${op} with CLI ${cli} -> ${want}`, () => {
            const o = parseSemver(op);
            const c = parseSemver(cli);
            expect(o && c).toBeTruthy();
            expect(classifyOperatorCompat(o as never, c as never)).toBe(want);
        });
    }
});

describe("doctor operator-version row (#1947)", () => {
    it("PASS: prints the version, its source and the digest when compatible", async () => {
        const row = await versionRow(
            deployment({ label: "1.0.0", image: `${REPO}:v1.0.0@${DIGEST}` }),
            "1.0.0-rc.5",
        );
        expect(row.status).toBe("pass");
        expect(row.detail).toContain("v1.0.0");
        expect(row.detail).toContain("compatible with CLI 1.0.0-rc.5");
        expect(row.detail).toContain(DIGEST.slice(0, 19)); // sha256:abababab…
    });

    it("WARN: operator older than the CLI, with the upgrade-first hint naming the pinned asset", async () => {
        const row = await versionRow(
            deployment({ label: "1.0.0" }),
            "1.3.0-rc.7",
        );
        expect(row.status).toBe("warn");
        expect(row.detail).toContain("v1.0.0");
        expect(row.detail).toContain("older than this CLI");
        expect(row.hint).toContain("install-v");
        expect(row.hint).toMatch(/operator.*first/i);
    });

    it("WARN: a different MAJOR in either direction", async () => {
        const row = await versionRow(deployment({ label: "2.0.0" }), "1.0.0");
        expect(row.status).toBe("warn");
        expect(row.detail).toMatch(/major/i);
    });

    it("WARN: an operator with no version label and a digest-only image is unversioned, with a pin hint", async () => {
        const row = await versionRow(deployment({}), "1.0.0");
        expect(row.status).toBe("warn");
        expect(row.detail).toMatch(/no release version reported/i);
        expect(row.detail).toContain(DIGEST.slice(0, 19));
        expect(row.hint).toContain("install-v");
    });

    it("WARN: an `unreleased` build is not a pinned release", async () => {
        const row = await versionRow(
            deployment({ label: "unreleased" }),
            "1.0.0",
        );
        expect(row.status).toBe("warn");
        expect(row.detail).toMatch(/unreleased|edge|source/i);
    });

    it("PASS without a compatibility verdict when the CLI version is not provided", async () => {
        const row = await versionRow(deployment({ label: "1.0.0" }), undefined);
        expect(row.status).toBe("pass");
        expect(row.detail).toContain("v1.0.0");
        expect(row.detail).not.toContain("compatible with CLI");
    });

    it("SKIP when the cluster is unreachable", async () => {
        const report = await runDoctor({
            kubectl: () => ({
                ok: false,
                stdout: "",
                stderr: "connection refused",
            }),
            probeImage: okProbe,
            cliVersion: "1.0.0",
        });
        expect(
            report.checks.find((c) => c.id === "operator-version")?.status,
        ).toBe("skip");
    });

    it("never changes the exit code on its own (WARN does not fail the preflight)", async () => {
        const report = await runDoctor({
            kubectl: kubectlFor(deployment({ label: "1.0.0" })),
            probeImage: okProbe,
            cliVersion: "1.3.0-rc.7",
        });
        const row = report.checks.find((c) => c.id === "operator-version");
        expect(row?.status).toBe("warn");
        // exitCode is driven by FAIL/ERROR rows only; assert the row is not one of them.
        expect(["fail", "error"]).not.toContain(row?.status);
    });
});
