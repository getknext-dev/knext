/**
 * `ciPreflightMain` — the `knext ci-preflight` verb entry (#1534). Pinned the
 * same way `init-ci-cmd.test.ts` pins `initCiMain`: real argv parsing, only
 * the output streams captured, `runCiPreflight` exercised through a real
 * (missing) kubeconfig file so the failure path is genuine, not mocked.
 */
import { describe, expect, it, spyOn } from "bun:test";
import { ciPreflightMain } from "../cli/ci/ci-preflight-cmd";

async function run(
    argv: string[],
    env: Record<string, string | undefined> = {},
) {
    const outSpy = spyOn(process.stdout, "write").mockImplementation(
        () => true,
    );
    const errSpy = spyOn(process.stderr, "write").mockImplementation(
        () => true,
    );
    const savedEnv = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        const code = await ciPreflightMain(argv);
        const stdout = outSpy.mock.calls.map((c) => String(c[0])).join("");
        const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("");
        return { code, stdout, stderr };
    } finally {
        outSpy.mockRestore();
        errSpy.mockRestore();
        for (const k of Object.keys(process.env)) {
            if (!(k in savedEnv)) delete process.env[k];
        }
        Object.assign(process.env, savedEnv);
    }
}

describe("ciPreflightMain — help and argv strictness", () => {
    it("--help prints usage to stdout and exits 0", async () => {
        const r = await run(["--help"]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("knext ci-preflight");
    });

    it("-h is the same as --help", async () => {
        const r = await run(["-h"]);
        expect(r.code).toBe(0);
        expect(r.stdout).toContain("knext ci-preflight");
    });

    it("missing --namespace is a usage error, exit 1", async () => {
        const r = await run([], { KUBECONFIG: undefined });
        expect(r.code).toBe(1);
    });

    it("an unparseable flag is a usage error, exit 1", async () => {
        const r = await run(["--not-a-real-flag"]);
        expect(r.code).toBe(1);
    });
});

describe("ciPreflightMain — no kubeconfig configured", () => {
    it("refuses when neither --kubeconfig nor $KUBECONFIG is set", async () => {
        const r = await run(["--namespace", "acme"], { KUBECONFIG: undefined });
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("no kubeconfig configured");
    });

    it("--kubeconfig takes precedence and a missing file is a clean refusal, not a crash", async () => {
        const r = await run([
            "--namespace",
            "acme",
            "--kubeconfig",
            "/definitely/does/not/exist/kubeconfig",
        ]);
        expect(r.code).toBe(1);
        expect(r.stderr).toContain("could not read");
    });
});
