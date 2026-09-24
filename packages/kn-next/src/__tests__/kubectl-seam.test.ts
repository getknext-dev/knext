/**
 * B7 (#1238) — the kubectl seam itself: `kubectlRunner` (doctor/kubectl.ts)
 * and `captureKubectl` (schema/kubectl-capture.ts) are the two production
 * `spawnSync("kubectl", …)` wrappers. Every other test in the suite injects a
 * FAKE kubectl function to keep doctor/preflight tests hermetic — which is
 * correct for those tests, but it means the wrappers' own real mapping logic
 * (status -> ok, stdout/stderr coalescing, the argv[0]-is-literal-"kubectl"
 * convention, captureKubectl's fallback to `r.error?.message` when kubectl
 * never produced stderr) was never itself exercised. This file mocks
 * `node:child_process`'s `spawnSync` (the actual OS boundary) rather than the
 * wrappers, so the real wrapper code runs.
 */

import { describe, expect, it, mock } from "bun:test";

type FakeSpawnResult = {
    status: number | null;
    stdout?: string | null;
    stderr?: string | null;
    error?: Error;
};

const spawnSync = (() =>
    mock<
        (
            cmd: string,
            args: readonly string[],
            opts?: unknown,
        ) => FakeSpawnResult
    >(() => ({ status: 0, stdout: "", stderr: "" })))();
const __knextRealChildProcess = { ...(await import("node:child_process")) };
mock.module("node:child_process", async () => {
    const actual = __knextRealChildProcess;
    return {
        ...actual,
        spawnSync,
        default: {
            ...(actual as { default?: object }).default,
            spawnSync,
        },
    };
});

const { kubectlRunner } = await import("../cli/doctor/kubectl");
const { captureKubectl } = await import("../cli/schema/kubectl-capture");

describe("kubectlRunner (real spawnSync wrapper)", () => {
    it("maps a successful call (status 0) to ok:true with stdout/stderr passed through", () => {
        spawnSync.mockImplementationOnce(() => ({
            status: 0,
            stdout: '{"items":[]}',
            stderr: "",
        }));
        const r = kubectlRunner(["kubectl", "get", "pods", "-o", "json"]);
        expect(r.ok).toBe(true);
        expect(r.stdout).toBe('{"items":[]}');
        expect(r.stderr).toBe("");
    });

    it("maps a non-zero exit to ok:false and surfaces stderr", () => {
        spawnSync.mockImplementationOnce(() => ({
            status: 1,
            stdout: "",
            stderr: 'Error from server (NotFound): "x" not found',
        }));
        const r = kubectlRunner(["kubectl", "get", "pods", "x"]);
        expect(r.ok).toBe(false);
        expect(r.stderr).toContain("NotFound");
    });

    it("coalesces null/undefined stdout and stderr to empty strings, never throwing", () => {
        spawnSync.mockImplementationOnce(() => ({
            status: null,
            stdout: undefined,
            stderr: undefined,
        }));
        const r = kubectlRunner(["kubectl", "version"]);
        expect(r.ok).toBe(false);
        expect(r.stdout).toBe("");
        expect(r.stderr).toBe("");
    });

    it("calls spawnSync with shell:false and drops the literal argv[0] before spawning", () => {
        spawnSync.mockImplementationOnce((_cmd, args, opts) => {
            expect(args).toEqual(["get", "ns"]);
            expect((opts as { shell?: boolean }).shell).toBe(false);
            return { status: 0, stdout: "", stderr: "" };
        });
        kubectlRunner(["kubectl", "get", "ns"]);
        expect(spawnSync).toHaveBeenCalledWith(
            "kubectl",
            ["get", "ns"],
            expect.anything(),
        );
    });
});

describe("captureKubectl (real spawnSync wrapper)", () => {
    it("maps a successful call the same way kubectlRunner does", () => {
        spawnSync.mockImplementationOnce(() => ({
            status: 0,
            stdout: "ok",
            stderr: "",
        }));
        const r = captureKubectl(["kubectl", "apply", "--dry-run=server"]);
        expect(r.ok).toBe(true);
        expect(r.stdout).toBe("ok");
    });

    it("maps a failed apply (status != 0) to ok:false with the apiserver's stderr", () => {
        spawnSync.mockImplementationOnce(() => ({
            status: 1,
            stdout: "",
            stderr: "strict decoding error: unknown field",
        }));
        const r = captureKubectl(["kubectl", "apply", "--validate=strict"]);
        expect(r.ok).toBe(false);
        expect(r.stderr).toContain("strict decoding error");
    });

    it("falls back to r.error's message when kubectl never produced stderr (spawn itself failed, e.g. ENOENT)", () => {
        spawnSync.mockImplementationOnce(() => ({
            status: null,
            stdout: "",
            stderr: undefined,
            error: new Error("spawnSync kubectl ENOENT"),
        }));
        const r = captureKubectl(["kubectl", "apply", "-f", "-"]);
        expect(r.ok).toBe(false);
        expect(r.stderr).toContain("ENOENT");
    });

    it("prefers real stderr over r.error when both are present", () => {
        spawnSync.mockImplementationOnce(() => ({
            status: 1,
            stdout: "",
            stderr: "real apiserver stderr",
            error: new Error("should not win"),
        }));
        const r = captureKubectl(["kubectl", "apply", "-f", "-"]);
        expect(r.stderr).toBe("real apiserver stderr");
    });
});
