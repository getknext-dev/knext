/**
 * `doctor --ci-kubeconfig <path>` (#1533).
 *
 * Three layers:
 *   1. `parseDoctorArgs` — the flag takes a value, and an unknown flag is
 *      still rejected exactly as before.
 *   2. `ciKubeconfigCheck` in isolation — the check module itself, same
 *      pattern as `doctor-checks-isolated.test.ts`.
 *   3. `runDoctor` end-to-end — passing NO path contributes NO row at all
 *      (the property `doctor-golden.test.ts` relies on to stay untouched).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_CREDENTIAL_REFUSAL } from "../cli/ci/kubeconfig-safety";
import { runDoctor } from "../cli/doctor";
import { parseDoctorArgs } from "../cli/doctor/args";
import { ciKubeconfigCheck } from "../cli/doctor/checks/ci-kubeconfig";
import type { DoctorDeps } from "../cli/doctor/types";
import {
    LEAK_SENTINEL_PREFIX,
    MALFORMED_TOKEN_KUBECONFIGS,
} from "./helpers/malformed-kubeconfigs";

const TOKEN_KUBECONFIG = `
apiVersion: v1
kind: Config
users:
  - name: knext-deployer
    user:
      token: abc
contexts: []
`;

const EXEC_KUBECONFIG = `
apiVersion: v1
kind: Config
users:
  - name: admin
    user:
      exec:
        command: aws
contexts: []
`;

describe("parseDoctorArgs — --ci-kubeconfig (#1533)", () => {
    it("parses a value after --ci-kubeconfig", () => {
        const args = parseDoctorArgs(["--ci-kubeconfig", "./foo.kubeconfig"]);
        expect(args.ciKubeconfig).toBe("./foo.kubeconfig");
        expect(args.json).toBe(false);
    });

    it("is undefined when the flag is absent — the default, unaffecting path", () => {
        expect(parseDoctorArgs([]).ciKubeconfig).toBeUndefined();
        expect(parseDoctorArgs(["--json"]).ciKubeconfig).toBeUndefined();
    });

    it("combines with --json", () => {
        const args = parseDoctorArgs(["--json", "--ci-kubeconfig", "x.yaml"]);
        expect(args.json).toBe(true);
        expect(args.ciKubeconfig).toBe("x.yaml");
    });

    it("throws a UsageError when --ci-kubeconfig has no value", () => {
        expect(() => parseDoctorArgs(["--ci-kubeconfig"])).toThrow(
            /--ci-kubeconfig requires a file path/,
        );
    });

    it("refuses a FLAG as the path — `--ci-kubeconfig --json` keeps JSON mode, never reads a file named --json", () => {
        expect(() => parseDoctorArgs(["--ci-kubeconfig", "--json"])).toThrow(
            /--ci-kubeconfig requires a file path/,
        );
        expect(() =>
            parseDoctorArgs(["--ci-kubeconfig", "--verbose", "x"]),
        ).toThrow(/--ci-kubeconfig requires a file path/);
    });

    it("combines with --verbose", () => {
        const args = parseDoctorArgs(["--verbose", "--ci-kubeconfig", "x"]);
        expect(args.verbose).toBe(true);
        expect(args.ciKubeconfig).toBe("x");
    });

    it("still rejects an unknown flag", () => {
        expect(() => parseDoctorArgs(["--nope"])).toThrow(/unknown argument/);
    });
});

describe("ciKubeconfigCheck — isolated (#1533)", () => {
    it("contributes NO row when no path is given", () => {
        expect(ciKubeconfigCheck(undefined)).toEqual([]);
    });

    it("passes a scoped bearer-token kubeconfig", () => {
        const [row] = ciKubeconfigCheck("x.kubeconfig", () => TOKEN_KUBECONFIG);
        expect(row.status).toBe("pass");
        expect(row.id).toBe("ci-kubeconfig");
    });

    it("fails an exec-plugin kubeconfig with the EXACT #1533 sentence", () => {
        const [row] = ciKubeconfigCheck("x.kubeconfig", () => EXEC_KUBECONFIG);
        expect(row.status).toBe("fail");
        expect(row.detail).toBe(CLOUD_CREDENTIAL_REFUSAL);
    });

    it("reports 'error', not a silent pass, when the file cannot be read", () => {
        const [row] = ciKubeconfigCheck("missing.kubeconfig", () => {
            throw new Error("ENOENT: no such file");
        });
        expect(row.status).toBe("error");
        expect(row.detail).toContain("missing.kubeconfig");
    });
});

describe("runDoctor — --ci-kubeconfig wiring (#1533)", () => {
    const unreachableDeps: DoctorDeps = {
        kubectl: () => ({
            ok: false,
            stdout: "",
            stderr: "connection refused",
        }),
        probeImage: async () => "unreachable",
        inspectKubeconfig: () => ({
            kind: "absent",
            searched: ["~/.kube/config"],
        }),
    };

    it("adds no row when ciKubeconfigPath is not passed", async () => {
        const report = await runDoctor(unreachableDeps);
        expect(report.checks.some((c) => c.id === "ci-kubeconfig")).toBe(false);
    });

    it("adds exactly one row, independent of cluster reachability, when passed", async () => {
        // The cluster is unreachable (deps above), yet the kubeconfig-file
        // check still runs and still reports a real verdict — it is a LOCAL
        // file read, not a cluster call, so it must not be swallowed by the
        // skipAll cluster gate the way every other check is.
        const report = await runDoctor(unreachableDeps, false, {
            ciKubeconfigPath: "irrelevant-because-injected",
        });
        // runDoctor's ciKubeconfigCheck call uses the REAL file reader (no
        // injection point on DoctorDeps for it — it is opt-in CLI-arg driven,
        // not a cluster dep), so a nonexistent path reports "error", proving
        // the row exists and is independent of cluster state either way.
        const row = report.checks.find((c) => c.id === "ci-kubeconfig");
        expect(row).toBeDefined();
        expect(row?.status).toBe("error");
    });
});

/**
 * Round 2 of #1557: a malformed kubeconfig's refusal used to relay the YAML
 * library's message, which quotes the failing line — the `token:` line. Run
 * `doctorMain` in a REAL child process (an unreachable fake cluster, so no
 * kubectl runs) and capture both the table and `--json` at the fd level.
 */
