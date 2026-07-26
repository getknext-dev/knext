/**
 * loadtest.ts — runLoadTest: generate the k6 Job manifest(s) and apply them via
 * kubectl (execFile, no shell). child_process is mocked so no real kubectl runs;
 * the manifest is written to a real temp cwd and asserted. Covers the
 * observability-on branch (Prometheus remote-write URL) and the argv shape.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileSync = vi.hoisted(() =>
    vi.fn<(cmd: string, args: readonly string[], opts?: unknown) => Buffer>(
        () => Buffer.from(""),
    ),
);
vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    const overridden = { ...actual, execFileSync };
    return {
        ...overridden,
        default: {
            ...(actual as { default?: object }).default,
            execFileSync,
        },
    };
});

import { runLoadTest } from "../cli/loadtest";

let dir: string;
const savedCwd = process.cwd();

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "knext-loadtest-"));
    process.chdir(dir);
    execFileSync.mockClear();
});

afterEach(() => {
    process.chdir(savedCwd);
    rmSync(dir, { recursive: true, force: true });
});

describe("runLoadTest", () => {
    it("writes a manifest and applies it via `kubectl apply -f`", async () => {
        const manifestPath = await runLoadTest(
            "my-app",
            "https://app.example.com",
            "scale-to-zero",
            "default",
            false,
        );

        // A manifest file was written under .kn-next/loadtest/<app>/.
        expect(manifestPath).toContain(join(".kn-next", "loadtest", "my-app"));
        const yaml = readFileSync(manifestPath, "utf-8");
        expect(yaml).toContain("kind: Job");

        // Exactly one kubectl apply of that file (no shell).
        expect(execFileSync).toHaveBeenCalledTimes(1);
        const [bin, args] = execFileSync.mock.calls[0];
        expect(bin).toBe("kubectl");
        // --validate=strict on EVERY apply the CLI issues (see
        // cr-apply-strict-validation.test.ts): a typo'd field in the generated
        // Job must be rejected, not pruned into a Job that runs but measures
        // something other than what the manifest says.
        expect(args).toEqual([
            "apply",
            "--validate=strict",
            "-f",
            manifestPath,
        ]);
    });

    it("wires the in-cluster Prometheus URL only when observability is enabled", async () => {
        const withObs = await runLoadTest(
            "app2",
            "https://app2.example.com",
            "smoke",
            "prod",
            true,
        );
        const yaml = readFileSync(withObs, "utf-8");
        expect(yaml).toContain(
            "prometheus-operated.prod.svc.cluster.local:9090",
        );

        const withoutObs = await runLoadTest(
            "app3",
            "https://app3.example.com",
            "smoke",
            "prod",
            false,
        );
        expect(readFileSync(withoutObs, "utf-8")).not.toContain(
            "prometheus-operated",
        );
    });
});
