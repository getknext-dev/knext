/**
 * Module-level pin for `doctor`'s -h/--help dispatch entry (#1055 follow-up).
 *
 * The golden pin covers `runDoctor`'s OUTPUT, but the CLI `--help` short-circuit
 * is a separate path in `doctorMain` — guarded cluster-wide by the ADR-0046
 * cli-verb-dispatch contract, and previously untested at the module level,
 * which is how the decomposition regressed it without reddening the doctor
 * suite. This pins the behaviour directly: `-h`/`--help` print help and return 0
 * WITHOUT touching kubectl or the registry, and an unknown flag is still a
 * UsageError (parse-first).
 */

import { describe, expect, it } from "bun:test";
import type { KubectlFn, ManifestProbeFn } from "../cli/doctor";
import { doctorMain } from "../cli/doctor";
import { UsageError } from "../cli/shared";

/** A kubectl/probe pair that RECORDS whether the cluster was touched at all. */
function recordingDeps() {
    const kubectlCalls: string[][] = [];
    const probeCalls: string[] = [];
    const kubectl: KubectlFn = (args) => {
        kubectlCalls.push([...args]);
        return { ok: false, stdout: "", stderr: "should not be called" };
    };
    const probeImage: ManifestProbeFn = async (image) => {
        probeCalls.push(image);
        return "ok";
    };
    return { deps: { kubectl, probeImage }, kubectlCalls, probeCalls };
}

describe("doctorMain — -h/--help dispatch entry", () => {
    it("--help returns 0 and never touches the cluster", async () => {
        const { deps, kubectlCalls, probeCalls } = recordingDeps();
        const rc = await doctorMain(["--help"], deps);
        expect(rc).toBe(0);
        expect(kubectlCalls.length).toBe(0);
        expect(probeCalls.length).toBe(0);
    });

    it("-h returns 0 and never touches the cluster", async () => {
        const { deps, kubectlCalls, probeCalls } = recordingDeps();
        const rc = await doctorMain(["-h"], deps);
        expect(rc).toBe(0);
        expect(kubectlCalls.length).toBe(0);
        expect(probeCalls.length).toBe(0);
    });

    it("an unknown flag is a UsageError (parse-first, before any help path)", async () => {
        const { deps } = recordingDeps();
        await expect(doctorMain(["--bogus"], deps)).rejects.toBeInstanceOf(
            UsageError,
        );
    });

    it("a normal run DOES reach the cluster (help path is not always-on)", async () => {
        const { deps, kubectlCalls } = recordingDeps();
        const rc = await doctorMain([], deps);
        // The gate kubectl call happened; unreachable degrades to exit 0.
        expect(kubectlCalls.length).toBeGreaterThan(0);
        expect(rc).toBe(0);
    });
});