describe("doctor --ci-kubeconfig never prints a malformed kubeconfig's token (round 2)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "knext-doctor-leak-"));
    afterAll(() => rmSync(tmp, { recursive: true, force: true }));

    function runDoctorSubprocess(argv: string[]) {
        const driver = join(tmp, "driver.mjs");
        writeFileSync(
            driver,
            [
                `import { doctorMain } from ${JSON.stringify(
                    join(import.meta.dirname, "..", "cli", "doctor.ts"),
                )};`,
                "const deps = {",
                '  kubectl: () => ({ ok: false, stdout: "", stderr: "connection refused" }),',
                '  probeImage: async () => "unreachable",',
                '  inspectKubeconfig: () => ({ kind: "absent", searched: ["~/.kube/config"] }),',
                "};",
                `const code = await doctorMain(${JSON.stringify(argv)}, deps);`,
                "process.exit(code);",
            ].join("\n"),
        );
        const r = spawnSync(process.execPath, [driver], {
            cwd: tmp,
            encoding: "utf8",
        });
        return { status: r.status, combined: `${r.stdout}${r.stderr}` };
    }

    for (const [name, text] of Object.entries(MALFORMED_TOKEN_KUBECONFIGS)) {
        const path = join(tmp, `${name}.kubeconfig`);
        writeFileSync(path, text);
        for (const mode of [[], ["--json"]]) {
            it(`${name} ${mode.join(" ") || "(table)"}: FAIL row, no token bytes`, () => {
                const r = runDoctorSubprocess([
                    ...mode,
                    "--ci-kubeconfig",
                    path,
                ]);
                expect(r.status).toBe(1);
                expect(r.combined).toContain(
                    "could not parse this file as a kubeconfig",
                );
                expect(r.combined).not.toContain(LEAK_SENTINEL_PREFIX);
            });
        }
    }
});
